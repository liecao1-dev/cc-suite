import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const PLUGIN_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  ".."
);
const SKILLS_DIR = path.join(PLUGIN_ROOT, "skills", "cc-suite");

// Skills that either hand work back to Claude Code or mutate project state.
// bridge_skills.sh exposes the exact `$claude` discovery skill directly under
// .agents/skills/claude, so a Codex session that Claude itself spawned can see
// it. Left implicitly invocable, the entry can route work straight back to its
// author and collapse independent judgment. Dispatch skills must remain
// explicit-only.
const EXPLICIT_ONLY = ["claude"];

const IMPLICIT_ALLOWED = [];

function readPolicy(skill) {
  const policyPath = path.join(SKILLS_DIR, skill, "agents", "openai.yaml");
  if (!fs.existsSync(policyPath)) return null;
  return fs.readFileSync(policyPath, "utf8");
}

test("the guard list covers every cc-suite skill", () => {
  const onDisk = fs
    .readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const classified = [...EXPLICIT_ONLY, ...IMPLICIT_ALLOWED].sort();
  assert.deepEqual(
    onDisk,
    classified,
    "Every skill must be classified as explicit-only or implicit-allowed"
  );
});

test("delegating and mutating skills are explicit-only for Codex", () => {
  for (const skill of EXPLICIT_ONLY) {
    const policy = readPolicy(skill);
    assert.ok(
      policy,
      `Skill ${skill} must ship agents/openai.yaml to block implicit invocation`
    );
    assert.match(
      policy,
      /^policy:$/m,
      `Skill ${skill} openai.yaml must declare a policy block`
    );
    assert.match(
      policy,
      /^\s+allow_implicit_invocation:\s*false\s*$/m,
      `Skill ${skill} must set allow_implicit_invocation: false`
    );
  }
});

test("passive reference skills stay implicitly invocable", () => {
  for (const skill of IMPLICIT_ALLOWED) {
    const policy = readPolicy(skill);
    if (policy === null) continue;
    assert.doesNotMatch(
      policy,
      /allow_implicit_invocation:\s*false/,
      `Reference skill ${skill} should remain implicitly invocable`
    );
  }
});

test("the Codex runner owns the no-return boundary", () => {
  const runner = fs.readFileSync(path.join(PLUGIN_ROOT, "scripts", "codex-runner.mjs"), "utf8");
  assert.match(runner, /withDelegationBoundary/);
  assert.equal(fs.existsSync(path.join(PLUGIN_ROOT, "commands", "codex.md")), false);
});
