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
const CATALOG = {
  models: ["gpt-new", "gpt-fast"],
  modelsDetail: [
    { slug: "gpt-new", display_name: "GPT New", reasoning_efforts: ["medium", "high"] },
    { slug: "gpt-fast", display_name: "GPT Fast", reasoning_efforts: ["low", "medium"] },
  ],
  efforts: ["low", "medium", "high"],
  access: ["read-only", "workspace-write", "danger-full-access"],
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
  assert.deepEqual(buildCodexSkillProfiles(catalog).map((item) => item.name), [
    "codex-1-recent", "codex-2-default", "codex-3-gpt-5-4",
  ]);
});

test("project discovery includes nested repos/worktrees and prunes dependencies", () => {
  const scope = makeTempDir("cc-suite-scope-");
  try {
    const repo = path.join(scope, "repo");
    const nested = path.join(repo, "nested-worktree");
    const plain = path.join(scope, "中文 plain project");
    fs.mkdirSync(repo);
    initGitRepo(repo);
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, ".git"), "gitdir: ../.git/worktrees/nested\n");
    fs.mkdirSync(path.join(plain, "child"), { recursive: true });
    fs.writeFileSync(path.join(plain, "package.json"), "{}\n");
    fs.writeFileSync(path.join(plain, "child", "package.json"), "{}\n");
    fs.mkdirSync(path.join(scope, "node_modules", "ignored"), { recursive: true });
    fs.mkdirSync(path.join(scope, ".runtime", "ignored"), { recursive: true });
    fs.mkdirSync(path.join(scope, "node_modules", "ignored", ".git"));
    fs.mkdirSync(path.join(scope, ".runtime", "ignored", ".git"));

    const canonical = [scope, plain, repo, nested].map((item) => fs.realpathSync(item));
    assert.deepEqual(discoverProjectRoots(scope), canonical.sort((a, b) => {
      const da = path.resolve(a).split(path.sep).length;
      const db = path.resolve(b).split(path.sep).length;
      return da - db || a.localeCompare(b);
    }));
  } finally { cleanupDir(scope); }
});

test("project install is idempotent, locally ignored, and safely removable", () => {
  const scope = makeTempDir("cc-suite-project-");
  try {
    initGitRepo(scope);
    const first = installProjectDispatch({ root: scope, scopeRoot: scope, sourceRoot: SOURCE_ROOT, catalog: CATALOG });
    assert.equal(first.conflicts.length, 0);
    assert.equal(inspectProjectDispatch({ root: scope, sourceRoot: SOURCE_ROOT }).ok, true);
    const profile = path.join(scope, ".claude", "skills", "codex-1-recent", "SKILL.md");
    const content = fs.readFileSync(profile, "utf8");
    assert.match(content, /--profile 'recent'/);
    assert.equal(fs.lstatSync(path.join(scope, ".agents", "skills", "claude-1-recent")).isSymbolicLink(), true);
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

test("a user-owned /codex-* collision is preserved and reported", () => {
  const scope = makeTempDir("cc-suite-collision-");
  try {
    const skill = path.join(scope, ".claude", "skills", "codex-3-gpt-fast");
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, "SKILL.md"), "# Mine\n");
    const result = installProjectDispatch({ root: scope, scopeRoot: scope, sourceRoot: SOURCE_ROOT, catalog: CATALOG });
    assert.match(result.conflicts.join("\n"), /codex-3-gpt-fast.*user-owned/);
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
    assert.equal(fs.lstatSync(path.join(scope, ".agents", "skills", "claude-1-recent")).isSymbolicLink(), true);
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
    assert.equal(fs.existsSync(path.join(scope, ".agents", "skills", "claude-1-recent")), false);
    assert.equal(fs.existsSync(path.join(scope, ".claude", "skills", "codex-1-recent", "SKILL.md")), true);
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
