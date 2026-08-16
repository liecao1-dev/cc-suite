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
  "cancel",
  "codex",
  "diagnose",
  "init",
  "repair",
  "result",
  "status",
  "unbridge",
  "update",
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
  const onDisk = fs
    .readdirSync(COMMANDS_DIR)
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.slice(0, -3))
    .sort();
  assert.deepEqual(onDisk, [...PUBLIC_COMMANDS].sort());
});

test("every command has valid frontmatter with a useful description", () => {
  for (const name of PUBLIC_COMMANDS) {
    const frontmatter = extractFrontmatter(readCommand(name));
    assert.ok(frontmatter.description, `${name} is missing a description`);
    assert.ok(frontmatter.description.length > 5, `${name} description is too short`);
  }
});

test("old task-taxonomy dispatch commands are absent", () => {
  for (const name of [
    "audit",
    "audit-fix",
    "bug-analyze",
    "continue",
    "implement",
    "review-plan",
    "verify",
    "agy",
    "grok",
    "qwen-review",
  ]) {
    assert.equal(fs.existsSync(path.join(COMMANDS_DIR, `${name}.md`)), false, name);
  }
});

test("the Codex dispatcher requires manual per-call selection and fails closed", () => {
  const content = readCommand("codex");
  assert.match(content, /\$ARGUMENTS/);
  assert.match(content, /dispatch-config\.mjs" list --target codex/);
  assert.match(content, /dispatch-config\.mjs" record/);
  assert.match(content, /始终调用 `AskUserQuestion`/);
  assert.match(content, /不得自动选择默认配置/);
  assert.match(content, /最近配置在最上，默认配置第二/);
  assert.match(content, /不得回退到 Claude/);
  assert.match(content, /--kind dispatch/);
  assert.match(content, /--prompt-stdin/);
  assert.match(content, /heredoc/);
  assert.doesNotMatch(content, /--resume \{/);
  assert.doesNotMatch(content, /-- "\{combined_prompt\}"/);
});

test("init installs exactly the two model-named dispatch directions", () => {
  const content = readCommand("init");
  assert.match(content, /\/codex <任务>/);
  assert.match(content, /先输入 `\$claude`/);
  assert.match(content, /发送前选配置/);
  assert.match(content, /scripts\/install_dispatchers\.sh|scripts\/init\.sh/);
  assert.match(content, /scripts\/mcp_claude\.sh/);
  assert.match(content, /不在初始化时锁定/);
  assert.match(content, /不要再推荐 `\/implement`/);
});

test("$claude exposes ordered configuration choices before submission", () => {
  const onDisk = fs
    .readdirSync(CLAUDE_SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(onDisk, [...CLAUDE_SKILL_PROFILES.keys()]);

  let expectedIndex = 1;
  for (const [skillName, profile] of CLAUDE_SKILL_PROFILES) {
    const skillDir = path.join(CLAUDE_SKILLS_DIR, skillName);
    const content = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
    const policy = fs.readFileSync(path.join(skillDir, "agents", "openai.yaml"), "utf8");

    assert.match(content, new RegExp(`name: ${skillName}`));
    assert.match(content, new RegExp(`--profile ${profile.replace(":", "\\:")}`));
    assert.match(content, /不要再显示配置\s*列表/);
    assert.match(content, /config\.mjs record/);
    assert.match(content, /mcp__claude-code__claude_code/);
    assert.match(content, /下一次派遣请重新输入\s*`\$claude`/);
    assert.doesNotMatch(content, /config\.mjs list|显示短编号列表|### 2\. 立即让用户选择/);
    assert.match(policy, new RegExp(`display_name: "Claude ${expectedIndex}｜派遣｜`));
    assert.match(policy, new RegExp(`default_prompt: ".*\\$${skillName}`));
    expectedIndex += 1;
  }
});

test("plugin hooks track job lifecycle without the removed audit gate", () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "hooks", "hooks.json"), "utf8"));
  assert.ok(hooks.hooks.SessionStart);
  assert.ok(hooks.hooks.SessionEnd);
  assert.equal(hooks.hooks.Stop, undefined);
  assert.equal(hooks.hooks.SessionStart[0].hooks[0].timeout, 5);
});

test("package and Claude plugin manifests agree on the 3.x release", () => {
  const plugin = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8"));
  const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "package.json"), "utf8"));
  assert.equal(pkg.name, plugin.name);
  assert.equal(pkg.version, plugin.version);
  assert.match(plugin.version, /^3\.\d+\.\d+$/);
});
