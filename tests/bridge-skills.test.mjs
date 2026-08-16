import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { cleanupDir, makeTempDir } from "./helpers.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const BRIDGE_SCRIPT = path.join(PLUGIN_ROOT, "scripts", "bridge_skills.sh");
const PLUGIN_SKILLS = path.join(PLUGIN_ROOT, "skills", "cc-suite");
const CLAUDE_SKILL_NAMES = ["claude"];

function runBridge(cwd) {
  return spawnSync("bash", [BRIDGE_SCRIPT], { cwd, encoding: "utf8" });
}

test("bridge exposes exact $claude as an immediate skill and remains idempotent", () => {
  const workspace = makeTempDir();
  try {
    const projectSkill = path.join(workspace, ".agents", "skills", "my-skill");
    fs.mkdirSync(projectSkill, { recursive: true });
    fs.writeFileSync(path.join(projectSkill, "SKILL.md"), "# My Skill\n", "utf8");

    const first = runBridge(workspace);
    assert.equal(first.status, 0, first.stderr);

    const agentsSkills = path.join(workspace, ".agents", "skills");
    assert.equal(fs.lstatSync(agentsSkills).isDirectory(), true);
    assert.equal(fs.lstatSync(agentsSkills).isSymbolicLink(), false);
    for (const skillName of CLAUDE_SKILL_NAMES) {
      const link = path.join(agentsSkills, skillName);
      assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
      assert.equal(fs.realpathSync(link), path.join(PLUGIN_SKILLS, skillName));
      assert.equal(fs.existsSync(path.join(link, "SKILL.md")), true);
    }
    assert.equal(fs.existsSync(path.join(agentsSkills, "my-skill", "SKILL.md")), true);
    const second = runBridge(workspace);
    assert.equal(second.status, 0, second.stderr);
    for (const skillName of CLAUDE_SKILL_NAMES) {
      assert.equal(
        fs.realpathSync(path.join(agentsSkills, skillName)),
        path.join(PLUGIN_SKILLS, skillName)
      );
    }
  } finally {
    cleanupDir(workspace);
  }
});

test("bridge migrates the obsolete nested cc-suite link", () => {
  const workspace = makeTempDir();
  try {
    const skills = path.join(workspace, ".claude", "skills");
    fs.mkdirSync(skills, { recursive: true });
    fs.symlinkSync(PLUGIN_SKILLS, path.join(skills, "cc-suite"));
    fs.mkdirSync(path.join(workspace, ".agents"), { recursive: true });
    fs.symlinkSync("../.claude/skills", path.join(workspace, ".agents", "skills"));

    const result = runBridge(workspace);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(skills, "cc-suite")), false);
    const agentsSkills = path.join(workspace, ".agents", "skills");
    assert.equal(fs.lstatSync(agentsSkills).isDirectory(), true);
    assert.equal(fs.lstatSync(agentsSkills).isSymbolicLink(), false);
    for (const skillName of CLAUDE_SKILL_NAMES) {
      assert.equal(
        fs.realpathSync(path.join(agentsSkills, skillName)),
        path.join(PLUGIN_SKILLS, skillName)
      );
    }
  } finally {
    cleanupDir(workspace);
  }
});

test("bridge preserves a user-owned legacy picker entry while installing exact $claude", () => {
  const workspace = makeTempDir();
  try {
    const claudePath = path.join(workspace, ".agents", "skills", "claude-3-sonnet");
    fs.mkdirSync(claudePath, { recursive: true });
    const userSkill = path.join(claudePath, "SKILL.md");
    fs.writeFileSync(userSkill, "# User Claude Skill\n", "utf8");

    const result = runBridge(workspace);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(userSkill, "utf8"), "# User Claude Skill\n");
    assert.equal(fs.lstatSync(claudePath).isSymbolicLink(), false);
    assert.equal(
      fs.realpathSync(path.join(workspace, ".agents", "skills", "claude")),
      path.join(PLUGIN_SKILLS, "claude"),
    );
  } finally {
    cleanupDir(workspace);
  }
});

test("bridge preserves a user-owned exact $claude collision and fails closed", () => {
  const workspace = makeTempDir();
  try {
    const legacyPath = path.join(workspace, ".agents", "skills", "claude");
    fs.mkdirSync(legacyPath, { recursive: true });
    const userSkill = path.join(legacyPath, "SKILL.md");
    fs.writeFileSync(userSkill, "# User Claude Skill\n", "utf8");

    const result = runBridge(workspace);
    assert.notEqual(result.status, 0);
    assert.equal(fs.readFileSync(userSkill, "utf8"), "# User Claude Skill\n");
    assert.equal(fs.lstatSync(legacyPath).isSymbolicLink(), false);
  } finally {
    cleanupDir(workspace);
  }
});
