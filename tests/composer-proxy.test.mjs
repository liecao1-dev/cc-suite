import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const PROXY = path.join(ROOT, "scripts", "composer-proxy.py");

function probe(host, chunks) {
  const result = spawnSync("python3", [PROXY, "--probe-input"], {
    cwd: ROOT,
    input: JSON.stringify({ host, chunks }),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("selecting exact $claude consumes Enter before Codex can submit it", () => {
  assert.deepEqual(probe("codex", ["$claude", "\r"]), {
    forwarded: ["$claude", ""],
    triggers: 1,
    buffer: "",
  });
});

test("selecting exact /codex with Tab opens configuration before Claude submits it", () => {
  assert.deepEqual(probe("claude", ["/codex", "\t"]), {
    forwarded: ["/codex", ""],
    triggers: 1,
    buffer: "",
  });
});

test("workflow sync and combined task text are never mistaken for the exact selector", () => {
  assert.equal(probe("codex", ["$claude-workflow-sync", "\r"]).triggers, 0);
  assert.equal(probe("codex", ["$claude do work", "\r"]).triggers, 0);
});

test("moving to another completion row does not open the dispatcher picker", () => {
  assert.equal(probe("codex", ["$claude", "\u001b[B", "\r"]).triggers, 0);
  assert.equal(probe("codex", ["$claude", "\u001b[B", "\u001b[A", "\r"]).triggers, 1);
  assert.equal(probe("codex", ["$claude", "\u001b[A", "\r"]).triggers, 0);
  assert.equal(probe("codex", ["$claude", "\u001b[A", "\u001b[B", "\r"]).triggers, 1);
  assert.equal(probe("claude", ["/codex", "\u001b[B", "\r"]).triggers, 0);
});

test("basic composer editing still resolves the exact pre-send selector", () => {
  assert.equal(probe("codex", ["$claudx", "\u007f", "e", "\r"]).triggers, 1);
  assert.equal(probe("claude", ["/codx", "\u007f", "ex", "\r"]).triggers, 1);
  assert.equal(probe("claude", ["/codex", "\u001b[B", "\u001b[A", "\r"]).triggers, 1);
});

test("ordinary task submission passes through untouched", () => {
  const result = probe("codex", ["请检查这个项目", "\r"]);
  assert.equal(result.triggers, 0);
  assert.equal(result.forwarded.join(""), "请检查这个项目\r");
  assert.equal(result.buffer, "");
});
