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
// bridge_skills.sh exposes the `$claude` picker entries directly under
// .agents/skills/claude-*, so a Codex session that Claude itself spawned can see
// them. Left implicitly invocable, a picker entry can route work straight back to its
// author and collapse independent judgment. Dispatch skills must remain
// explicit-only.
const EXPLICIT_ONLY = [
  "claude-1-recent",
  "claude-2-default",
  "claude-3-sonnet",
  "claude-4-opus",
  "claude-5-haiku",
];

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

test("the /codex prompt forbids delegating the task back to Claude", () => {
  const command = fs.readFileSync(
    path.join(PLUGIN_ROOT, "commands", "codex.md"),
    "utf8"
  );
  assert.match(
    command,
    /This request already reached you by delegation from Claude Code/,
    "commands/codex.md must carry the delegation boundary"
  );
  assert.match(
    command,
    /Do not invoke any \$claude-\* workspace skill/i,
    "The preamble must tell Codex not to invoke a $claude configuration skill"
  );
  assert.match(
    command,
    /固定边界/,
    "The delegation boundary must be a fixed prompt part"
  );
});
