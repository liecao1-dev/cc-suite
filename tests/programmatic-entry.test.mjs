import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { cleanupDir, writeExecutable } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const PROXY = path.join(ROOT, "scripts", "composer-proxy.py");
const BROKER = path.join(ROOT, "scripts", "dispatch-broker.mjs");

async function waitFor(check, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for broker");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await exited;
}

function writeFakeClaude(file) {
  writeExecutable(file, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
  process.stdout.write("Usage: claude [options]\\n  --model <model> Alias 'opus' or 'sonnet'\\n  --effort <level> (choices: low, medium, high, max)\\n  --permission-mode <mode> (choices: default, dontAsk, plan)\\nCommands:\\n");
} else if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("fixture-claude 1.0.0\\n");
} else {
  let prompt = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { prompt += chunk; });
  process.stdin.on("end", () => {
    if (process.env.CC_SUITE_TEST_TARGET_COUNT) {
      fs.appendFileSync(process.env.CC_SUITE_TEST_TARGET_COUNT, "1\\n");
    }
    fs.writeFileSync(process.env.CC_SUITE_TEST_TARGET_CAPTURE, JSON.stringify({
      target: "claude", cwd: process.cwd(), argv: args, prompt,
    }));
    const sessionId = "12345678-1234-4234-8234-123456789abc";
    process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }) + "\\n");
    process.stdout.write(JSON.stringify({
      type: "result", subtype: "success", is_error: false,
      session_id: sessionId, result: "  CLAUDE RAW\\nline 2\\n\\n",
    }) + "\\n");
  });
}
`);
}

function writeFakeCodex(file) {
  writeExecutable(file, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("codex-cli fixture\\n");
} else if (args.join(" ") === "exec --help") {
  process.stdout.write("Usage: codex exec [OPTIONS] [PROMPT]\\n-m, --model <MODEL>\\n-s, --sandbox <MODE>\\n--skip-git-repo-check\\n--json\\n-c, --config <key=value>\\n-o, --output-last-message <FILE>\\n");
} else if (args.join(" ") === "exec resume --help") {
  process.stdout.write("Usage: codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]\\n-m, --model <MODEL>\\n--skip-git-repo-check\\n--json\\n-c, --config <key=value>\\n-o, --output-last-message <FILE>\\n");
} else {
  let prompt = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { prompt += chunk; });
  process.stdin.on("end", () => {
    if (process.env.CC_SUITE_TEST_TARGET_COUNT) {
      fs.appendFileSync(process.env.CC_SUITE_TEST_TARGET_COUNT, "1\\n");
    }
    const outputIndex = args.indexOf("-o");
    fs.writeFileSync(args[outputIndex + 1], "\\n  CODEX RAW\\nline 2  \\n\\n");
    fs.writeFileSync(process.env.CC_SUITE_TEST_TARGET_CAPTURE, JSON.stringify({
      target: "codex", cwd: process.cwd(), argv: args, prompt,
    }));
    process.stdout.write(JSON.stringify({
      type: "thread.started", thread_id: "87654321-4321-4321-8321-cba987654321",
    }) + "\\n");
  });
}
`);
}

function writeCodexCatalog(home) {
  const directory = path.join(home, ".codex");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "models_cache.json"), JSON.stringify({
    models: [{
      slug: "gpt-5.6-sol",
      display_name: "GPT-5.6 Sol",
      description: "fixture model",
      priority: 1,
      default_reasoning_level: "low",
      supported_reasoning_levels: [{ effort: "low", description: "low" }],
    }],
  }));
}

test("both automatic directions traverse the real unified entry without losing cwd, prompt, or raw output", async () => {
  const fixture = fs.mkdtempSync("/private/tmp/cc-entry-");
  const scope = path.join(fixture, "scope");
  const workspace = path.join(scope, "workspace");
  const child = path.join(workspace, "nested");
  const home = path.join(fixture, "home");
  const bin = path.join(fixture, "bin");
  const fakeClaude = path.join(bin, "claude");
  const fakeCodex = path.join(bin, "codex");
  try {
    fs.mkdirSync(child, { recursive: true });
    fs.mkdirSync(home);
    fs.mkdirSync(bin);
    fs.mkdirSync(path.join(scope, ".cc-suite"), { recursive: true });
    writeFakeClaude(fakeClaude);
    writeFakeCodex(fakeCodex);
    writeCodexCatalog(home);
    fs.writeFileSync(path.join(scope, ".cc-suite", "composer-activation.json"), JSON.stringify({
      schema: 1,
      managedBy: "cc-suite",
      scopeRoot: fs.realpathSync.native(scope),
      binaries: { claude: fakeClaude, codex: fakeCodex },
    }));

    const scenarios = [
      {
        host: "codex",
        target: "claude",
        sessionId: "a".repeat(32),
        prompt: "  完整 Claude 输入\n第二行\n",
        rawOutput: "  CLAUDE RAW\nline 2\n\n",
        cwd: workspace,
        effectiveCwd: workspace,
        argv: ["--print", "--model", "opus", "--effort", "low", "--permission-mode", "plan", "--tools", ""],
      },
      {
        host: "claude",
        target: "codex",
        sessionId: "b".repeat(32),
        prompt: "\n完整 Codex 输入\n第二行  \n",
        rawOutput: "\n  CODEX RAW\nline 2  \n\n",
        cwd: workspace,
        effectiveCwd: child,
        argv: [
          "--profile", "cli-zh", "e",
          "--model", "gpt-5.6-sol", "--sandbox", "workspace-write",
          "-c", "model_reasoning_effort=low", "-c", "approval_policy=never",
          "-C", "nested", "-",
        ],
      },
    ];

    for (const scenario of scenarios) {
      const socketPath = path.join(
        scope, ".cc-suite", "runtime", "brokers", `${scenario.sessionId}.sock`,
      );
      const secret = scenario.host === "codex" ? "c".repeat(64) : "d".repeat(64);
      const capture = path.join(fixture, `${scenario.target}-capture.json`);
      const count = path.join(fixture, `${scenario.target}-count.txt`);
      const requestId = `${scenario.target}-stable-request`;
      let stderr = "";
      const broker = spawn(process.execPath, [
        BROKER,
        "--socket", socketPath,
        "--secret", secret,
        "--scope", scope,
        "--workspace", workspace,
        "--source", ROOT,
        "--parent-pid", String(process.pid),
        "--host", scenario.host,
        "--session-id", scenario.sessionId,
      ], {
        env: {
          ...process.env,
          HOME: home,
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
          CC_SUITE_TEST_TARGET_CAPTURE: capture,
          CC_SUITE_TEST_TARGET_COUNT: count,
        },
        stdio: ["ignore", "ignore", "pipe"],
      });
      broker.stderr.setEncoding("utf8");
      broker.stderr.on("data", (chunk) => { stderr += chunk; });

      try {
        await waitFor(() => fs.existsSync(socketPath) || broker.exitCode !== null);
        assert.equal(broker.exitCode, null, stderr);
        const invoke = () => spawnSync("python3", [
          PROXY,
          "--host", scenario.target,
          "--scope", scope,
          "--source", ROOT,
          "--real-binary", scenario.target === "claude" ? fakeClaude : fakeCodex,
          "--",
          ...scenario.argv,
        ], {
          cwd: scenario.cwd,
          input: scenario.prompt,
          env: {
            ...process.env,
            HOME: home,
            PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
            CC_SUITE_COMPOSER_BYPASS: "",
            CC_SUITE_COMPOSER_HOST: scenario.host,
            CC_SUITE_COMPOSER_SESSION: scenario.sessionId,
            CC_SUITE_SCOPE_ROOT: scope,
            CC_SUITE_WORKSPACE_ROOT: workspace,
            CC_SUITE_DISPATCH_BROKER_SOCKET: socketPath,
            CC_SUITE_DISPATCH_BROKER_SECRET: secret,
            CC_SUITE_REQUEST_ID: requestId,
            CC_SUITE_TEST_TARGET_CAPTURE: capture,
            CC_SUITE_TEST_TARGET_COUNT: count,
          },
          encoding: "utf8",
          timeout: 30_000,
        });
        const completed = invoke();
        assert.equal(completed.status, 0, completed.stderr || stderr);
        assert.equal(completed.stdout, scenario.rawOutput);
        const captured = JSON.parse(fs.readFileSync(capture, "utf8"));
        assert.equal(captured.target, scenario.target);
        assert.equal(captured.cwd, fs.realpathSync.native(scenario.effectiveCwd));
        assert.equal(captured.prompt.endsWith(scenario.prompt), true);
        const replay = invoke();
        assert.equal(replay.status, 0, replay.stderr || stderr);
        assert.equal(replay.stdout, scenario.rawOutput);
        assert.equal(fs.readFileSync(count, "utf8"), "1\n");
      } finally {
        await stopChild(broker);
        await waitFor(() => !fs.existsSync(socketPath));
      }
    }
  } finally {
    cleanupDir(fixture);
  }
});
