import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const PLUGIN_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const COMMANDS_DIR = path.join(PLUGIN_ROOT, "commands");
const CLAUDE_SKILLS_DIR = path.join(PLUGIN_ROOT, "skills", "cc-suite");
const CLAUDE_SKILL_PROFILES = new Map([
  ["claude-1-recent", "recent"],
  ["claude-2-default", "default"],
  ["claude-3-sonnet", "model:sonnet"],
  ["claude-4-opus", "model:opus"],
  ["claude-5-haiku", "model:haiku"],
]);
const PUBLIC_COMMANDS = [
  "cancel", "diagnose", "init", "repair", "result", "status", "unbridge", "update",
];

function readCommand(name) {
  return fs.readFileSync(path.join(COMMANDS_DIR, `${name}.md`), "utf8");
}

function extractFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result = {};
  for (const line of match[1].split("\n")) {
    const [key, ...rest] = line.split(":");
    if (key.trim()) result[key.trim()] = rest.join(":").trim().replace(/^"(.*)"$/, "$1");
  }
  return result;
}

test("the public Claude command surface is intentionally small", () => {
  const onDisk = fs.readdirSync(COMMANDS_DIR)
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.slice(0, -3)).sort();
  assert.deepEqual(onDisk, [...PUBLIC_COMMANDS].sort());
  assert.equal(fs.existsSync(path.join(COMMANDS_DIR, "codex.md")), false);
});

test("every maintenance command has useful frontmatter", () => {
  for (const name of PUBLIC_COMMANDS) {
    const frontmatter = extractFrontmatter(readCommand(name));
    assert.ok(frontmatter.description, `${name} is missing a description`);
    assert.ok(frontmatter.description.length > 5, `${name} description is too short`);
  }
});

test("task-taxonomy commands and the after-send chooser are absent", () => {
  for (const name of [
    "audit", "audit-fix", "bug-analyze", "continue", "implement", "review-plan",
    "verify", "agy", "grok", "qwen-review", "codex",
  ]) assert.equal(fs.existsSync(path.join(COMMANDS_DIR, `${name}.md`)), false, name);
});

test("init installs both pre-send prefixes through the scoped synchronizer", () => {
  const content = readCommand("init");
  assert.match(content, /输入 `\/codex`，先选配置/);
  assert.match(content, /输入 `\$claude`，先选配置/);
  assert.match(content, /sync-projects\.mjs/);
  assert.match(content, /--scope "\$PWD" --project "\$PWD"/);
  assert.match(content, /不要创建 exact `\/codex`/);
  assert.doesNotMatch(content, /AskUserQuestion|mcp_claude|mcp_codex|回复编号/);
});

test("$claude exposes ordered pre-send choices backed by Claude CLI", () => {
  const onDisk = fs.readdirSync(CLAUDE_SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  assert.deepEqual(onDisk, [...CLAUDE_SKILL_PROFILES.keys()]);

  let expectedIndex = 1;
  for (const [skillName, profile] of CLAUDE_SKILL_PROFILES) {
    const skillDir = path.join(CLAUDE_SKILLS_DIR, skillName);
    const content = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
    const policy = fs.readFileSync(path.join(skillDir, "agents", "openai.yaml"), "utf8");
    assert.match(content, new RegExp(`name: ${skillName}`));
    assert.match(content, new RegExp(`--profile ${profile.replace(":", "\\:")}`));
    assert.match(content, /claude-runner\.mjs/);
    assert.match(content, /--prompt-stdin/);
    assert.match(content, /下一次任务或追问.*重新输入 `\$claude`/s);
    assert.doesNotMatch(content, /config\.mjs list|AskUserQuestion|mcp__claude-code/);
    assert.match(policy, new RegExp(`display_name: "Claude ${expectedIndex}｜派遣｜`));
    assert.match(policy, new RegExp(`default_prompt: ".*\\$${skillName}`));
    assert.match(policy, /allow_implicit_invocation:\s*false/);
    assert.doesNotMatch(policy, /^dependencies:/m);
    expectedIndex += 1;
  }
});

test("plugin hooks track job lifecycle without the removed audit gate", () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "hooks", "hooks.json"), "utf8"));
  assert.ok(hooks.hooks.SessionStart);
  assert.ok(hooks.hooks.SessionEnd);
  assert.equal(hooks.hooks.Stop, undefined);
});

test("package and Claude plugin manifests agree on the 3.x release", () => {
  const plugin = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8"));
  const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "package.json"), "utf8"));
  assert.equal(pkg.name, plugin.name);
  assert.equal(pkg.version, plugin.version);
  assert.match(plugin.version, /^3\.\d+\.\d+$/);
});
