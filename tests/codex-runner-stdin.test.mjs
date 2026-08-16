import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { cleanupDir, makeTempDir } from "./helpers.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const runner = path.join(PLUGIN_ROOT, "scripts", "codex-runner.mjs");

test("codex runner reads an arbitrary prompt from stdin without shell interpretation", () => {
  const workspace = makeTempDir();
  try {
    const bin = path.join(workspace, "bin");
    const capture = path.join(workspace, "captured-prompt.txt");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "codex"), `#!/usr/bin/env bash
set -euo pipefail
last=""
output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then
    output="$2"
    shift 2
  else
    last="$1"
    shift
  fi
done
printf '%s' "$last" > "$CAPTURE_PROMPT"
printf 'finished\n' > "$output"
printf '%s\n' '{"type":"thread.started","thread_id":"12345678-1234-1234-1234-123456789abc"}'
`, "utf8");
    fs.chmodSync(path.join(bin, "codex"), 0o755);

    const prompt = "literal $(touch should-not-run) `whoami` \\\"quotes\\\"\nsecond line\n";
    const result = spawnSync(process.execPath, [
      runner,
      "--kind", "dispatch",
      "--model", "test-model",
      "--effort", "medium",
      "--sandbox", "read-only",
      "--timeout-ms", "5000",
      "--prompt-stdin",
    ], {
      cwd: workspace,
      input: prompt,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        CAPTURE_PROMPT: capture,
        CLAUDE_PLUGIN_DATA: path.join(workspace, "state"),
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, "completed");
    const captured = fs.readFileSync(capture, "utf8");
    assert.match(captured, /^This request already reached you by delegation from Claude Code\./);
    assert.ok(captured.endsWith(prompt));
    assert.equal(captured.match(/This request already reached you/g)?.length, 1);
    assert.equal(fs.existsSync(path.join(workspace, "should-not-run")), false);
  } finally {
    cleanupDir(workspace);
  }
});

test("codex runner rejects simultaneous argv and stdin prompts", () => {
  const result = spawnSync(process.execPath, [
    runner,
    "--prompt-stdin",
    "--", "inline",
  ], { input: "stdin", encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /either --prompt-stdin or -- <prompt>/);
});
