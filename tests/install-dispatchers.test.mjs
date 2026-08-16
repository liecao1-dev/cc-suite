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

test("installer creates exact /codex and $claude entries plus hooks idempotently", () => {
  const workspace = makeTempDir();
  try {
    const catalog = fixture(workspace);
    const first = run(installScript, workspace, catalog);
    assert.equal(first.status, 0, first.stderr);
    const codexSkill = path.join(workspace, ".claude", "skills", "codex", "SKILL.md");
    const content = fs.readFileSync(codexSkill, "utf8");
    assert.match(content, /cc-suite-managed-codex-skill sha256=/);
    assert.match(content, /composer 代理/);
    assert.match(content, /\/codex.*不会被插入或发送/s);
    assert.equal(fs.existsSync(path.join(workspace, ".claude", "commands", "codex.md")), false);
    assert.equal(fs.lstatSync(path.join(workspace, ".agents", "skills", "claude")).isSymbolicLink(), true);
    const codexHooks = fs.readFileSync(path.join(workspace, ".codex", "hooks.json"), "utf8");
    const claudeHooks = fs.readFileSync(path.join(workspace, ".claude", "settings.local.json"), "utf8");
    assert.match(codexHooks, /dispatch-hook\.mjs.*--host codex --target claude/);
    assert.match(claudeHooks, /dispatch-hook\.mjs.*--host claude --target codex/);

    const second = run(installScript, workspace, catalog);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(fs.readFileSync(codexSkill, "utf8"), content);
    assert.equal(fs.readFileSync(path.join(workspace, ".codex", "hooks.json"), "utf8"), codexHooks);
    assert.equal(fs.readFileSync(path.join(workspace, ".claude", "settings.local.json"), "utf8"), claudeHooks);
  } finally { cleanupDir(workspace); }
});

test("installer and uninstaller preserve an edited generated skill", () => {
  const workspace = makeTempDir();
  try {
    const catalog = fixture(workspace);
    assert.equal(run(installScript, workspace, catalog).status, 0);
    const target = path.join(workspace, ".claude", "skills", "codex", "SKILL.md");
    fs.appendFileSync(target, "\nUser customization.\n", "utf8");
    const installAgain = run(installScript, workspace, catalog);
    assert.notEqual(installAgain.status, 0);
    assert.match(fs.readFileSync(target, "utf8"), /User customization/);
    const uninstall = run(uninstallScript, workspace);
    assert.notEqual(uninstall.status, 0);
    assert.equal(fs.existsSync(target), true);
  } finally { cleanupDir(workspace); }
});

test("uninstaller removes unchanged exact entries and managed hook handlers", () => {
  const workspace = makeTempDir();
  try {
    const catalog = fixture(workspace);
    assert.equal(run(installScript, workspace, catalog).status, 0);
    assert.equal(run(uninstallScript, workspace).status, 0);
    assert.equal(fs.existsSync(path.join(workspace, ".claude", "skills", "codex")), false);
    assert.equal(fs.existsSync(path.join(workspace, ".agents", "skills", "claude")), false);
    assert.equal(fs.existsSync(path.join(workspace, ".codex", "hooks.json")), false);
    assert.equal(fs.existsSync(path.join(workspace, ".claude", "settings.local.json")), false);
    assert.equal(fs.existsSync(path.join(workspace, ".cc-suite", "project.json")), false);
  } finally { cleanupDir(workspace); }
});
