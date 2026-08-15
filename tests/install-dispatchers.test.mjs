import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { cleanupDir, makeTempDir } from "./helpers.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const installScript = path.join(PLUGIN_ROOT, "scripts", "install_dispatchers.sh");
const uninstallScript = path.join(PLUGIN_ROOT, "scripts", "uninstall_dispatchers.sh");

function run(script, cwd) {
  return spawnSync("bash", [script], { cwd, encoding: "utf8" });
}

test("installer creates an idempotent literal /codex command with a resolved plugin path", () => {
  const workspace = makeTempDir();
  try {
    const first = run(installScript, workspace);
    assert.equal(first.status, 0, first.stderr);
    const target = path.join(workspace, ".claude", "commands", "codex.md");
    const content = fs.readFileSync(target, "utf8");
    assert.match(content, /cc-suite-dispatcher: codex sha256=/);
    assert.ok(content.includes(path.join(PLUGIN_ROOT, "scripts", "dispatch-config.mjs")));
    assert.doesNotMatch(content, /\$\{CLAUDE_PLUGIN_ROOT\}/);

    const second = run(installScript, workspace);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(fs.readFileSync(target, "utf8"), content);
  } finally {
    cleanupDir(workspace);
  }
});

test("installer and uninstaller preserve a dispatcher edited by the user", () => {
  const workspace = makeTempDir();
  try {
    assert.equal(run(installScript, workspace).status, 0);
    const target = path.join(workspace, ".claude", "commands", "codex.md");
    fs.appendFileSync(target, "\nUser customization.\n", "utf8");

    const installAgain = run(installScript, workspace);
    assert.equal(installAgain.status, 0);
    assert.match(fs.readFileSync(target, "utf8"), /User customization/);

    const uninstall = run(uninstallScript, workspace);
    assert.equal(uninstall.status, 0, uninstall.stderr);
    assert.equal(fs.existsSync(target), true);
  } finally {
    cleanupDir(workspace);
  }
});

test("uninstaller removes an unchanged generated dispatcher", () => {
  const workspace = makeTempDir();
  try {
    assert.equal(run(installScript, workspace).status, 0);
    const target = path.join(workspace, ".claude", "commands", "codex.md");
    assert.equal(run(uninstallScript, workspace).status, 0);
    assert.equal(fs.existsSync(target), false);
  } finally {
    cleanupDir(workspace);
  }
});
