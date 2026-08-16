import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { cleanupDir, makeTempDir, writeExecutable } from "./helpers.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const RUNNER = path.join(PLUGIN_ROOT, "scripts", "claude-runner.mjs");

test("Claude runner uses stdin, a fresh session, and the user's active subdirectory", () => {
  const project = makeTempDir("claude-runner-");
  try {
    const nested = path.join(project, "packages", "中文 app");
    const bin = path.join(project, "bin");
    fs.mkdirSync(nested, { recursive: true });
    fs.mkdirSync(bin);
    fs.mkdirSync(path.join(project, ".cc-suite"));
    fs.writeFileSync(path.join(project, ".cc-suite", "project.json"), JSON.stringify({ schema: 1, managedBy: "cc-suite" }));
    const promptFile = path.join(project, "prompt.txt");
    const argsFile = path.join(project, "args.txt");
    const cwdFile = path.join(project, "cwd.txt");
    writeExecutable(path.join(bin, "claude"), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" > "$CAPTURE_ARGS"
pwd > "$CAPTURE_CWD"
cat > "$CAPTURE_PROMPT"
printf 'Claude answer\n'
`);
    const task = "literal $(touch never) `whoami`\nsecond line\n";
    const result = spawnSync(process.execPath, [
      RUNNER, "--model", "default", "--effort", "medium",
      "--permission-mode", "default", "--timeout-ms", "5000", "--prompt-stdin",
    ], {
      cwd: nested,
      input: task,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        CAPTURE_ARGS: argsFile,
        CAPTURE_CWD: cwdFile,
        CAPTURE_PROMPT: promptFile,
        CLAUDE_PLUGIN_DATA: path.join(project, ".cc-suite", "runtime"),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "completed");
    assert.equal(output.rawOutput, "Claude answer");
    assert.equal(fs.realpathSync(fs.readFileSync(cwdFile, "utf8").trim()), fs.realpathSync(nested));
    const argv = fs.readFileSync(argsFile, "utf8");
    assert.match(argv, /--no-session-persistence/);
    assert.match(argv, /--disable-slash-commands/);
    assert.doesNotMatch(argv, /--model\ndefault|--permission-mode\ndefault/);
    const prompt = fs.readFileSync(promptFile, "utf8");
    assert.match(prompt, /^This request already reached you by delegation from OpenAI Codex\./);
    assert.ok(prompt.endsWith(task));
    assert.equal(fs.existsSync(path.join(nested, "never")), false);
  } finally { cleanupDir(project); }
});
