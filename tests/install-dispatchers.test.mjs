import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { cleanupDir, makeTempDir } from "./helpers.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const installScript = path.join(PLUGIN_ROOT, "scripts", "install_dispatchers.sh");
const uninstallScript = path.join(PLUGIN_ROOT, "scripts", "uninstall_dispatchers.sh");

function fixture(workspace) {
  const file = path.join(workspace, "catalog.json");
  fs.writeFileSync(file, JSON.stringify({
    models: ["gpt-new", "gpt-fast"],
    modelsDetail: [
      { slug: "gpt-new", display_name: "GPT New", reasoning_efforts: ["medium", "high"] },
      { slug: "gpt-fast", display_name: "GPT Fast", reasoning_efforts: ["low", "medium"] },
    ],
    efforts: ["low", "medium", "high"],
    access: ["read-only", "workspace-write", "danger-full-access"],
    defaultModel: "gpt-new",
  }), "utf8");
  return file;
}

function run(script, cwd, catalog = null) {
  return spawnSync("bash", [script], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...(catalog ? { CC_SUITE_CODEX_CATALOG_FILE: catalog } : {}) },
  });
}

test("installer creates ordered /codex-* skills and $claude links idempotently", () => {
  const workspace = makeTempDir();
  try {
    const catalog = fixture(workspace);
    const first = run(installScript, workspace, catalog);
    assert.equal(first.status, 0, first.stderr);
    const recent = path.join(workspace, ".claude", "skills", "codex-1-recent", "SKILL.md");
    const defaultSkill = path.join(workspace, ".claude", "skills", "codex-2-default", "SKILL.md");
    const other = path.join(workspace, ".claude", "skills", "codex-3-gpt-fast", "SKILL.md");
    const content = fs.readFileSync(recent, "utf8");
    assert.equal(fs.existsSync(defaultSkill), true);
    assert.equal(fs.existsSync(other), true);
    assert.match(content, /cc-suite-managed-codex-skill sha256=/);
    assert.ok(content.includes(path.join(PLUGIN_ROOT, "scripts", "codex-runner.mjs")));
    assert.equal(fs.existsSync(path.join(workspace, ".claude", "commands", "codex.md")), false);
    assert.equal(fs.lstatSync(path.join(workspace, ".agents", "skills", "claude-1-recent")).isSymbolicLink(), true);

    const second = run(installScript, workspace, catalog);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(fs.readFileSync(recent, "utf8"), content);
  } finally { cleanupDir(workspace); }
});

test("installer and uninstaller preserve an edited generated skill", () => {
  const workspace = makeTempDir();
  try {
    const catalog = fixture(workspace);
    assert.equal(run(installScript, workspace, catalog).status, 0);
    const target = path.join(workspace, ".claude", "skills", "codex-3-gpt-fast", "SKILL.md");
    fs.appendFileSync(target, "\nUser customization.\n", "utf8");
    const installAgain = run(installScript, workspace, catalog);
    assert.notEqual(installAgain.status, 0);
    assert.match(fs.readFileSync(target, "utf8"), /User customization/);
    const uninstall = run(uninstallScript, workspace);
    assert.notEqual(uninstall.status, 0);
    assert.equal(fs.existsSync(target), true);
  } finally { cleanupDir(workspace); }
});

test("uninstaller removes unchanged managed pickers and links", () => {
  const workspace = makeTempDir();
  try {
    const catalog = fixture(workspace);
    assert.equal(run(installScript, workspace, catalog).status, 0);
    assert.equal(run(uninstallScript, workspace).status, 0);
    assert.equal(fs.existsSync(path.join(workspace, ".claude", "skills", "codex-1-recent")), false);
    assert.equal(fs.existsSync(path.join(workspace, ".agents", "skills", "claude-1-recent")), false);
    assert.equal(fs.existsSync(path.join(workspace, ".cc-suite", "project.json")), false);
  } finally { cleanupDir(workspace); }
});
