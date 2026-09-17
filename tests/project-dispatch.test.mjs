import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { cleanupDir, initGitRepo, makeTempDir, run } from "./helpers.mjs";
import {
  buildCodexSkillProfiles,
  catalogFromModelsCache,
  discoverProjectRoots,
  inspectProjectDispatch,
  installProjectDispatch,
  removeProjectDispatch,
} from "../scripts/lib/project-dispatch.mjs";

const SOURCE_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SYNC = path.join(SOURCE_ROOT, "scripts", "sync-projects.mjs");
const CATALOG = {
  models: ["gpt-new", "gpt-fast"],
  modelsDetail: [
    { slug: "gpt-new", display_name: "GPT New", reasoning_efforts: ["medium", "high"] },
    { slug: "gpt-fast", display_name: "GPT Fast", reasoning_efforts: ["low", "medium"] },
  ],
  efforts: ["low", "medium", "high"],
  access: ["read-only", "workspace-write", "danger-full-access"],
  approvals: ["untrusted", "on-request", "never"],
  defaultModel: "gpt-new",
};

test("models cache becomes a general-purpose ordered dispatch catalog", () => {
  const catalog = catalogFromModelsCache({ models: [
    { slug: "gpt-5.4", display_name: "GPT 5.4", priority: 2, supported_reasoning_levels: [{ effort: "high" }] },
    { slug: "codex-auto-review", display_name: "Review", priority: 0, supported_reasoning_levels: [{ effort: "medium" }] },
    { slug: "gpt-5.6-sol", display_name: "GPT 5.6 Sol", description: "Latest frontier", priority: 1,
      supported_reasoning_levels: [{ effort: "medium" }, { effort: "ultra" }] },
  ] });
  assert.deepEqual(catalog.models, ["gpt-5.6-sol", "gpt-5.4"]);
  assert.equal(catalog.defaultModel, "gpt-5.6-sol");
  assert.deepEqual(catalog.efforts, ["medium", "high", "ultra"]);
  assert.deepEqual(buildCodexSkillProfiles(catalog).map((item) => item.name), ["codex"]);
  assert.equal(catalog.modelsDetail[0].default_reasoning_effort, null);
  assert.deepEqual(catalog.modelsDetail[0].reasoning_efforts, ["medium", "ultra"]);
});

test("project discovery includes nested repos/worktrees and prunes dependencies", () => {
  const scope = makeTempDir("cc-suite-scope-");
  try {
    const repo = path.join(scope, "repo");
    const nested = path.join(repo, "nested-worktree");
    const plain = path.join(scope, "中文 plain project");
    const managedWorkspace = path.join(scope, "managed workspace");
    const legacyWorkspace = path.join(scope, "legacy workspace");
    fs.mkdirSync(repo);
    initGitRepo(repo);
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, ".git"), "gitdir: ../.git/worktrees/nested\n");
    fs.mkdirSync(path.join(plain, "child"), { recursive: true });
    fs.writeFileSync(path.join(plain, "package.json"), "{}\n");
    fs.writeFileSync(path.join(plain, "child", "package.json"), "{}\n");
    fs.mkdirSync(managedWorkspace);
    installProjectDispatch({ root: managedWorkspace, scopeRoot: scope, sourceRoot: SOURCE_ROOT, catalog: CATALOG });
    fs.mkdirSync(path.join(legacyWorkspace, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(legacyWorkspace, ".codex", "hooks.json"), `${JSON.stringify({
      description: "cc-suite project-scoped dispatch hook.",
      hooks: {},
    }, null, 2)}\n`);
    fs.mkdirSync(path.join(scope, "node_modules", "ignored"), { recursive: true });
    fs.mkdirSync(path.join(scope, ".runtime", "ignored"), { recursive: true });
    fs.mkdirSync(path.join(scope, "node_modules", "ignored", ".git"));
    fs.mkdirSync(path.join(scope, ".runtime", "ignored", ".git"));

    const canonical = [scope, plain, managedWorkspace, legacyWorkspace, repo, nested]
      .map((item) => fs.realpathSync(item));
    assert.deepEqual(discoverProjectRoots(scope), canonical.sort((a, b) => {
      const da = path.resolve(a).split(path.sep).length;
      const db = path.resolve(b).split(path.sep).length;
      return da - db || a.localeCompare(b);
    }));
  } finally { cleanupDir(scope); }
});

test("scope sync installs model-agnostic selectors and user hooks without a models cache", () => {
  const scope = makeTempDir("cc-suite-no-cache-");
  const home = path.join(scope, "empty-home");
  try {
    fs.mkdirSync(home);
    const result = spawnSync(process.execPath, [
      SYNC, "sync", "--scope", scope, "--source", SOURCE_ROOT, "--json",
    ], {
      cwd: scope,
      env: { ...process.env, HOME: home },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.catalog, undefined);
    assert.equal(fs.existsSync(path.join(scope, ".claude", "skills", "codex", "SKILL.md")), true);
    assert.equal(fs.existsSync(path.join(scope, ".codex", "hooks.json")), false);
    assert.equal(fs.existsSync(path.join(scope, ".claude", "settings.local.json")), false);
    assert.match(fs.readFileSync(path.join(home, ".codex", "hooks.json"), "utf8"), /cc-suite-dispatch-hook/);
    assert.match(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"), /cc-suite-dispatch-hook/);
    assert.equal(fs.existsSync(path.join(scope, ".cc-suite", "bin", "cc-suite-dispatch-hook")), true);
  } finally { cleanupDir(scope); }
});

test("project install is idempotent, keeps only selectors locally, and is safely removable", () => {
  const scope = makeTempDir("cc-suite-project-");
  try {
    initGitRepo(scope);
    const first = installProjectDispatch({ root: scope, scopeRoot: scope, sourceRoot: SOURCE_ROOT, catalog: CATALOG });
    assert.equal(first.conflicts.length, 0);
    assert.equal(inspectProjectDispatch({ root: scope, sourceRoot: SOURCE_ROOT }).ok, true);
    const profile = path.join(scope, ".claude", "skills", "codex", "SKILL.md");
    const content = fs.readFileSync(profile, "utf8");
    assert.match(content, /composer 代理/);
    assert.match(content, /\/codex.*不会被插入或发送/s);
    assert.match(content, /输入框内会出现受保护的.*Codex 与完整配置前缀/s);
    assert.equal(fs.lstatSync(path.join(scope, ".agents", "skills", "claude")).isSymbolicLink(), true);
    assert.equal(fs.existsSync(path.join(scope, ".codex", "hooks.json")), false);
    assert.equal(fs.existsSync(path.join(scope, ".claude", "settings.local.json")), false);
    assert.equal(fs.existsSync(path.join(scope, ".cc-suite", "project.json")), false);
    assert.equal(run("git", ["status", "--short", "--untracked-files=all"], { cwd: scope }).stdout, "");

    const second = installProjectDispatch({ root: scope, scopeRoot: scope, sourceRoot: SOURCE_ROOT, catalog: CATALOG });
    assert.equal(second.created.length + second.updated.length + second.removed.length, 0);
    assert.equal(fs.readFileSync(profile, "utf8"), content);

    const removed = removeProjectDispatch({ root: scope, scopeRoot: scope, sourceRoot: SOURCE_ROOT });
    assert.equal(removed.conflicts.length, 0);
    assert.equal(fs.existsSync(profile), false);
    assert.equal(fs.existsSync(path.join(scope, ".cc-suite", "project.json")), false);
  } finally { cleanupDir(scope); }
});

test("a user-owned exact /codex collision is preserved and reported", () => {
  const scope = makeTempDir("cc-suite-collision-");
  try {
    const skill = path.join(scope, ".claude", "skills", "codex");
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, "SKILL.md"), "# Mine\n");
    const result = installProjectDispatch({ root: scope, scopeRoot: scope, sourceRoot: SOURCE_ROOT, catalog: CATALOG });
    assert.match(result.conflicts.join("\n"), /codex.*user-owned/);
    assert.equal(fs.readFileSync(path.join(skill, "SKILL.md"), "utf8"), "# Mine\n");
  } finally { cleanupDir(scope); }
});

test("project install migrates the known obsolete .agents/skills root symlink", () => {
  const scope = makeTempDir("cc-suite-legacy-root-link-");
  try {
    fs.mkdirSync(path.join(scope, ".agents"), { recursive: true });
    fs.mkdirSync(path.join(scope, ".claude", "skills"), { recursive: true });
    fs.symlinkSync("../.claude/skills", path.join(scope, ".agents", "skills"));

    const result = installProjectDispatch({ root: scope, scopeRoot: scope, sourceRoot: SOURCE_ROOT, catalog: CATALOG });
    assert.equal(result.conflicts.length, 0);
    assert.match(result.removed.join("\n"), /obsolete cc-suite root symlink/);
    assert.equal(fs.lstatSync(path.join(scope, ".agents", "skills")).isDirectory(), true);
    assert.equal(fs.lstatSync(path.join(scope, ".agents", "skills", "claude")).isSymbolicLink(), true);
  } finally { cleanupDir(scope); }
});

test("project install preserves an unrelated .agents/skills root symlink", () => {
  const scope = makeTempDir("cc-suite-user-root-link-");
  try {
    fs.mkdirSync(path.join(scope, ".agents"), { recursive: true });
    fs.mkdirSync(path.join(scope, ".user-skills"), { recursive: true });
    fs.symlinkSync("../.user-skills", path.join(scope, ".agents", "skills"));

    const result = installProjectDispatch({ root: scope, scopeRoot: scope, sourceRoot: SOURCE_ROOT, catalog: CATALOG });
    assert.match(result.conflicts.join("\n"), /user\/unrelated symlink/);
    assert.equal(fs.readlinkSync(path.join(scope, ".agents", "skills")), "../.user-skills");
    assert.equal(fs.existsSync(path.join(scope, ".agents", "skills", "claude")), false);
    assert.equal(fs.existsSync(path.join(scope, ".claude", "skills", "codex", "SKILL.md")), true);
  } finally { cleanupDir(scope); }
});

test("project migration removes legacy cc-suite hooks and preserves unrelated handlers", () => {
  const scope = makeTempDir("cc-suite-hook-merge-");
  try {
    fs.mkdirSync(path.join(scope, ".codex"), { recursive: true });
    fs.mkdirSync(path.join(scope, ".claude"), { recursive: true });
    const originalCodex = {
      description: "user hooks",
      hooks: {
        UserPromptSubmit: [{ hooks: [
          { type: "command", command: "node user-codex-hook.mjs" },
          { type: "command", command: `node '${path.join(SOURCE_ROOT, "scripts", "dispatch-hook.mjs")}' --host codex --target claude` },
        ] }],
        Stop: [{ hooks: [
          { type: "command", command: "node user-codex-stop.mjs" },
          { type: "command", command: `node '${path.join(SOURCE_ROOT, "scripts", "dispatch-hook.mjs")}' --host codex --target claude` },
        ] }],
      },
    };
    const originalClaude = {
      theme: "dark",
      hooks: {
        UserPromptSubmit: [{ hooks: [
          { type: "command", command: "node user-claude-submit.mjs" },
          { type: "command", command: `node '${path.join(SOURCE_ROOT, "scripts", "dispatch-hook.mjs")}' --host claude --target codex` },
        ] }],
        UserPromptExpansion: [{ matcher: "^mine$", hooks: [
          { type: "command", command: "node user-expansion.mjs" },
          { type: "command", command: `node '${path.join(SOURCE_ROOT, "scripts", "dispatch-hook.mjs")}' --host claude --target codex` },
        ] }],
      },
    };
    fs.writeFileSync(path.join(scope, ".codex", "hooks.json"), `${JSON.stringify(originalCodex, null, 2)}\n`);
    fs.writeFileSync(path.join(scope, ".claude", "settings.local.json"), `${JSON.stringify(originalClaude, null, 2)}\n`);

    const first = installProjectDispatch({ root: scope, scopeRoot: scope, sourceRoot: SOURCE_ROOT, catalog: CATALOG });
    assert.equal(first.conflicts.length, 0);
    const codexInstalled = fs.readFileSync(path.join(scope, ".codex", "hooks.json"), "utf8");
    const claudeInstalled = fs.readFileSync(path.join(scope, ".claude", "settings.local.json"), "utf8");
    assert.match(codexInstalled, /user-codex-hook/);
    assert.match(codexInstalled, /user-codex-stop/);
    assert.doesNotMatch(codexInstalled, /--host codex --target claude/);
    assert.match(claudeInstalled, /user-claude-submit/);
    assert.match(claudeInstalled, /user-expansion/);
    assert.doesNotMatch(claudeInstalled, /--host claude --target codex/);

    const second = installProjectDispatch({ root: scope, scopeRoot: scope, sourceRoot: SOURCE_ROOT, catalog: CATALOG });
    assert.equal(second.created.length + second.updated.length + second.removed.length, 0);
    assert.equal(fs.readFileSync(path.join(scope, ".codex", "hooks.json"), "utf8"), codexInstalled);
    assert.equal(fs.readFileSync(path.join(scope, ".claude", "settings.local.json"), "utf8"), claudeInstalled);

    const removed = removeProjectDispatch({ root: scope, scopeRoot: scope, sourceRoot: SOURCE_ROOT });
    assert.equal(removed.conflicts.length, 0);
    assert.match(fs.readFileSync(path.join(scope, ".codex", "hooks.json"), "utf8"), /user-codex-hook/);
    assert.match(fs.readFileSync(path.join(scope, ".claude", "settings.local.json"), "utf8"), /user-claude-submit/);
  } finally { cleanupDir(scope); }
});

test("project install preserves a user-owned Claude status line", () => {
  const scope = makeTempDir("cc-suite-statusline-collision-");
  try {
    fs.mkdirSync(path.join(scope, ".claude"), { recursive: true });
    const statusLine = { type: "command", command: "node my-statusline.mjs", refreshInterval: 5 };
    fs.writeFileSync(path.join(scope, ".claude", "settings.local.json"), `${JSON.stringify({
      theme: "dark",
      statusLine,
    }, null, 2)}\n`);

    const result = installProjectDispatch({ root: scope, scopeRoot: scope, sourceRoot: SOURCE_ROOT, catalog: CATALOG });
    const installed = JSON.parse(fs.readFileSync(path.join(scope, ".claude", "settings.local.json"), "utf8"));
    assert.deepEqual(installed.statusLine, statusLine);
    assert.doesNotMatch(result.conflicts.join("\n"), /statusLine/);
    assert.equal(installed.hooks, undefined);

    removeProjectDispatch({ root: scope, scopeRoot: scope, sourceRoot: SOURCE_ROOT });
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(scope, ".claude", "settings.local.json"), "utf8")),
      { theme: "dark", statusLine },
    );
  } finally { cleanupDir(scope); }
});

test("project install removes the obsolete cc-suite Claude status line", () => {
  const scope = makeTempDir("cc-suite-obsolete-statusline-");
  try {
    fs.mkdirSync(path.join(scope, ".claude"), { recursive: true });
    const script = path.join(SOURCE_ROOT, "scripts", "dispatch-statusline.mjs");
    fs.writeFileSync(path.join(scope, ".claude", "settings.local.json"), `${JSON.stringify({
      theme: "dark",
      statusLine: {
        type: "command",
        command: `node '${script}' --host claude`,
        refreshInterval: 1,
      },
    }, null, 2)}\n`);

    installProjectDispatch({ root: scope, scopeRoot: scope, sourceRoot: SOURCE_ROOT, catalog: CATALOG });
    const installed = JSON.parse(fs.readFileSync(path.join(scope, ".claude", "settings.local.json"), "utf8"));
    assert.equal(installed.statusLine, undefined);
    assert.equal(installed.theme, "dark");
    assert.equal(installed.hooks, undefined);
  } finally { cleanupDir(scope); }
});

test("project sync removes only the recognizable legacy codex-cli MCP entry", () => {
  const scope = makeTempDir("cc-suite-legacy-codex-mcp-");
  try {
    fs.writeFileSync(path.join(scope, ".mcp.json"), `${JSON.stringify({ mcpServers: {
      tauri: { command: "npx", args: ["-y", "tauri-mcp"] },
      "codex-cli": { type: "stdio", command: "codex", args: ["mcp-server"] },
    } }, null, 2)}\n`);

    const result = installProjectDispatch({ root: scope, scopeRoot: scope, sourceRoot: SOURCE_ROOT, catalog: CATALOG });
    const remaining = JSON.parse(fs.readFileSync(path.join(scope, ".mcp.json"), "utf8"));
    assert.deepEqual(remaining.mcpServers, { tauri: { command: "npx", args: ["-y", "tauri-mcp"] } });
    assert.match(result.removed.join("\n"), /legacy codex-cli MCP registration/);
  } finally { cleanupDir(scope); }
});

test("project sync preserves a custom codex-cli MCP entry", () => {
  const scope = makeTempDir("cc-suite-custom-codex-mcp-");
  try {
    const custom = { mcpServers: { "codex-cli": { command: "/custom/codex-server" } } };
    fs.writeFileSync(path.join(scope, ".mcp.json"), `${JSON.stringify(custom, null, 2)}\n`);

    const result = installProjectDispatch({ root: scope, scopeRoot: scope, sourceRoot: SOURCE_ROOT, catalog: CATALOG });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(scope, ".mcp.json"), "utf8")), custom);
    assert.match(result.conflicts.join("\n"), /custom codex-cli entry; preserved/);
  } finally { cleanupDir(scope); }
});
