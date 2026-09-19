#!/usr/bin/env node
import { createCheckpoint } from './lib/localchat-budget.mjs';
import { backendPhase, writeReceipt, stopBackend, interruptBackend } from './lib/localchat-receipts.mjs';
import { localchatUsage } from './lib/localchat-usage.mjs';
// Run or resume one Claude Code task with a hard deadline and project-local state.

import fs from "node:fs";
import os from "node:os";
import process from "node:process";
import { spawn } from "node:child_process";
import path from "node:path";

import {
  createJobLogFile,
  generateJobId,
  upsertJob,
  writeJobFile,
} from "./lib/state.mjs";
import { resolveScopedWorkspace } from "./lib/scoped-dispatch.mjs";
import {
  installChildSignalForwarding,
  readProcessStartTime,
  terminateProcessTree,
  waitForExit,
} from "./lib/process.mjs";
import { withClaudeDelegationBoundary } from "./lib/delegation-boundary.mjs";
import { recordRecentDispatch } from "./lib/dispatch-state.mjs";
import { resolveActivatedCliBinary } from "./lib/activated-cli.mjs";
import { readStdinSync } from "./lib/hook-input.mjs";
import { withoutClaudeEnvironmentAuth } from "./lib/claude-oauth-refresh.mjs";
import { prepareClaudeDocumentTools } from "./lib/claude-document-tools.mjs";
import { readLocalchatPolicy, claudeReadonlySettings, claudeCopySettings, localchatPrompt } from "./lib/localchat-policy.mjs";

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_TIMER_MS = 2_147_483_647;
const KLODE_READ_ONLY_TOOLS = Object.freeze([
  "mcp__klode__list_kbs",
  "mcp__klode__search_sources",
  "mcp__klode__zoom_card",
  "mcp__klode__verify_quote",
  "mcp__klode__list_lenses",
  "mcp__klode__consult_dimension",
  "mcp__klode__consult_framework",
  "mcp__klode__diagnose",
]);
const BASE_ALLOWED_TOOLS = Object.freeze([
  "WebSearch",
  "WebFetch",
  ...KLODE_READ_ONLY_TOOLS,
]);
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const TOOL_POLICIES = new Set(["standard", "none"]);
const PERMISSION_MODES = new Set([
  "default",
  "acceptEdits",
  "auto",
  "manual",
  "dontAsk",
  "plan",
  "bypassPermissions",
]);
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

let activeJob = null;
let localchatPolicy = null;
let cliStarted = false;

function fail(message) {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    kind: "claude-dispatch",
    model: "default",
    effort: "medium",
    permissionMode: "default",
    toolPolicy: "standard",
    resume: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    promptStdin: false,
    recordRecent: false,
    prompt: null,
  };
  const valueFlags = new Map([
    ["--kind", "kind"],
    ["--model", "model"],
    ["--effort", "effort"],
    ["--permission-mode", "permissionMode"],
    ["--tool-policy", "toolPolicy"],
    ["--resume", "resume"],
    ["--timeout-ms", "timeoutMs"],
  ]);

  for (let i = 2; i < argv.length;) {
    const arg = argv[i];
    if (arg === "--") {
      args.prompt = argv.slice(i + 1).join(" ");
      break;
    }
    if (arg === "--prompt-stdin") {
      args.promptStdin = true;
      i += 1;
      continue;
    }
    if (arg === "--record-recent") {
      args.recordRecent = true;
      i += 1;
      continue;
    }
    const field = valueFlags.get(arg);
    if (!field) fail(`unknown option '${arg}'`);
    if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) {
      fail(`${arg} requires a value`);
    }
    args[field] = argv[i + 1];
    i += 2;
  }

  if (args.promptStdin) {
    if (args.prompt !== null) fail("use either --prompt-stdin or -- <prompt>, not both");
    args.prompt = readStdinSync({ maxWaitMs: 30_000 });
  }
  const timeout = Number(args.timeoutMs);
  if (!Number.isInteger(timeout) || timeout <= 0 || timeout > MAX_TIMER_MS) {
    fail(`--timeout-ms must be an integer from 1 to ${MAX_TIMER_MS}`);
  }
  args.timeoutMs = timeout;
  if (!MODEL_ID.test(args.model)) fail(`invalid model id: ${JSON.stringify(args.model)}`);
  if (args.resume !== null && !MODEL_ID.test(args.resume)) {
    fail(`invalid Claude session id: ${JSON.stringify(args.resume)}`);
  }
  if (!EFFORTS.has(args.effort)) fail(`unsupported Claude effort: ${args.effort}`);
  if (!TOOL_POLICIES.has(args.toolPolicy)) {
    fail(`unsupported Claude tool policy: ${args.toolPolicy}`);
  }
  if (!PERMISSION_MODES.has(args.permissionMode)) {
    fail(`unsupported Claude permission mode: ${args.permissionMode}`);
  }
  if (!args.prompt?.trim()) fail("no prompt provided. Use --prompt-stdin or -- <prompt>");
  return args;
}

function appendLog(file, message) {
  fs.appendFileSync(file, `[${new Date().toISOString()}] ${message}\n`, "utf8");
}

function isWithin(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function realDirectory(directory, label) {
  let resolved;
  try {
    resolved = fs.realpathSync.native(path.resolve(directory));
  } catch (error) {
    throw new Error(`${label} is not readable: ${error.message}`);
  }
  if (!fs.statSync(resolved).isDirectory()) throw new Error(`${label} is not a directory: ${resolved}`);
  return resolved;
}

function resolveClaudeAccess(cwd) {
  const scoped = resolveScopedWorkspace(cwd);
  const workspaceRoot = realDirectory(scoped.workspaceRoot, "Claude workspace");
  const executionCwd = realDirectory(cwd, "Claude working directory");
  if (!isWithin(workspaceRoot, executionCwd)) {
    throw new Error(`Claude working directory escapes workspace: ${executionCwd}`);
  }

  const scopeRoot = realDirectory(scoped.scopeRoot, "Claude readable scope");
  if (!isWithin(scopeRoot, workspaceRoot)) {
    throw new Error(`Claude workspace ${workspaceRoot} is outside readable scope ${scopeRoot}`);
  }
  return { executionCwd, activationScopeRoot: scopeRoot, scopeRoot: localchatPolicy ? workspaceRoot : scopeRoot, workspaceRoot };
}

function absolutePermissionRule(tool, target) {
  const absolute = path.resolve(target).split(path.sep).join("/").replace(/^\/+/, "");
  return `${tool}(//${absolute}/**)`;
}

function effectiveClaudePermissionMode(requested) {
  if (localchatPolicy) return requested;
  return requested === "plan" ? "plan" : "dontAsk";
}

function buildClaudeSettings(access, requestedPermissionMode, toolPolicy, documentTools) {
  if (localchatPolicy) return localchatPolicy.mode === "edit" ? claudeCopySettings(access.workspaceRoot) : claudeReadonlySettings(access.workspaceRoot);
  const allow = [
    ...(toolPolicy === "standard" ? BASE_ALLOWED_TOOLS : []),
    absolutePermissionRule("Read", access.scopeRoot),
  ];
  if (requestedPermissionMode !== "plan") {
    allow.push(absolutePermissionRule("Edit", access.workspaceRoot));
    allow.push(...documentTools.allow);
  }
  return {
    permissions: {
      allow,
      disableAutoMode: "disable",
      disableBypassPermissionsMode: "disable",
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        allowWrite: [access.workspaceRoot],
        denyRead: [realDirectory(os.homedir(), "Home directory")],
        allowRead: [access.scopeRoot],
      },
    },
  };
}

function loadKlodeMcpServers() {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude.json"), "utf8"));
    const klode = config?.mcpServers?.klode;
    if (!klode || typeof klode !== "object" || Array.isArray(klode)) return {};
    return { klode };
  } catch {
    return {};
  }
}

function directClaudeArgs(args, access, settings, mcpServers) {
  const effectivePermission = effectiveClaudePermissionMode(args.permissionMode);
  const result = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--disable-slash-commands",
    "--add-dir", access.scopeRoot,
    "--setting-sources", "",
    "--settings", JSON.stringify(settings),
    "--permission-mode", effectivePermission,
    "--effort", args.effort,
  ];
  if (args.toolPolicy === "none") {
    result.push("--tools", "");
  } else if (localchatPolicy) {
    result.push("--tools", localchatPolicy.mode === "edit" ? "Read,Edit,Write" : "Read");
  }
  if (localchatPolicy) result.push("--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}');
  if (mcpServers.klode) {
    result.push("--mcp-config", JSON.stringify({ mcpServers }));
  }
  if (args.model !== "default") result.push("--model", args.model);
  return result;
}

function recordRecentAfterSpawn(cwd, args, logFile) {
  if (!args.recordRecent) return;
  try {
    recordRecentDispatch(cwd, "claude", {
      model: args.model,
      effort: args.effort,
      access: args.permissionMode,
    });
    appendLog(logFile, "Recorded recent Claude configuration after process start");
  } catch (error) {
    appendLog(logFile, `Could not record recent Claude configuration: ${error.message}`);
  }
}

function claudeFailureMessage(terminal, stderr, code, signal) {
  if (Array.isArray(terminal?.errors) && terminal.errors.length) {
    return terminal.errors.map(String).join("; ");
  }
  if (typeof terminal?.error === "string" && terminal.error.trim()) return terminal.error.trim();
  if (typeof terminal?.result === "string" && terminal.result.trim() && terminal?.is_error) {
    return terminal.result.trim();
  }
  if (typeof terminal?.api_error_status === "string" && terminal.api_error_status.trim()) {
    return `Claude API error: ${terminal.api_error_status.trim()}`;
  }
  if (stderr.trim()) return stderr.trim();
  return `Claude Code exited without a successful result (code=${code}${signal ? `, signal=${signal}` : ""})`;
}

function expiredOAuthBeforeExecution(terminal, stderr) {
  if (!terminal || terminal.is_error !== true) return false;
  const message = [
    ...(Array.isArray(terminal.errors) ? terminal.errors : []),
    terminal.error,
    terminal.result,
    terminal.api_error_status,
    stderr,
  ].filter((value) => value !== undefined && value !== null).map(String).join(" ");
  if (!/401/i.test(message) || !/oauth[^\n]*expired|failed to authenticate/i.test(message)) {
    return false;
  }
  const usage = terminal.usage;
  const zeroUsage = usage && [
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
  ].every((key) => typeof usage[key] === "number" && usage[key] === 0);
  const zeroCost = typeof terminal.total_cost_usd === "number" && terminal.total_cost_usd === 0;
  const noModelUsage = terminal.modelUsage
    && typeof terminal.modelUsage === "object"
    && !Array.isArray(terminal.modelUsage)
    && Object.keys(terminal.modelUsage).length === 0;
  return Boolean(zeroUsage && zeroCost && noModelUsage);
}

function executeClaudeDirectAttempt(cwd, args, logFile, attemptNumber) {
  return new Promise((resolve) => {
    if (args.resume) {
      resolve({
        status: "failed",
        threadId: args.resume,
        rawOutput: "",
        error: "Claude dispatch continuation must be supplied through the saved project transcript",
      });
      return;
    }
    const access = resolveClaudeAccess(cwd);
    const effectivePermission = effectiveClaudePermissionMode(args.permissionMode);
    const childEnv = withoutClaudeEnvironmentAuth(process.env);
    const documentTools = !localchatPolicy && args.toolPolicy === "standard" && effectivePermission !== "plan"
      ? prepareClaudeDocumentTools(access, { env: childEnv })
      : { allow: [], env: childEnv, instructions: "" };
    const settings = buildClaudeSettings(access, args.permissionMode, args.toolPolicy, documentTools);
    const mcpServers = !localchatPolicy && args.toolPolicy === "standard" ? loadKlodeMcpServers() : {};
    const argv = directClaudeArgs(args, access, settings, mcpServers);
    if (localchatPolicy?.receiptBase) argv.push("--include-partial-messages");
    const prompt = localchatPolicy ? localchatPrompt('claude', args.prompt) : withClaudeDelegationBoundary(
      [documentTools.instructions, args.prompt].filter(Boolean).join("\n\n"),
    );
    const claudeBinary = resolveActivatedCliBinary(access.activationScopeRoot, "claude");
    appendLog(logFile, `Claude process attempt: ${attemptNumber}/2`);
    appendLog(logFile, `Exec: ${claudeBinary} ${argv.join(" ")} <prompt-stdin>`);
    appendLog(logFile, `Model: ${args.model}, Effort: ${args.effort}, Permission: ${args.permissionMode} (effective ${effectivePermission}), Tools: ${args.toolPolicy}, Current host CLI with project-local transcript continuity`);
    appendLog(logFile, `CWD: ${access.executionCwd}`);
    appendLog(logFile, `Access: read ${access.scopeRoot}; write ${localchatPolicy?.mode === "read-only" ? "none" : access.workspaceRoot}`);
    appendLog(logFile, `Klode MCP: ${mcpServers.klode ? "forwarded from user registration" : "not registered"}`);
    appendLog(logFile, `Deadline: ${Math.round(args.timeoutMs / 1000)}s`);
    const checkpoint = localchatPolicy?.receiptBase ? createCheckpoint({ base: localchatPolicy.receiptBase,
      backend: localchatPolicy.target, timeoutMs: args.timeoutMs,
      interrupt: () => interruptBackend(localchatPolicy.receiptBase) }) : null;
    backendPhase(localchatPolicy, 'spawning');
    const child = spawn(claudeBinary, argv, {
      cwd: access.executionCwd,
      env: documentTools.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    child.once("spawn", () => { backendPhase(localchatPolicy, 'running', child.pid); checkpoint?.start(); cliStarted = true; recordRecentAfterSpawn(cwd, args, logFile); });
    const releaseSignals = installChildSignalForwarding(child);
    let stdoutBuffer = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let sessionId = null;
    let terminal = null;
    let nativeModel = null;
    const permissionDenials = [];

    function consumeLine(line) {
      if (!line.trim()) return;
      let event;
      try { event = JSON.parse(line); } catch { return; }
      checkpoint?.consume(event);
      if (typeof event?.session_id === "string" && event.session_id) sessionId = event.session_id;
      if (event?.type === "system" && event.subtype === "init" && typeof event.model === "string") nativeModel = event.model;
      if (event?.type === "system" && event.subtype === "permission_denied" && permissionDenials.length < 100) permissionDenials.push({ tool: event.tool_name, reason: event.decision_reason_type ?? "permission" });
      if (event?.type === "result") {
        terminal = event;
        for (const denial of Array.isArray(event.permission_denials) ? event.permission_denials : []) {
          if (permissionDenials.length >= 100) break;
          if (typeof denial.tool_name === 'string') permissionDenials.push({ tool: denial.tool_name.slice(0, 128), reason: 'permission' });
        }
      }
    }

    function consumeBufferedLines(final = false) {
      let newline;
      while ((newline = stdoutBuffer.indexOf("\n")) !== -1) {
        consumeLine(stdoutBuffer.slice(0, newline));
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
      }
      if (final && stdoutBuffer.trim()) {
        consumeLine(stdoutBuffer);
        stdoutBuffer = "";
      }
    }

    function finish(result) {
      if (settled) return;
      settled = true;
      const partial = checkpoint?.finish(result.rawOutput ?? '', timedOut);
      if (partial) result = { ...result, ...partial };
      clearTimeout(deadline);
      releaseSignals();
      resolve(localchatPolicy ? { ...result, nativeModel, permissionDenials, usage: localchatUsage('claude', terminal) } : result);
    }
    let deadline;
    child.once("spawn", () => { deadline = setTimeout(() => {
      timedOut = true;
      if (localchatPolicy?.receiptBase) { stopBackend(localchatPolicy.receiptBase); return; }
      try { terminateProcessTree(child.pid, { signal: "SIGTERM" }); } catch {}
      setTimeout(() => {
        if (waitForExit([child.pid], 0).size > 0) {
          try { terminateProcessTree(child.pid, { signal: "SIGKILL" }); } catch {}
        }
      }, 5_000).unref?.();
    }, checkpoint?.remainingMs() ?? args.timeoutMs); });
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdoutBuffer += text;
      consumeBufferedLines();
      fs.appendFileSync(logFile, text, "utf8");
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr = (stderr + text).slice(-4_000);
      fs.appendFileSync(logFile, text, "utf8");
    });
    child.on("error", (error) => finish({ status: "failed", threadId: sessionId, rawOutput: "", error: error.message }));
    child.on("close", (code, signal) => {
      backendPhase(localchatPolicy, 'closed', child.pid);
      consumeBufferedLines(true);
      // The successful result is the user-visible Claude answer. Preserve it
      // exactly; the Codex Stop hook compares this value without normalization.
      const rawOutput = typeof terminal?.result === "string" ? terminal.result : "";
      if (timedOut) {
        finish({ status: "stalled", threadId: sessionId, rawOutput, error: `Timed out after ${Math.round(args.timeoutMs / 1000)}s` });
      } else if (
        code !== 0
        || !terminal
        || terminal.is_error
        || terminal.subtype !== "success"
        || typeof terminal.result !== "string"
      ) {
        finish({
          status: "failed",
          threadId: sessionId,
          rawOutput,
          error: claudeFailureMessage(terminal, stderr, code, signal),
          retryableExpiredOAuth: expiredOAuthBeforeExecution(terminal, stderr),
        });
      } else if (!sessionId) {
        finish({
          status: "failed",
          threadId: null,
          rawOutput,
          error: "Claude Code result omitted session_id; transcript continuity was not armed",
        });
      } else {
        appendLog(logFile, `Session: ${sessionId}`);
        appendLog(logFile, "Completed successfully through the current host Claude CLI");
        finish({ status: "completed", threadId: sessionId, rawOutput });
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
  });
}

async function executeClaudeDirect(cwd, args, logFile) {
  const first = await executeClaudeDirectAttempt(cwd, args, logFile, 1);
  if (!first.retryableExpiredOAuth || first.status === 'partial') {
    delete first.retryableExpiredOAuth;
    return first;
  }
  appendLog(
    logFile,
    "Claude returned an expired OAuth 401 before using any tokens or tools; restarting the same current CLI once",
  );
  const second = await executeClaudeDirectAttempt(cwd, args, logFile, 2);
  if (second.retryableExpiredOAuth) {
    appendLog(logFile, "The one safe OAuth recovery restart also failed; user re-authentication is required");
  }
  delete second.retryableExpiredOAuth;
  return second;
}

function executeClaude(cwd, args, logFile) {
  return executeClaudeDirect(cwd, args, logFile);
}

async function main() {
  const args = parseArgs(process.argv);
  localchatPolicy = readLocalchatPolicy();
  backendPhase(localchatPolicy, 'not_started');
  if (localchatPolicy && (localchatPolicy.target !== "claude" || args.resume || !(localchatPolicy.mode === "edit" ? ["dontAsk"] : ["plan", "dontAsk"]).includes(args.permissionMode))) {
    throw new Error("Localchat requires a fresh Claude call with matching service permissions");
  }
  const executionCwd = process.cwd();
  // The broker fixes one workspace for the whole composer session.  Reusing
  // that root is essential for non-Git projects: recomputing from a nested cwd
  // would put the job artifact under a different state key, so an idempotent
  // replay could no longer recover the completed raw output.
  const { workspaceRoot: stateRoot } = resolveScopedWorkspace(executionCwd);
  const jobId = generateJobId(args.kind);
  const logFile = createJobLogFile(stateRoot, jobId);
  activeJob = { stateRoot, jobId };

  upsertJob(stateRoot, {
    id: jobId,
    kind: args.kind,
    status: "running",
    summary: "claude dispatch",
    pid: process.pid,
    pidStartedAt: readProcessStartTime(process.pid),
    startedAt: new Date().toISOString(),
    deadlineAt: new Date(Date.now() + args.timeoutMs).toISOString(),
    logFile,
  });

  const result = await executeClaude(executionCwd, args, logFile);
  upsertJob(stateRoot, {
    id: jobId,
    status: result.status,
    threadId: result.threadId || null,
    completedAt: new Date().toISOString(),
    ...(result.error ? { errorMessage: result.error } : {}),
  });
  writeJobFile(stateRoot, jobId, {
    rawOutput: result.rawOutput,
    threadId: result.threadId || null,
    ...(result.error ? { error: result.error } : {}),
  });
  activeJob = null;

  writeReceipt(localchatPolicy?.receiptBase, 'result', { jobId, ...result, cliStarted });
  process.stdout.write(`${JSON.stringify({ jobId, ...result, ...(localchatPolicy ? { cliStarted } : {}) })}\n`);
  if (result.status !== "completed") process.exitCode = 1;
}

main().catch((error) => {
  const message = error?.message || String(error);
  if (activeJob) {
    try {
      upsertJob(activeJob.stateRoot, {
        id: activeJob.jobId,
        status: "failed",
        errorMessage: message,
        completedAt: new Date().toISOString(),
      });
    } catch {}
  }
  process.stdout.write(`${JSON.stringify({
    jobId: activeJob?.jobId ?? null,
    status: "failed",
    error: message,
  })}\n`);
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
});
