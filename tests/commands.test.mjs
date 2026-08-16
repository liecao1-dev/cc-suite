import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const PLUGIN_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const COMMANDS_DIR = path.join(PLUGIN_ROOT, "commands");
const CLAUDE_SKILLS_DIR = path.join(PLUGIN_ROOT, "skills", "cc-suite");
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

test("init installs both pre-send dispatcher entries through the scoped synchronizer", () => {
  const content = readCommand("init");
  assert.match(content, /补全菜单高亮 `\/codex` 并按 Enter\/Tab/);
  assert.match(content, /补全菜单高亮 `\$claude` 并按 Enter\/Tab/);
  assert.match(content, /绝不能作为消息提交/);
  assert.match(content, /sync-projects\.mjs/);
  assert.match(content, /--scope "\$PWD" --project "\$PWD"/);
  assert.doesNotMatch(content, /AskUserQuestion|mcp_claude|mcp_codex|回复编号/);
});

test("$claude exposes one explicit discovery skill backed by the pre-send proxy", () => {
  const onDisk = fs.readdirSync(CLAUDE_SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  assert.deepEqual(onDisk, ["claude"]);

  const skillDir = path.join(CLAUDE_SKILLS_DIR, "claude");
  const content = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
  const policy = fs.readFileSync(path.join(skillDir, "agents", "openai.yaml"), "utf8");
  assert.match(content, /^name: claude$/m);
  assert.match(content, /composer 代理/);
  assert.match(content, /\$claude.*不会被插入或发送/s);
  assert.match(content, /选完全部配置.*只发送任务/s);
  assert.doesNotMatch(content, /claude-[1-5]|回复编号|AskUserQuestion|mcp__claude-code/);
  assert.match(policy, /display_name: "Claude · 派遣"/);
  assert.match(policy, /default_prompt: ".*\$claude/);
  assert.match(policy, /allow_implicit_invocation:\s*false/);
  assert.doesNotMatch(policy, /^dependencies:/m);
});

test("the Claude dispatcher sorts before the workflow-sync completion", () => {
  assert.ok(
    Buffer.compare(Buffer.from("Claude · 派遣"), Buffer.from("Claude 工作流同步")) < 0,
    "the exact dispatcher must remain the first stock Codex completion",
  );
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
