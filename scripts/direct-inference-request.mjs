#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  dispatchBrokerConfig,
  relayProgrammaticRequestThroughBroker,
} from "./lib/dispatch-broker-client.mjs";
import { getDispatchEnvironment } from "./lib/dispatch-catalog.mjs";
import { readStdinSync } from "./lib/hook-input.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_CODEX_PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TARGETS = new Set(["claude", "codex"]);

function oneValue(tokens, index, option, inlineValue) {
  if (inlineValue !== null) return { value: inlineValue, next: index + 1 };
  if (index + 1 >= tokens.length) throw new Error(`${option} requires a value`);
  return { value: tokens[index + 1], next: index + 2 };
}

function setOnce(result, field, value, option) {
  if (Object.hasOwn(result, field)) throw new Error(`${option} may be specified only once`);
  result[field] = value;
}

function splitOption(token) {
  if (!token.startsWith("--")) return { option: token, inlineValue: null };
  const equals = token.indexOf("=");
  if (equals === -1) return { option: token, inlineValue: null };
  return { option: token.slice(0, equals), inlineValue: token.slice(equals + 1) };
}

function parseControlArgs(argv) {
  const delimiter = argv.indexOf("--");
  if (delimiter === -1) {
    throw new Error("usage: direct-inference-request.mjs --target <claude|codex> --request-id <id> -- <target CLI arguments>");
  }
  const control = {};
  for (let index = 0; index < delimiter;) {
    const option = argv[index++];
    if (!["--target", "--request-id"].includes(option) || index >= delimiter) {
      throw new Error("invalid direct inference control arguments");
    }
    setOnce(control, option.slice(2).replace("-", "_"), argv[index++], option);
  }
  if (!TARGETS.has(control.target)) throw new Error("invalid --target");
  if (!SAFE_ID.test(control.request_id ?? "")) throw new Error("invalid --request-id");
  const targetArgv = argv.slice(delimiter + 1);
  if (!targetArgv.length) throw new Error("target CLI arguments are required");
  return { ...control, targetArgv };
}

function choosePrompt(positionals, stdin, { codex = false } = {}) {
  if (positionals.length > 1) throw new Error("exactly one positional prompt is allowed");
  const stdinSentinel = codex && positionals[0] === "-";
  if (positionals.length === 1 && !stdinSentinel) {
    if (stdin.length !== 0) throw new Error("prompt must come from either stdin or one positional argument, not both");
    if (!positionals[0].trim()) throw new Error("direct inference prompt is empty");
    return positionals[0];
  }
  if (!stdin.trim()) throw new Error("direct inference requires a complete stdin prompt or one positional prompt");
  return stdin;
}

function parseClaudeArgv(tokens, stdin) {
  const parsed = { positionals: [] };
  let options = true;
  for (let index = 0; index < tokens.length;) {
    const token = tokens[index];
    if (options && token === "--") {
      options = false;
      index += 1;
      continue;
    }
    const { option, inlineValue } = splitOption(token);
    if (options && ["-p", "--print"].includes(option)) {
      if (inlineValue !== null) throw new Error("--print does not accept an inline value");
      setOnce(parsed, "print", true, option);
      index += 1;
      continue;
    }
    if (options && ["--safe-mode", "--no-session-persistence"].includes(option)) {
      if (inlineValue !== null) throw new Error(`${option} does not accept a value`);
      setOnce(parsed, option === "--safe-mode" ? "safeMode" : "noSessionPersistence", true, option);
      index += 1;
      continue;
    }
    const fields = {
      "--model": "model",
      "--effort": "effort",
      "--permission-mode": "access",
      "--tools": "tools",
      "--output-format": "outputFormat",
    };
    if (options && fields[option]) {
      const taken = oneValue(tokens, index, option, inlineValue);
      setOnce(parsed, fields[option], taken.value, option);
      index = taken.next;
      continue;
    }
    if (options && token.startsWith("-")) throw new Error("unsupported Claude inference option");
    parsed.positionals.push(token);
    index += 1;
  }
  if (!parsed.print) throw new Error("Claude compatibility requests require -p or --print");
  if (parsed.safeMode) {
    throw new Error("Claude --safe-mode has no exact cc-suite equivalent and is not supported");
  }
  if (parsed.outputFormat !== undefined && parsed.outputFormat !== "text") {
    throw new Error("Claude compatibility requests support only --output-format text; json and stream-json are not supported");
  }
  if (parsed.tools !== undefined && parsed.tools !== "") {
    throw new Error("Claude compatibility requests support only an empty --tools value");
  }
  if (parsed.access === "bypassPermissions") {
    throw new Error("Claude bypassPermissions is not allowed for compatibility requests");
  }
  return {
    overrides: parsed,
    prompt: choosePrompt(parsed.positionals, stdin),
    toolPolicy: parsed.tools === "" ? "none" : "standard",
    noSessionPersistence: Boolean(parsed.noSessionPersistence),
  };
}

function parseConfigValue(value) {
  const equals = value.indexOf("=");
  if (equals <= 0) throw new Error("Codex -c accepts only key=value");
  const key = value.slice(0, equals).trim();
  let parsed = value.slice(equals + 1).trim();
  if (parsed.startsWith('"')) {
    try { parsed = JSON.parse(parsed); } catch { throw new Error(`Codex -c ${key} has an invalid quoted value`); }
  } else if (parsed.startsWith("'") && parsed.endsWith("'")) {
    parsed = parsed.slice(1, -1);
  }
  if (typeof parsed !== "string" || !parsed) throw new Error(`Codex -c ${key} requires a value`);
  if (key === "model_reasoning_effort") return { field: "effort", value: parsed };
  if (key === "approval_policy") return { field: "approval", value: parsed };
  throw new Error("Codex compatibility requests allow only model_reasoning_effort and approval_policy via -c");
}

function normalizeCodexInferenceArgv(tokens) {
  let index = 0;
  let profileSeen = false;
  while (index < tokens.length) {
    const token = tokens[index];
    if (["exec", "e"].includes(token)) {
      return ["exec", ...tokens.slice(index + 1)];
    }
    const { option, inlineValue } = splitOption(token);
    if (option === "--profile") {
      if (profileSeen) throw new Error("Codex --profile may be specified only once");
      const taken = oneValue(tokens, index, option, inlineValue);
      if (!SAFE_CODEX_PROFILE.test(taken.value)) {
        throw new Error("Codex --profile requires a safe profile name");
      }
      profileSeen = true;
      index = taken.next;
      continue;
    }
    throw new Error("Codex compatibility requests require the exec subcommand after optional --profile");
  }
  throw new Error("Codex compatibility requests require the exec subcommand");
}

function parseCodexArgv(tokens, stdin, launchCwd) {
  tokens = normalizeCodexInferenceArgv(tokens);
  const parsed = { positionals: [] };
  let options = true;
  for (let index = 1; index < tokens.length;) {
    const token = tokens[index];
    if (options && token === "--") {
      options = false;
      index += 1;
      continue;
    }
    const { option, inlineValue } = splitOption(token);
    const fields = {
      "-m": "model",
      "--model": "model",
      "-s": "access",
      "--sandbox": "access",
      "-C": "cwd",
      "--cd": "cwd",
      "--color": "color",
    };
    if (options && fields[option]) {
      const taken = oneValue(tokens, index, option, inlineValue);
      setOnce(parsed, fields[option], taken.value, option);
      index = taken.next;
      continue;
    }
    if (options && ["-c", "--config"].includes(option)) {
      const taken = oneValue(tokens, index, option, inlineValue);
      const config = parseConfigValue(taken.value);
      setOnce(parsed, config.field, config.value, `${option} ${config.field}`);
      index = taken.next;
      continue;
    }
    if (options && option === "--skip-git-repo-check") {
      if (inlineValue !== null) throw new Error("--skip-git-repo-check does not accept a value");
      setOnce(parsed, "skipGitRepoCheck", true, option);
      index += 1;
      continue;
    }
    if (options && token.startsWith("-")) {
      if (token === "-") {
        parsed.positionals.push(token);
        index += 1;
        continue;
      }
      throw new Error("unsupported or dangerous Codex inference option");
    }
    parsed.positionals.push(token);
    index += 1;
  }
  if (parsed.color !== undefined && parsed.color !== "never") {
    throw new Error("Codex compatibility requests support only ordinary non-colored output");
  }
  const requestedCwd = parsed.cwd === undefined
    ? launchCwd
    : path.resolve(launchCwd, parsed.cwd);
  let cwd;
  try { cwd = fs.realpathSync.native(requestedCwd); }
  catch (error) { throw new Error(`Codex working directory is not readable: ${error.message}`); }
  return {
    overrides: parsed,
    prompt: choosePrompt(parsed.positionals, stdin, { codex: true }),
    toolPolicy: "standard",
    cwd,
    noSessionPersistence: false,
  };
}

export function buildDirectInferenceRequest({
  argv,
  cwd = process.cwd(),
  stdin = "",
  environmentFor = getDispatchEnvironment,
} = {}) {
  const control = parseControlArgs(argv ?? []);
  const target = control.target;
  const launchCwd = fs.realpathSync.native(path.resolve(cwd));
  const parsed = target === "claude"
    ? { ...parseClaudeArgv(control.targetArgv, stdin), cwd: launchCwd }
    : parseCodexArgv(control.targetArgv, stdin, launchCwd);
  const defaults = environmentFor(target, parsed.cwd).defaultConfig;
  const config = {
    model: parsed.overrides.model ?? defaults.model,
    effort: parsed.overrides.effort ?? defaults.effort,
    access: parsed.overrides.access ?? defaults.access,
    ...(target === "codex" ? {
      approval: parsed.overrides.approval ?? defaults.approval,
    } : {}),
  };
  if (target === "codex" && config.access === "danger-full-access") {
    throw new Error("Codex danger-full-access is not allowed for compatibility requests");
  }
  const requestArgv = [
    "--request-id", control.request_id,
    ...(parsed.noSessionPersistence ? ["--conversation-id", control.request_id] : []),
    "--model", config.model,
    "--effort", config.effort,
    "--access", config.access,
    ...(target === "codex" ? ["--approval", config.approval] : []),
    "--tool-policy", parsed.toolPolicy,
    "--delivery", "workflow",
    "--prompt-stdin",
  ];
  return { target, requestArgv, prompt: parsed.prompt, cwd: parsed.cwd, config };
}

export async function runDirectInferenceRequest({
  argv = process.argv.slice(2),
  env = process.env,
  cwd = process.cwd(),
  stdin = null,
  environmentFor = getDispatchEnvironment,
  brokerConfigFor = dispatchBrokerConfig,
  invoke = relayProgrammaticRequestThroughBroker,
} = {}) {
  const input = stdin === null
    ? (process.stdin.isTTY ? "" : readStdinSync({ maxWaitMs: 30_000 }))
    : stdin;
  const request = buildDirectInferenceRequest({ argv, cwd, stdin: input, environmentFor });
  const broker = brokerConfigFor(env);
  if (!broker || env.CC_SUITE_DISPATCH_BROKER_BYPASS === "1") {
    throw new Error("direct inference requires the active composer broker");
  }
  const response = await invoke({
    ...broker,
    target: request.target,
    requestArgv: request.requestArgv,
    cwd: request.cwd,
    prompt: request.prompt,
  });
  if (response.stderr) process.stderr.write(response.stderr);
  if (response.stdout) process.stdout.write(response.stdout);
  return response.exitCode;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const exitCode = await runDirectInferenceRequest();
    if (exitCode !== 0) process.exitCode = exitCode;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ status: "failed", error: error.message })}\n`);
    process.exitCode = 1;
  }
}
