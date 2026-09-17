import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  cleanupDir,
  makeTempDir,
  withIsolatedEnv,
  writeExecutable,
} from "./helpers.mjs";
import {
  claimDispatchTicket,
  DISPATCH_TIMEOUT_MS,
  PROGRAMMATIC_CLAIM_STALL_MS,
  prepareProgrammaticDispatch,
  readProgrammaticDispatch,
  recentDispatchRecord,
  savePendingDispatch,
  ticketForSubmittedPrompt,
  TICKET_TTL_MS,
  verifyExactClaudeResponse,
} from "../scripts/lib/dispatch-state.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const EXECUTOR = path.join(ROOT, "scripts", "dispatch-execute.mjs");

test("dispatch deadline is fixed at 60 minutes plus a 30-second terminalization allowance", () => {
  assert.equal(TICKET_TTL_MS, 1_800_000);
  assert.equal(DISPATCH_TIMEOUT_MS, 3_600_000);
  assert.equal(PROGRAMMATIC_CLAIM_STALL_MS, 3_630_000);
  const source = fs.readFileSync(EXECUTOR, "utf8");
  assert.match(source, /DISPATCH_TIMEOUT_MS,/);
  assert.match(source, /"--timeout-ms", String\(DISPATCH_TIMEOUT_MS\)/);
});

function fixture() {
  const root = makeTempDir("cc-suite-dispatch-execute-");
  const child = path.join(root, "packages", "active-app");
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  const capture = path.join(root, "claude-capture.json");
  fs.mkdirSync(child, { recursive: true });
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  writeExecutable(path.join(bin, "claude"), `#!/usr/bin/env node
if (process.argv.includes("--help")) {
  process.stdout.write("Usage: claude [options]\\n\\nOptions:\\n  --effort <level>  Effort (low, medium, high, max)\\n  --model <model>  Alias 'sonnet' or 'opus'\\n  --permission-mode <mode>  Permission (choices: \\\"acceptEdits\\\", \\\"bypassPermissions\\\", \\\"plan\\\")\\n  --version  Print version\\n");
} else if (process.argv.includes("--version")) {
  process.stdout.write("fixture-claude 1.0.0\\n");
} else {
  const fs = require("node:fs");
  let prompt = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { prompt += chunk; });
  process.stdin.on("end", () => {
    const argv = process.argv.slice(2);
    fs.writeFileSync(process.env.CC_SUITE_TEST_CAPTURE, JSON.stringify({
      cwd: process.cwd(),
      argv,
      prompt,
      effort: argv[argv.indexOf("--effort") + 1],
      model: argv[argv.indexOf("--model") + 1],
      permissionMode: argv[argv.indexOf("--permission-mode") + 1],
      settings: JSON.parse(argv[argv.indexOf("--settings") + 1]),
    }));
    const sessionId = "12345678-1234-4234-8234-123456789abc";
    process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }) + "\\n");
    process.stdout.write(JSON.stringify({
      type: "result", subtype: "success", is_error: false,
      session_id: sessionId, result: "FAKE CLAUDE ANSWER",
    }) + "\\n");
  });
}
`);
  fs.mkdirSync(path.join(root, ".cc-suite"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cc-suite", "composer-activation.json"), JSON.stringify({
    schema: 1,
    managedBy: "cc-suite",
    scopeRoot: fs.realpathSync.native(root),
    binaries: { claude: path.join(bin, "claude") },
  }));
  return { root, child, home, bin, capture };
}

test("executor consumes one ticket, preserves the selected subdirectory, and records MRU after spawn", () => {
  withIsolatedEnv({ CLAUDE_PLUGIN_DATA: undefined }, () => {
    const project = fixture();
    process.env.CC_SUITE_SCOPE_ROOT = project.root;
    process.env.CC_SUITE_WORKSPACE_ROOT = project.root;
    try {
      const config = { model: "sonnet", effort: "high", access: "plan" };
      savePendingDispatch(project.child, {
        host: "codex",
        target: "claude",
        sessionId: "executor-session",
        config,
        selectedProfile: "model:sonnet",
      });
      const prepared = ticketForSubmittedPrompt(project.child, {
        host: "codex",
        sessionId: "executor-session",
        prompt: "原始任务内容",
      });
      assert.equal(prepared.status, "ready");

      const env = {
        ...process.env,
        HOME: project.home,
        PATH: `${project.bin}:${process.env.PATH}`,
        CC_SUITE_TEST_CAPTURE: project.capture,
      };
      const first = spawnSync(process.execPath, [
        EXECUTOR,
        "--ticket", prepared.ticket.token,
        "--prompt-stdin",
      ], {
        cwd: project.root,
        env,
        input: "原始任务内容",
        encoding: "utf8",
        timeout: 20_000,
      });
      assert.equal(first.status, 0, first.stderr);
      const output = JSON.parse(first.stdout);
      assert.equal(output.status, "completed");
      assert.equal(output.rawOutput, "FAKE CLAUDE ANSWER");
      assert.deepEqual(output.config, config);
      assert.equal(output.selectedProfile, "model:sonnet");
      assert.equal(output.contextResumed, false);
      assert.equal(output.contextMode, "new");
      assert.equal(output.contextSaved, true);
      assert.equal(output.exactRelayArmed, true);
      assert.match(output.threadId, /^[0-9a-f-]{36}$/);
      assert.equal(verifyExactClaudeResponse(project.child, {
        sessionId: "executor-session",
        lastAssistantMessage: "FAKE CLAUDE ANSWER (rewritten)",
      }).status, "mismatch");
      assert.equal(verifyExactClaudeResponse(project.child, {
        sessionId: "executor-session",
        lastAssistantMessage: "FAKE CLAUDE ANSWER\n回答来自Claude。",
      }).status, "matched");

      const captured = JSON.parse(fs.readFileSync(project.capture, "utf8"));
      assert.equal(captured.cwd, fs.realpathSync(project.child));
      assert.equal(captured.argv[0], "-p");
      assert.equal(captured.argv[captured.argv.indexOf("--output-format") + 1], "stream-json");
      assert.equal(captured.effort, "high");
      assert.equal(captured.model, "sonnet");
      assert.equal(captured.permissionMode, "plan");
      assert.deepEqual(captured.settings.permissions.allow.slice(0, 2), [
        "WebSearch",
        "WebFetch",
      ]);
      assert.ok(captured.settings.permissions.allow.includes("mcp__klode__list_kbs"));
      assert.equal(captured.settings.permissions.allow.includes("mcp__klode__*"), false);
      assert.ok(captured.settings.permissions.allow.includes(
        `Read(//${fs.realpathSync(project.root).replace(/^\/+/, "")}/**)`,
      ));
      assert.equal(captured.settings.permissions.allow.some((rule) => rule.startsWith("Edit(")), false);
      assert.deepEqual(captured.settings.sandbox.filesystem.allowWrite, [
        fs.realpathSync(project.root),
      ]);
      assert.equal(captured.prompt.endsWith("原始任务内容"), true);
      assert.deepEqual(recentDispatchRecord(project.child, "claude")?.config, config);

      const replay = spawnSync(process.execPath, [
        EXECUTOR,
        "--ticket", prepared.ticket.token,
        "--prompt-stdin",
      ], {
        cwd: project.root,
        env,
        input: "不得重放",
        encoding: "utf8",
      });
      assert.notEqual(replay.status, 0);
      assert.match(JSON.parse(replay.stdout).error, /already used|missing/);

      savePendingDispatch(project.child, {
        host: "codex",
        target: "claude",
        sessionId: "executor-session",
        config,
        selectedProfile: "model:sonnet",
      });
      const followUp = ticketForSubmittedPrompt(project.child, {
        host: "codex",
        sessionId: "executor-session",
        prompt: "继续刚才的任务",
      });
      assert.equal(followUp.ticket.resumeThreadId, output.threadId);
      assert.deepEqual(followUp.ticket.conversationTurns, [{
        prompt: "原始任务内容",
        output: "FAKE CLAUDE ANSWER",
      }]);
      const continued = spawnSync(process.execPath, [
        EXECUTOR,
        "--ticket", followUp.ticket.token,
        "--prompt-stdin",
      ], {
        cwd: project.root,
        env,
        input: "[Relevant host conversation context]\n先前任务已完成。\n[Current user request]\n继续刚才的任务",
        encoding: "utf8",
        timeout: 20_000,
      });
      assert.equal(continued.status, 0, continued.stderr);
      const continuedOutput = JSON.parse(continued.stdout);
      assert.equal(continuedOutput.contextResumed, true);
      assert.equal(continuedOutput.contextMode, "saved-transcript");
      assert.equal(continuedOutput.threadId, output.threadId);
      const continuedCapture = JSON.parse(fs.readFileSync(project.capture, "utf8"));
      assert.match(continuedCapture.prompt, /\[Prior delegated Claude conversation\]/);
      assert.match(continuedCapture.prompt, /原始任务内容/);
      assert.match(continuedCapture.prompt, /FAKE CLAUDE ANSWER/);
      assert.equal(continuedCapture.prompt.endsWith("继续刚才的任务"), true);
    } finally {
      cleanupDir(project.root);
    }
  });
});

test("executor rejects TTY stdin before consuming the one-shot ticket", {
  skip: process.platform !== "darwin",
}, () => {
  withIsolatedEnv({ CLAUDE_PLUGIN_DATA: undefined }, () => {
    const project = fixture();
    process.env.CC_SUITE_SCOPE_ROOT = project.root;
    process.env.CC_SUITE_WORKSPACE_ROOT = project.root;
    try {
      const config = { model: "sonnet", effort: "high", access: "plan" };
      savePendingDispatch(project.child, {
        host: "codex",
        target: "claude",
        sessionId: "tty-session",
        config,
      });
      const prepared = ticketForSubmittedPrompt(project.child, {
        host: "codex",
        sessionId: "tty-session",
        prompt: "不得通过 TTY 分段输入",
      });
      assert.equal(prepared.status, "ready");

      const ptyRunner = [
        "import os, pty, sys",
        "def no_stdin(fd): return b''",
        "status = pty.spawn(sys.argv[1:], stdin_read=no_stdin)",
        "sys.exit(os.waitstatus_to_exitcode(status))",
      ].join("\n");
      const attempted = spawnSync("python3", [
        "-c", ptyRunner,
        process.execPath,
        EXECUTOR,
        "--ticket", prepared.ticket.token,
        "--prompt-stdin",
      ], {
        cwd: project.root,
        env: {
          ...process.env,
          HOME: project.home,
          PATH: `${project.bin}:${process.env.PATH}`,
        },
        encoding: "utf8",
        timeout: 5_000,
      });
      assert.match(attempted.stdout, /requires complete non-TTY stdin/);
      assert.match(attempted.stdout, /ticket was not consumed/);

      const stillAvailable = claimDispatchTicket(project.child, prepared.ticket.token);
      assert.deepEqual(stillAvailable.config, config);
    } finally {
      cleanupDir(project.root);
    }
  });
});

test("executor terminalizes a programmatic workflow request without arming the host Stop relay", () => {
  withIsolatedEnv({ CLAUDE_PLUGIN_DATA: undefined }, () => {
    const project = fixture();
    process.env.CC_SUITE_SCOPE_ROOT = project.root;
    process.env.CC_SUITE_WORKSPACE_ROOT = project.root;
    try {
      const config = { model: "sonnet", effort: "high", access: "plan" };
      const prepared = prepareProgrammaticDispatch(project.child, {
        host: "codex",
        target: "claude",
        sessionId: "d".repeat(32),
        requestId: "executor-programmatic-1",
        conversationId: "workflow-conversation",
        delivery: "workflow",
        toolPolicy: "none",
        config,
        prompt: "程序化任务",
      });

      const result = spawnSync(process.execPath, [
        EXECUTOR,
        "--ticket", prepared.ticket.token,
        "--prompt-stdin",
      ], {
        cwd: project.root,
        env: {
          ...process.env,
          PATH: `${project.bin}:${process.env.PATH}`,
          CC_SUITE_TEST_CAPTURE: project.capture,
          CC_SUITE_DISPATCH_BROKER_BYPASS: "1",
        },
        input: "程序化任务",
        encoding: "utf8",
        timeout: 20_000,
      });
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(output.status, "completed");
      assert.equal(output.delivery, "workflow");
      assert.equal(output.toolPolicy, "none");
      assert.equal(output.exactRelayArmed, false);
      const captured = JSON.parse(fs.readFileSync(project.capture, "utf8"));
      const toolsIndex = captured.argv.indexOf("--tools");
      assert.notEqual(toolsIndex, -1);
      assert.equal(captured.argv[toolsIndex + 1], "");

      const request = readProgrammaticDispatch(project.child, prepared.requestKey);
      assert.equal(request.status, "completed");
      assert.equal(request.terminal.jobId, output.jobId);
      assert.equal(request.terminal.delivery, "workflow");
      assert.equal(Object.hasOwn(request.terminal, "rawOutput"), false);
      assert.equal(verifyExactClaudeResponse(project.child, {
        sessionId: "workflow-conversation",
        lastAssistantMessage: "FAKE CLAUDE ANSWER\n回答来自Claude。",
      }).status, "none");
    } finally {
      cleanupDir(project.root);
    }
  });
});
