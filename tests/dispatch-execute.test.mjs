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
  recentDispatchRecord,
  savePendingDispatch,
  ticketForSubmittedPrompt,
} from "../scripts/lib/dispatch-state.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const EXECUTOR = path.join(ROOT, "scripts", "dispatch-execute.mjs");

function fixture() {
  const root = makeTempDir("cc-suite-dispatch-execute-");
  const child = path.join(root, "packages", "active-app");
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  const capture = path.join(root, "claude-capture.json");
  fs.mkdirSync(path.join(root, ".cc-suite"), { recursive: true });
  fs.mkdirSync(child, { recursive: true });
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(root, ".cc-suite", "project.json"), `${JSON.stringify({
    schema: 1,
    managedBy: "cc-suite",
    sourceRoot: ROOT,
    scopeRoot: root,
  }, null, 2)}\n`);
  writeExecutable(path.join(bin, "claude"), `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--help")) {
  process.stdout.write("Usage: claude [options]\\n\\nOptions:\\n  --effort <level>  Effort (low, medium, high, max)\\n  --model <model>  Alias 'sonnet' or 'opus'\\n  --permission-mode <mode>  Permission (choices: \\\"acceptEdits\\\", \\\"bypassPermissions\\\", \\\"plan\\\")\\n  --version  Print version\\n");
} else if (process.argv.includes("--version")) {
  process.stdout.write("fixture-claude 1.0.0\\n");
} else {
  const prompt = fs.readFileSync(0, "utf8");
  fs.writeFileSync(process.env.CC_SUITE_TEST_CAPTURE, JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2), prompt }));
  process.stdout.write("FAKE CLAUDE ANSWER\\n");
}
`);
  return { root, child, home, bin, capture };
}

test("executor consumes one ticket, preserves the selected subdirectory, and records MRU after spawn", () => {
  withIsolatedEnv({ CLAUDE_PLUGIN_DATA: undefined }, () => {
    const project = fixture();
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

      const captured = JSON.parse(fs.readFileSync(project.capture, "utf8"));
      assert.equal(captured.cwd, fs.realpathSync(project.child));
      assert.deepEqual(captured.argv.slice(0, 7), [
        "-p", "--output-format", "text", "--no-session-persistence",
        "--disable-slash-commands", "--effort", "high",
      ]);
      assert.ok(captured.argv.includes("sonnet"));
      assert.ok(captured.argv.includes("plan"));
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
    } finally {
      cleanupDir(project.root);
    }
  });
});
