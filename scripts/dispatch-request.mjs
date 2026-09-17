#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateAgainstCatalog } from "./lib/dispatch-config.mjs";
import {
  authorizeProgrammaticBrokerLaunch,
  dispatchBrokerConfig,
  relayDispatchThroughBroker,
} from "./lib/dispatch-broker-client.mjs";
import { getDispatchEnvironment } from "./lib/dispatch-catalog.mjs";
import {
  prepareProgrammaticDispatch,
  readProgrammaticDispatch,
} from "./lib/dispatch-state.mjs";
import { readStdinSync } from "./lib/hook-input.mjs";
import { resolveScopedWorkspace } from "./lib/scoped-dispatch.mjs";
import { readJobFile, resolveJobFile } from "./lib/state.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const COMPOSER_SESSION = /^[a-f0-9]{32}$/i;

function parseArgs(argv) {
  const args = { promptStdin: false };
  const allowed = new Set([
    "--request-id",
    "--conversation-id",
    "--model",
    "--effort",
    "--access",
    "--approval",
    "--delivery",
    "--tool-policy",
  ]);
  for (let index = 0; index < argv.length;) {
    const key = argv[index++];
    if (key === "--prompt-stdin") {
      if (args.promptStdin) throw new Error("--prompt-stdin may be specified only once");
      args.promptStdin = true;
      continue;
    }
    if (!allowed.has(key) || index >= argv.length) {
      throw new Error(`unexpected argument: ${key}`);
    }
    const field = key.slice(2).replaceAll("-", "_");
    if (args[field] !== undefined) throw new Error(`${key} may be specified only once`);
    args[field] = argv[index++];
  }
  if (!args.promptStdin) {
    throw new Error(
      "usage: dispatch-request.mjs --request-id <id> [--conversation-id <id>] --model <id> --effort <level> --access <mode> [--approval <policy>] [--delivery <workflow|host-relay>] [--tool-policy <standard|none>] --prompt-stdin",
    );
  }
  if (!SAFE_ID.test(args.request_id ?? "")) throw new Error("invalid --request-id");
  if (args.conversation_id !== undefined && !SAFE_ID.test(args.conversation_id)) {
    throw new Error("invalid --conversation-id");
  }
  args.delivery ??= "workflow";
  args.tool_policy ??= "standard";
  if (!["workflow", "host-relay"].includes(args.delivery)) {
    throw new Error("--delivery must be workflow or host-relay");
  }
  if (!["standard", "none"].includes(args.tool_policy)) {
    throw new Error("--tool-policy must be standard or none");
  }
  if (args.delivery === "host-relay" && args.conversation_id === undefined) {
    throw new Error("--delivery host-relay requires an explicit --conversation-id");
  }
  for (const field of ["model", "effort", "access"]) {
    if (typeof args[field] !== "string" || !args[field]) throw new Error(`--${field} is required`);
  }
  return args;
}

function composerIdentity(env) {
  const host = env.CC_SUITE_COMPOSER_HOST;
  const sessionId = env.CC_SUITE_COMPOSER_SESSION;
  if (!/^(codex|claude)$/.test(host ?? "")) {
    throw new Error("programmatic dispatch requires an active cc-suite composer host");
  }
  if (!COMPOSER_SESSION.test(sessionId ?? "")) {
    throw new Error("programmatic dispatch requires an active cc-suite composer session");
  }
  return {
    host,
    target: host === "codex" ? "claude" : "codex",
    sessionId,
  };
}

function terminalReplay(requestId, request) {
  const output = {
    ...(request.terminal ?? { status: request.status }),
    requestId,
    idempotentReplay: true,
    atMostOnce: true,
  };
  const jobId = request.terminal?.jobId;
  if (typeof jobId === "string") {
    let rawOutputAvailable = false;
    try {
      const artifact = readJobFile(resolveJobFile(request.projectRoot, jobId));
      if (typeof artifact?.rawOutput === "string") {
        output.rawOutput = artifact.rawOutput;
        rawOutputAvailable = true;
      }
    } catch {}
    if (!rawOutputAvailable) delete output.rawOutput;
  }
  if (output.status === "completed" && typeof output.rawOutput !== "string") {
    output.originalStatus = "completed";
    output.status = "failed";
    output.rawOutputUnavailable = true;
    output.error = "completed dispatch result is unavailable; the request will not be run again";
  }
  return output;
}

function claimedResponse(requestId, request) {
  return {
    status: "in_progress",
    requestId,
    idempotentReplay: true,
    atMostOnce: true,
    ...(typeof request?.claimedAt === "string" ? { claimedAt: request.claimedAt } : {}),
  };
}

function replayExitCode(output) {
  return ["completed", "in_progress"].includes(output?.status) ? 0 : 1;
}

function currentRequestResponse(cwd, requestKey, requestId) {
  const request = readProgrammaticDispatch(cwd, requestKey);
  if (!request) return null;
  if (["completed", "failed", "stalled"].includes(request.status)) {
    return terminalReplay(requestId, request);
  }
  if (request.status === "claimed") return claimedResponse(requestId, request);
  return null;
}

function lastJsonObject(text) {
  const lines = String(text).trim().split("\n").reverse();
  for (const line of lines) {
    if (!line.trim()) continue;
    try { return JSON.parse(line); } catch {}
  }
  return null;
}

function assertCodexDangerWasPreauthorized(target, config, effectiveDefault) {
  if (target !== "codex" || config.access !== "danger-full-access") return;
  if (
    effectiveDefault.access !== "danger-full-access"
    || config.approval !== effectiveDefault.approval
  ) {
    throw new Error(
      "Codex danger-full-access is not authorized for programmatic dispatch; configure it as the effective default with the same approval policy first",
    );
  }
}

export async function runProgrammaticRequest({
  argv = process.argv.slice(2),
  env = process.env,
  cwd = process.cwd(),
  stdin = null,
  relay = relayDispatchThroughBroker,
  environmentForTarget = getDispatchEnvironment,
  brokerConfigFor = dispatchBrokerConfig,
  authorizeBrokerLaunch = authorizeProgrammaticBrokerLaunch,
} = {}) {
  const args = parseArgs(argv);
  if (stdin === null && process.stdin.isTTY) {
    throw new Error("programmatic dispatch requires complete non-TTY stdin");
  }

  const broker = brokerConfigFor(env);
  if (!broker || env.CC_SUITE_DISPATCH_BROKER_BYPASS === "1") {
    throw new Error("programmatic dispatch requires the active composer broker");
  }
  if (!broker.programmaticGrant) {
    throw new Error("programmatic dispatch must be launched by the active composer broker");
  }
  await authorizeBrokerLaunch(broker);
  const identity = composerIdentity(env);
  if (args.delivery === "host-relay" && args.conversation_id !== identity.sessionId) {
    throw new Error("--delivery host-relay requires the fixed active composer session id");
  }
  if (identity.target === "claude" && args.approval !== undefined) {
    throw new Error("--approval is valid only when dispatching to Codex");
  }
  if (identity.target === "codex" && args.approval === undefined) {
    throw new Error("--approval is required when dispatching to Codex");
  }
  if (identity.target === "codex" && args.tool_policy !== "standard") {
    throw new Error("--tool-policy none is valid only when dispatching to Claude");
  }

  const task = stdin === null ? readStdinSync({ maxWaitMs: 30_000 }) : stdin;
  if (typeof task !== "string" || !task.trim()) throw new Error("programmatic dispatch task is empty");

  const resolvedCwd = resolveScopedWorkspace(
    fs.realpathSync.native(path.resolve(cwd)),
    env,
  ).selectedCwd;
  const environment = environmentForTarget(identity.target, resolvedCwd);
  const config = validateAgainstCatalog(identity.target, {
    model: args.model,
    effort: args.effort,
    access: args.access,
    ...(identity.target === "codex" ? { approval: args.approval } : {}),
  }, environment.catalog);
  assertCodexDangerWasPreauthorized(identity.target, config, environment.defaultConfig);

  const prepared = prepareProgrammaticDispatch(resolvedCwd, {
    host: identity.host,
    target: identity.target,
    sessionId: identity.sessionId,
    requestId: args.request_id,
    conversationId: args.conversation_id ?? identity.sessionId,
    delivery: args.delivery,
    toolPolicy: args.tool_policy,
    config,
    prompt: task,
  });
  if (prepared.status === "conflict") {
    throw new Error("programmatic request id conflicts with different request content");
  }
  if (prepared.status === "terminal") {
    const output = terminalReplay(args.request_id, prepared.request);
    return { output, exitCode: replayExitCode(output) };
  }
  if (prepared.status === "claimed") {
    return { output: claimedResponse(args.request_id, prepared.request), exitCode: 0 };
  }
  if (prepared.status === "busy") {
    return {
      output: {
        status: "busy",
        requestId: args.request_id,
        reason: prepared.reason,
        atMostOnce: true,
        ...(prepared.activeRequestKey ? { activeRequestKey: prepared.activeRequestKey } : {}),
        ...(prepared.activeStatus ? { activeStatus: prepared.activeStatus } : {}),
        ...(Number.isInteger(prepared.activeCount) ? { activeCount: prepared.activeCount } : {}),
      },
      exitCode: 1,
    };
  }
  if (prepared.status !== "ready") throw new Error("programmatic dispatch could not be prepared");

  let response;
  try {
    response = await relay({
      ...broker,
      ticket: prepared.ticket.token,
      cwd: resolvedCwd,
      task,
    });
  } catch (error) {
    const current = currentRequestResponse(resolvedCwd, prepared.requestKey, args.request_id);
    if (current) return { output: current, exitCode: replayExitCode(current) };
    throw new Error(
      `dispatch broker failed before the request was claimed: ${error.message}; retry only with the same --request-id`,
    );
  }

  const parsed = lastJsonObject(response.stdout);
  if (!parsed) {
    const current = currentRequestResponse(resolvedCwd, prepared.requestKey, args.request_id);
    if (current) return { output: current, stderr: response.stderr, exitCode: replayExitCode(current) };
    throw new Error(response.stderr.trim() || "dispatch executor returned invalid output");
  }
  if (
    response.exitCode !== 0
    && typeof parsed.error === "string"
    && /ticket.*(?:missing|already used)|missing, expired, or already used/i.test(parsed.error)
  ) {
    const current = currentRequestResponse(resolvedCwd, prepared.requestKey, args.request_id);
    if (current) return { output: current, stderr: response.stderr, exitCode: replayExitCode(current) };
  }
  return {
    output: {
      ...parsed,
      requestId: args.request_id,
      idempotentReplay: Boolean(prepared.reused),
      atMostOnce: true,
    },
    stderr: response.stderr,
    exitCode: response.exitCode,
  };
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const result = await runProgrammaticRequest();
    if (result.stderr) process.stderr.write(result.stderr);
    process.stdout.write(`${JSON.stringify(result.output)}\n`);
    if (result.exitCode !== 0 || !["completed", "in_progress"].includes(result.output.status)) {
      process.exitCode = result.exitCode || 1;
    }
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ status: "failed", error: error.message })}\n`);
    process.exitCode = 1;
  }
}
