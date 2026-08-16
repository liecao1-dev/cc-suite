#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateAgainstCatalog } from "./lib/dispatch-config.mjs";
import { getDispatchEnvironment } from "./lib/dispatch-catalog.mjs";
import { claimDispatchTicket } from "./lib/dispatch-state.mjs";
import { isWithin } from "./lib/project-dispatch.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MAX_BUFFER = 64 * 1024 * 1024;

function fail(message, code = 1) {
  process.stdout.write(`${JSON.stringify({ status: "failed", error: message })}\n`);
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
  const common = [
    "--kind", `${ticket.target}-dispatch`,
    "--model", ticket.config.model,
    "--effort", ticket.config.effort,
    "--timeout-ms", "900000",
    "--record-recent",
    "--prompt-stdin",
  ];
  if (ticket.target === "codex") {
    return [
      path.join(ROOT, "scripts", "codex-runner.mjs"),
      ...common.slice(0, 6),
      "--sandbox", ticket.config.access,
      "--approval", ticket.config.approval,
      ...common.slice(6),
    ];
  }
  return [
    path.join(ROOT, "scripts", "claude-runner.mjs"),
    ...common.slice(0, 6),
    "--permission-mode", ticket.config.access,
    ...common.slice(6),
  ];
}

const args = parseArgs(process.argv.slice(2));
const task = fs.readFileSync(0, "utf8");
if (!task.trim()) fail("dispatch task is empty", 2);

let ticket;
let executionCwd;
try {
  ticket = claimDispatchTicket(process.cwd(), args.ticket);
  executionCwd = fs.realpathSync.native(ticket.selectedCwd);
  if (!isWithin(ticket.projectRoot, executionCwd)) {
    throw new Error("selected working directory is outside the managed project");
  }
  const environment = getDispatchEnvironment(ticket.target, executionCwd);
  ticket.config = validateAgainstCatalog(ticket.target, ticket.config, environment.catalog);
} catch (error) {
  fail(error.message);
}

const result = spawnSync(process.execPath, runnerArgs(ticket), {
  cwd: executionCwd,
  input: task,
  encoding: "utf8",
  stdio: ["pipe", "pipe", "pipe"],
  maxBuffer: MAX_BUFFER,
  timeout: 930_000,
});
if (result.error) fail(`could not run ${ticket.target}: ${result.error.message}`);

let parsed;
try {
  const line = result.stdout.trim().split("\n").at(-1);
  parsed = JSON.parse(line);
} catch {
  fail(result.stderr.trim() || `${ticket.target} runner returned invalid output`);
}

process.stdout.write(`${JSON.stringify({
  ...parsed,
  target: ticket.target,
  config: ticket.config,
  selectedProfile: ticket.selectedProfile,
})}\n`);
if (result.status !== 0 || !["completed"].includes(parsed.status)) process.exitCode = 1;
