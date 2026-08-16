#!/usr/bin/env node
// Run one fresh Claude Code task with a hard deadline and project-local state.

import fs from "node:fs";
import process from "node:process";
import { spawn } from "node:child_process";

import {
  createJobLogFile,
  generateJobId,
  upsertJob,
  writeJobFile,
} from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  installChildSignalForwarding,
  readProcessStartTime,
  terminateProcessTree,
  waitForExit,
} from "./lib/process.mjs";
import { withClaudeDelegationBoundary } from "./lib/delegation-boundary.mjs";

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_TIMER_MS = 2_147_483_647;
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const PERMISSION_MODES = new Set([
  "default",
  "acceptEdits",
  "auto",
  "manual",
  "dontAsk",
  "plan",
]);
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

let activeJob = null;

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
    timeoutMs: DEFAULT_TIMEOUT_MS,
    promptStdin: false,
    prompt: null,
  };
  const valueFlags = new Map([
    ["--kind", "kind"],
    ["--model", "model"],
    ["--effort", "effort"],
    ["--permission-mode", "permissionMode"],
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
    args.prompt = fs.readFileSync(0, "utf8");
  }
  const timeout = Number(args.timeoutMs);
  if (!Number.isInteger(timeout) || timeout <= 0 || timeout > MAX_TIMER_MS) {
    fail(`--timeout-ms must be an integer from 1 to ${MAX_TIMER_MS}`);
  }
  args.timeoutMs = timeout;
  if (!MODEL_ID.test(args.model)) fail(`invalid model id: ${JSON.stringify(args.model)}`);
  if (!EFFORTS.has(args.effort)) fail(`unsupported Claude effort: ${args.effort}`);
  if (!PERMISSION_MODES.has(args.permissionMode)) {
    fail(`unsupported Claude permission mode: ${args.permissionMode}`);
  }
  if (!args.prompt?.trim()) fail("no prompt provided. Use --prompt-stdin or -- <prompt>");
  return args;
}

function appendLog(file, message) {
  fs.appendFileSync(file, `[${new Date().toISOString()}] ${message}\n`, "utf8");
}

function claudeArgs(args) {
  const result = [
    "-p",
    "--output-format", "text",
    "--no-session-persistence",
    "--disable-slash-commands",
    "--effort", args.effort,
  ];
  if (args.model !== "default") result.push("--model", args.model);
  if (args.permissionMode !== "default") {
    result.push("--permission-mode", args.permissionMode);
  }
  return result;
}

function executeClaude(cwd, args, logFile) {
  return new Promise((resolve) => {
    const argv = claudeArgs(args);
    const prompt = withClaudeDelegationBoundary(args.prompt);
    appendLog(logFile, `Exec: claude ${argv.join(" ")} <prompt-stdin>`);
    appendLog(
      logFile,
      `Model: ${args.model}, Effort: ${args.effort}, Permission: ${args.permissionMode}`,
    );
    appendLog(logFile, `CWD: ${cwd}`);
    appendLog(logFile, `Deadline: ${Math.round(args.timeoutMs / 1000)}s`);

    const child = spawn("claude", argv, {
      cwd,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    const releaseSignals = installChildSignalForwarding(child);
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      releaseSignals();
      resolve(result);
    }

    const deadline = setTimeout(() => {
      timedOut = true;
      appendLog(logFile, "Deadline exceeded — terminating Claude Code");
      try { terminateProcessTree(child.pid, { signal: "SIGTERM" }); } catch {}
      setTimeout(() => {
        if (waitForExit([child.pid], 0).size > 0) {
          try { terminateProcessTree(child.pid, { signal: "SIGKILL" }); } catch {}
        }
      }, 5_000).unref?.();
    }, args.timeoutMs);

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      fs.appendFileSync(logFile, text, "utf8");
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr = (stderr + text).slice(-4_000);
      fs.appendFileSync(logFile, text, "utf8");
    });
    child.on("error", (error) => {
      finish({ status: "failed", rawOutput: stdout.trim(), error: error.message });
    });
    child.on("close", (code, signal) => {
      if (timedOut) {
        finish({
          status: "stalled",
          rawOutput: stdout.trim(),
          error: `Timed out after ${Math.round(args.timeoutMs / 1000)}s`,
        });
      } else if (code !== 0) {
        finish({
          status: "failed",
          rawOutput: stdout.trim(),
          error: stderr.trim() || `Claude Code exited with code ${code}${signal ? ` (${signal})` : ""}`,
        });
      } else {
        appendLog(logFile, "Completed successfully");
        finish({ status: "completed", rawOutput: stdout.trim() });
      }
    });

    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
  });
}

async function main() {
  const args = parseArgs(process.argv);
  const executionCwd = process.cwd();
  const stateRoot = resolveWorkspaceRoot(executionCwd);
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
    completedAt: new Date().toISOString(),
    ...(result.error ? { errorMessage: result.error } : {}),
  });
  writeJobFile(stateRoot, jobId, {
    rawOutput: result.rawOutput,
    ...(result.error ? { error: result.error } : {}),
  });
  activeJob = null;

  process.stdout.write(`${JSON.stringify({ jobId, ...result })}\n`);
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
