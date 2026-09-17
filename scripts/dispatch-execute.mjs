#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateAgainstCatalog } from "./lib/dispatch-config.mjs";
import {
  dispatchBrokerConfig,
  relayDispatchThroughBroker,
} from "./lib/dispatch-broker-client.mjs";
import { getDispatchEnvironment } from "./lib/dispatch-catalog.mjs";
import {
  claimDispatchTicket,
  DISPATCH_TIMEOUT_MS,
  finishProgrammaticDispatch,
  PROGRAMMATIC_CLAIM_STALL_MS,
  recordExactClaudeResponse,
  recordDispatchConversation,
} from "./lib/dispatch-state.mjs";
import { readStdinSync } from "./lib/hook-input.mjs";
import { isWithin } from "./lib/project-dispatch.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MAX_BUFFER = 64 * 1024 * 1024;
const EXECUTOR_TIMEOUT_MS = PROGRAMMATIC_CLAIM_STALL_MS;
let activeTicket = null;
let activeTicketCwd = null;

function finishProgrammatic(output) {
  if (!activeTicket?.programmaticRequestKey) return output;
  try {
    finishProgrammaticDispatch(
      activeTicketCwd ?? process.cwd(),
      activeTicket.programmaticRequestKey,
      output,
    );
    return output;
  } catch (error) {
    return { ...output, requestStateError: error.message };
  }
}

function fail(message, code = 1) {
  const output = finishProgrammatic({
    status: "failed",
    error: message,
    ...(activeTicket ? {
      target: activeTicket.target,
      config: activeTicket.config,
      selectedProfile: activeTicket.selectedProfile,
      delivery: activeTicket.delivery,
      toolPolicy: activeTicket.toolPolicy,
    } : {}),
  });
  process.stdout.write(`${JSON.stringify(output)}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const args = { ticket: null, promptStdin: false };
  for (let index = 0; index < argv.length;) {
    const key = argv[index++];
    if (key === "--prompt-stdin") {
      args.promptStdin = true;
      continue;
    }
    if (key !== "--ticket" || index >= argv.length) fail(`unexpected argument: ${key}`, 2);
    args.ticket = argv[index++];
  }
  if (!args.ticket || !args.promptStdin) {
    fail("usage: dispatch-execute.mjs --ticket <token> --prompt-stdin", 2);
  }
  return args;
}

function runnerArgs(ticket) {
  const result = [
    path.join(ROOT, "scripts", `${ticket.target}-runner.mjs`),
    "--kind", `${ticket.target}-dispatch`,
    "--model", ticket.config.model,
    "--effort", ticket.config.effort,
  ];
  if (ticket.target === "codex") {
    result.push(
      "--sandbox", ticket.config.access,
      "--approval", ticket.config.approval,
    );
  } else {
    result.push("--permission-mode", ticket.config.access);
    if (ticket.toolPolicy === "none") result.push("--tool-policy", "none");
  }
  // Codex persists exec sessions across runner processes. Claude's current
  // print/Agent SDK path only keeps its native resume session inside one MCP
  // server lifetime, so Claude continuity is replayed explicitly below.
  if (ticket.target === "codex" && ticket.resumeThreadId) {
    result.push("--resume", ticket.resumeThreadId);
  }
  result.push(
    "--timeout-ms", String(DISPATCH_TIMEOUT_MS),
    "--record-recent",
    "--prompt-stdin",
  );
  return result;
}

function taskForRunner(ticket, task) {
  if (ticket.target !== "claude" || !ticket.conversationTurns?.length) return task;
  const prior = ticket.conversationTurns.flatMap((turn, index) => [
    `--- delegated turn ${index + 1} ---`,
    "User:",
    turn.prompt,
    "Claude:",
    turn.output,
  ]).join("\n");
  return [
    "Continue the same delegated Claude conversation using the saved transcript below.",
    "Treat it as prior conversation context, then answer only the current delegated request.",
    "[Prior delegated Claude conversation]",
    prior,
    "[End prior delegated Claude conversation]",
    "[Current delegated request]",
    task,
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (process.stdin.isTTY) {
    fail(
      "dispatch executor requires complete non-TTY stdin; the ticket was not consumed",
      2,
    );
  }
  const task = readStdinSync({ maxWaitMs: 30_000 });
  if (!task.trim()) fail("dispatch task is empty", 2);

  let broker;
  try { broker = dispatchBrokerConfig(); }
  catch (error) { fail(`${error.message}; the ticket was not consumed`); }
  if (broker && process.env.CC_SUITE_DISPATCH_BROKER_BYPASS !== "1") {
    try {
      const response = await relayDispatchThroughBroker({
        ...broker,
        ticket: args.ticket,
        cwd: process.cwd(),
        task,
      });
      if (response.stderr) process.stderr.write(response.stderr);
      if (response.stdout) process.stdout.write(response.stdout);
      process.exitCode = response.exitCode;
    } catch (error) {
      fail(`dispatch broker failed: ${error.message}`);
    }
    return;
  }

  let ticket;
  let executionCwd;
  try {
    ticket = claimDispatchTicket(process.cwd(), args.ticket, Date.now(), task);
    activeTicket = ticket;
    activeTicketCwd = process.cwd();
    executionCwd = fs.realpathSync.native(ticket.selectedCwd);
    if (!isWithin(ticket.projectRoot, executionCwd)) {
      throw new Error("selected working directory is outside the active workspace");
    }
    const environment = getDispatchEnvironment(ticket.target, executionCwd);
    ticket.config = validateAgainstCatalog(ticket.target, ticket.config, environment.catalog);
  } catch (error) {
    fail(error.message);
  }

  const result = spawnSync(process.execPath, runnerArgs(ticket), {
    cwd: executionCwd,
    input: taskForRunner(ticket, task),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: MAX_BUFFER,
    timeout: EXECUTOR_TIMEOUT_MS,
  });
  if (result.error) fail(`could not run ${ticket.target}: ${result.error.message}`);

  let parsed;
  try {
    const line = result.stdout.trim().split("\n").at(-1);
    parsed = JSON.parse(line);
  } catch {
    fail(result.stderr.trim() || `${ticket.target} runner returned invalid output`);
  }

  let contextPersistenceError = null;
  let exactRelayArmed = false;
  if (
    parsed.status === "completed"
    && ticket.host === "codex"
    && ticket.target === "claude"
    && ticket.exactRelay !== false
  ) {
    try {
      recordExactClaudeResponse(executionCwd, {
        host: ticket.host,
        target: ticket.target,
        hostSessionId: ticket.hostSessionId || ticket.sessionId,
        hostTurnId: ticket.hostTurnId,
        jobId: parsed.jobId,
        rawOutput: parsed.rawOutput,
      });
      exactRelayArmed = true;
    } catch (error) {
      parsed = {
        ...parsed,
        status: "failed",
        error: `Claude completed, but the exact-response relay guard could not be armed: ${error.message}`,
      };
    }
  }
  if (parsed.status === "completed" && parsed.threadId) {
    try {
      recordDispatchConversation(executionCwd, {
        host: ticket.host,
        target: ticket.target,
        hostSessionId: ticket.hostSessionId || ticket.sessionId,
        threadId: parsed.threadId,
        config: ticket.config,
        prompt: task,
        rawOutput: parsed.rawOutput,
      });
    } catch (error) {
      contextPersistenceError = error.message;
    }
  }

  const output = finishProgrammatic({
    ...parsed,
    target: ticket.target,
    config: ticket.config,
    selectedProfile: ticket.selectedProfile,
    delivery: ticket.delivery,
    toolPolicy: ticket.toolPolicy,
    contextResumed: ticket.target === "claude"
      ? Boolean(ticket.conversationTurns?.length)
      : Boolean(ticket.resumeThreadId),
    contextMode: ticket.target === "claude" && ticket.conversationTurns?.length
      ? "saved-transcript"
      : ticket.target === "codex" && ticket.resumeThreadId
        ? "native-session"
        : "new",
    contextSaved: Boolean(parsed.threadId) && !contextPersistenceError,
    ...(ticket.host === "codex" && ticket.target === "claude" ? { exactRelayArmed } : {}),
    ...(contextPersistenceError ? { contextPersistenceError } : {}),
  });
  process.stdout.write(`${JSON.stringify(output)}\n`);
  activeTicket = null;
  activeTicketCwd = null;
  if (result.status !== 0 || !["completed"].includes(parsed.status)) process.exitCode = 1;
}

await main();
