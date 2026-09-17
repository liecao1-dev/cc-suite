import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { catalogFromCodexModelsCache } from "./dispatch-catalog.mjs";

export const CLAUDE_PROFILE_SKILLS = Object.freeze(["claude"]);
const LEGACY_CLAUDE_PROFILE_SKILLS = Object.freeze([
  "claude-1-recent",
  "claude-2-default",
  "claude-3-sonnet",
  "claude-4-opus",
  "claude-5-haiku",
]);

const PRUNED_DIRS = new Set([
  ".git", ".hg", ".svn", ".runtime", ".cache", ".venv", ".next",
  ".turbo", ".gradle", ".idea", ".pytest_cache", "__pycache__",
  "node_modules", "vendor", "dist", "build", "coverage", "target", "out",
]);
const PROJECT_MARKERS = new Set([
  "AGENTS.md", "package.json", "pyproject.toml", "Cargo.toml", "go.mod",
  "Gemfile", "composer.json", "pom.xml", "build.gradle", "build.gradle.kts",
]);
const MANAGED_BY = "cc-suite";
const MARKER_SCHEMA = 1;
const SKILL_MARKER = /^<!-- cc-suite-managed-codex-skill sha256=([0-9a-f]{64}) -->$/m;
const LEGACY_COMMAND_MARKER = /^<!-- cc-suite-dispatcher: codex sha256=([0-9a-f]{64}) -->$/m;
const EXCLUDE_OPEN = "# >>> cc-suite-project-dispatch >>>";
const EXCLUDE_CLOSE = "# <<< cc-suite-project-dispatch <<<";
const LEGACY_MCP_OPEN = "# >>> cc-suite-mcp >>>";
const LEGACY_MCP_CLOSE = "# <<< cc-suite-mcp <<<";
const MCP_OPEN = "# >>> cc-suite-claude-mcp >>>";
const MCP_CLOSE = "# <<< cc-suite-claude-mcp <<<";
const LEGACY_CODEX_MCP = Object.freeze({ type: "stdio", command: "codex", args: ["mcp-server"] });

function depth(value) {
  return path.resolve(value).split(path.sep).length;
}

export function isWithin(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function isPrunedDirectory(name) {
  return PRUNED_DIRS.has(name) || name.startsWith(".whisper") || name.startsWith(".");
}

function hasGitMarker(directory) {
  try {
    const stat = fs.lstatSync(path.join(directory, ".git"));
    return stat.isDirectory() || stat.isFile();
  } catch {
    return false;
  }
}

function hasManagedProjectArtifact(directory) {
  if (directoryIsOwnedSkill(path.join(directory, ".claude", "skills", "codex"))) {
    return true;
  }
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(directory, ".cc-suite", "project.json"), "utf8"));
    if (marker?.managedBy === MANAGED_BY && marker?.schema === MARKER_SCHEMA) return true;
  } catch {}
  try {
    const hooks = JSON.parse(fs.readFileSync(path.join(directory, ".codex", "hooks.json"), "utf8"));
    if (hooks?.description === "cc-suite project-scoped dispatch hook.") return true;
  } catch {}
  return false;
}

/** Discover the scope root, every nested Git/worktree root, and top-level
 * non-Git projects with common project markers. Symlinks are never followed. */
export function discoverProjectRoots(scopeRoot) {
  const scope = fs.realpathSync.native(path.resolve(scopeRoot));
  const gitRoots = [];
  const nonGitCandidates = [];
  const stack = [scope];

  while (stack.length) {
    const current = stack.pop();
    if (current !== scope && hasGitMarker(current)) gitRoots.push(current);

    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    if (
      entries.some((entry) => entry.isFile() && PROJECT_MARKERS.has(entry.name))
      || hasManagedProjectArtifact(current)
    ) {
      nonGitCandidates.push(current);
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (isPrunedDirectory(entry.name)) continue;
      stack.push(path.join(current, entry.name));
    }
  }

  gitRoots.sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
  nonGitCandidates.sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
  const nonGitRoots = [];
  for (const candidate of nonGitCandidates) {
    if (candidate === scope) continue;
    if (gitRoots.some((root) => isWithin(root, candidate))) continue;
    if (nonGitRoots.some((root) => isWithin(root, candidate))) continue;
    nonGitRoots.push(candidate);
  }

  return [...new Set([scope, ...gitRoots, ...nonGitRoots])]
    .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
}

/** Convert Codex's user cache into the same ordered catalog the picker uses,
 * without launching a model call or writing outside the requested scope. */
export function catalogFromModelsCache(payload) {
  return catalogFromCodexModelsCache(payload);
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function withoutOwnershipMarker(text, pattern) {
  const match = text.match(pattern);
  if (!match) return { body: text, digest: null };
  const start = match.index;
  let end = start + match[0].length;
  if (text[end] === "\n") end += 1;
  return { body: text.slice(0, start) + text.slice(end), digest: match[1] };
}

function isOwnedText(text, pattern) {
  const { body, digest } = withoutOwnershipMarker(text, pattern);
  return digest !== null && sha256(body) === digest;
}

function addSkillMarker(body) {
  const marker = `<!-- cc-suite-managed-codex-skill sha256=${sha256(body)} -->\n`;
  const close = body.indexOf("\n---\n", 4);
  return close === -1 ? marker + body : body.slice(0, close + 5) + marker + body.slice(close + 5);
}

function yamlQuote(value) {
  return JSON.stringify(String(value));
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

export function buildCodexSkillProfiles() {
  return [{
    name: "codex",
    title: "派遣给 Codex",
    description: "先在补全菜单完成 Codex 配置，再发送一次性任务。",
  }];
}

export function renderCodexSkill(profile) {
  const body = `---
name: ${profile.name}
description: ${yamlQuote(`${profile.title}。在 Claude Code 补全菜单选择 /codex 时，范围内的 composer 代理会在提交前打开配置选择器；模型、该模型支持的推理强度和权限全部选好后，用户写下的第一条普通消息才作为一次性任务发送。`)}
disable-model-invocation: true
---

# ${profile.title}

正常情况下，范围内的 composer 代理会在补全菜单选择 \`/codex\` 的 Enter/Tab 到达
Claude Code 前打开键盘选择器。\`/codex\` 本身不会被插入或发送；选完后输入框内会出现受保护的
Codex 与完整配置前缀，光标紧随其后。再写真正的任务，发送时代理会先移除前缀，
只把任务正文交给一次性派遣。

若你现在能读到本段内容，说明发送前代理没有启用：

- 不要替 Codex 完成任务，也不要显示编号配置列表。
- 告诉用户运行项目范围同步器和 \`activate-composer.mjs install\`，再从新终端启动
  Claude Code，并确认 Claude Code 已信任当前项目。
- 不要把 \`/codex\` 当成消息发送；如果它已经到达模型，必须停止且不得派遣。
- 正确流程始终是：在补全菜单选择 \`/codex\` → 选完全部配置 → 写任务 → 只发送任务。
`;
  return addSkillMarker(body);
}

function ensureRealDirectory(directory, scopeRoot) {
  if (!isWithin(scopeRoot, directory)) throw new Error(`refusing path outside scope: ${directory}`);
  if (fs.existsSync(directory)) {
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`${directory} is not a real directory`);
    }
    return;
  }
  const parent = path.dirname(directory);
  if (parent !== directory) ensureRealDirectory(parent, scopeRoot);
  fs.mkdirSync(directory);
}

function writeAtomic(file, content, mode = 0o644) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.cc-suite-${process.pid}-${Math.random().toString(36).slice(2)}`);
  try {
    fs.writeFileSync(tmp, content, { encoding: "utf8", mode });
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

function directoryIsOwnedSkill(directory) {
  try {
    const entries = fs.readdirSync(directory);
    if (entries.length !== 1 || entries[0] !== "SKILL.md") return false;
    return isOwnedText(fs.readFileSync(path.join(directory, "SKILL.md"), "utf8"), SKILL_MARKER);
  } catch {
    return false;
  }
}

function removeEmpty(directory) {
  try { fs.rmdirSync(directory); } catch {}
}

function symlinkResolvesTo(link, expected) {
  try {
    return path.resolve(path.dirname(link), fs.readlinkSync(link)) === path.resolve(expected);
  } catch {
    return false;
  }
}

function installClaudeLinks(root, sourceRoot, scopeRoot, result) {
  const skillsRoot = path.join(root, ".agents", "skills");
  const existing = fs.lstatSync(skillsRoot, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink()) {
    const linkTarget = fs.readlinkSync(skillsRoot);
    if (linkTarget === "../.claude/skills") {
      fs.unlinkSync(skillsRoot);
      result.removed.push(".agents/skills (obsolete cc-suite root symlink)");
    } else {
      result.conflicts.push(`.agents/skills is a user/unrelated symlink to ${linkTarget}; preserved`);
      return;
    }
  }
  try {
    ensureRealDirectory(skillsRoot, scopeRoot);
  } catch (error) {
    result.conflicts.push(`.agents/skills could not be prepared: ${error.message}`);
    return;
  }

  for (const name of LEGACY_CLAUDE_PROFILE_SKILLS) {
    const target = path.join(skillsRoot, name);
    const expected = path.join(sourceRoot, "skills", "cc-suite", name);
    const stat = fs.lstatSync(target, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isSymbolicLink() && symlinkResolvesTo(target, expected)) {
      fs.unlinkSync(target);
      result.removed.push(`${path.relative(root, target)} (legacy flattened configuration)`);
    } else {
      result.conflicts.push(`${path.relative(root, target)} is user-owned; legacy name preserved`);
    }
  }

  for (const name of CLAUDE_PROFILE_SKILLS) {
    const source = path.join(sourceRoot, "skills", "cc-suite", name);
    if (!fs.existsSync(path.join(source, "SKILL.md"))) {
      throw new Error(`missing source skill: ${source}`);
    }
    const target = path.join(skillsRoot, name);
    if (fs.existsSync(target) || fs.lstatSync(target, { throwIfNoEntry: false })) {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) {
        let current = null;
        try { current = fs.realpathSync.native(target); } catch {}
        if (current === fs.realpathSync.native(source)) {
          result.unchanged.push(path.relative(root, target));
        } else {
          result.conflicts.push(`${path.relative(root, target)} is a user/unrelated symlink`);
        }
      } else {
        result.conflicts.push(`${path.relative(root, target)} is user-owned`);
      }
      continue;
    }
    fs.symlinkSync(source, target, "dir");
    result.created.push(path.relative(root, target));
  }
}

function installCodexSkills(root, sourceRoot, scopeRoot, catalog, result) {
  const skillsRoot = path.join(root, ".claude", "skills");
  const profiles = buildCodexSkillProfiles(catalog);
  try {
    ensureRealDirectory(skillsRoot, scopeRoot);
  } catch (error) {
    result.conflicts.push(`.claude/skills could not be prepared: ${error.message}`);
    return profiles;
  }
  const desired = new Set(profiles.map((profile) => profile.name));

  for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!(entry.name === "codex" || entry.name.startsWith("codex-")) || desired.has(entry.name)) continue;
    const candidate = path.join(skillsRoot, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink() && directoryIsOwnedSkill(candidate)) {
      fs.unlinkSync(path.join(candidate, "SKILL.md"));
      fs.rmdirSync(candidate);
      result.removed.push(path.relative(root, candidate));
    }
  }

  for (const profile of profiles) {
    const directory = path.join(skillsRoot, profile.name);
    const target = path.join(directory, "SKILL.md");
    const generated = renderCodexSkill(profile);
    if (fs.existsSync(directory) || fs.lstatSync(directory, { throwIfNoEntry: false })) {
      const stat = fs.lstatSync(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory() || !directoryIsOwnedSkill(directory)) {
        result.conflicts.push(`${path.relative(root, directory)} is user-owned`);
        continue;
      }
      const existing = fs.readFileSync(target, "utf8");
      if (existing === generated) result.unchanged.push(path.relative(root, directory));
      else {
        writeAtomic(target, generated);
        result.updated.push(path.relative(root, directory));
      }
      continue;
    }
    fs.mkdirSync(directory);
    writeAtomic(target, generated);
    result.created.push(path.relative(root, directory));
  }
  return profiles;
}

function removeOwnedLegacyCommand(root, result) {
  const target = path.join(root, ".claude", "commands", "codex.md");
  if (!fs.existsSync(target) || fs.lstatSync(target).isSymbolicLink()) return;
  const text = fs.readFileSync(target, "utf8");
  if (!isOwnedText(text, LEGACY_COMMAND_MARKER)) {
    result.conflicts.push(".claude/commands/codex.md is user-owned; legacy exact command preserved");
    return;
  }
  fs.unlinkSync(target);
  removeEmpty(path.dirname(target));
  result.removed.push(".claude/commands/codex.md (legacy after-send chooser)");
}

function removeManagedMcpBlock(root, result) {
  const file = path.join(root, ".codex", "config.toml");
  if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink()) return;
  const text = fs.readFileSync(file, "utf8");

  const markerSpan = (open, close) => {
    const opens = text.split(open).length - 1;
    const closes = text.split(close).length - 1;
    if (!opens && !closes) return { present: false };
    const start = text.indexOf(open);
    const closeStart = text.indexOf(close);
    if (opens !== 1 || closes !== 1 || closeStart < start) return { malformed: true };
    return { present: true, start, end: closeStart + close.length };
  };

  const claudeSpan = markerSpan(MCP_OPEN, MCP_CLOSE);
  if (!claudeSpan.present && !claudeSpan.malformed) return;
  const legacySpan = markerSpan(LEGACY_MCP_OPEN, LEGACY_MCP_CLOSE);
  const overlaps = claudeSpan.present && legacySpan.present
    && claudeSpan.start < legacySpan.end && legacySpan.start < claudeSpan.end;
  if (claudeSpan.malformed || legacySpan.malformed || overlaps) {
    result.conflicts.push(".codex/config.toml has malformed, nested, or interleaved cc-suite MCP markers; preserved");
    return;
  }

  const start = claudeSpan.start;
  let end = claudeSpan.end;
  if (text[end] === "\n") end += 1;
  let cleaned = `${text.slice(0, start).trimEnd()}\n${text.slice(end).trimStart()}`.trim();
  if (cleaned) writeAtomic(file, `${cleaned}\n`, fs.statSync(file).mode & 0o777);
  else fs.unlinkSync(file);
  removeEmpty(path.dirname(file));
  result.removed.push(".codex/config.toml cc-suite Claude MCP block");
}

function isLegacyCodexMcpEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  if (
    entry.type === LEGACY_CODEX_MCP.type
    && entry.command === LEGACY_CODEX_MCP.command
    && Array.isArray(entry.args)
    && entry.args.length === 1
    && entry.args[0] === LEGACY_CODEX_MCP.args[0]
  ) return true;
  return entry.command === "npx"
    && Array.isArray(entry.args)
    && entry.args.some((arg) => typeof arg === "string" && (
      arg.includes("codex-mcp-server") || arg.startsWith("@openai/codex-mcp")
    ));
}

function removeLegacyCodexMcpEntry(root, result) {
  const file = path.join(root, ".mcp.json");
  if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink()) return;
  let data;
  try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return; }
  const servers = data?.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers) || !("codex-cli" in servers)) return;
  if (!isLegacyCodexMcpEntry(servers["codex-cli"])) {
    result.conflicts.push(".mcp.json has a custom codex-cli entry; preserved");
    return;
  }

  delete servers["codex-cli"];
  if (Object.keys(servers).length === 0) delete data.mcpServers;
  if (Object.keys(data).length === 0) fs.unlinkSync(file);
  else writeAtomic(file, `${JSON.stringify(data, null, 2)}\n`, fs.statSync(file).mode & 0o777);
  result.removed.push(".mcp.json legacy codex-cli MCP registration");
}

function previousManagedSourceRoot(root) {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(root, ".cc-suite", "project.json"), "utf8"));
    if (marker?.managedBy === MANAGED_BY && typeof marker.sourceRoot === "string") {
      return marker.sourceRoot;
    }
  } catch {}
  return null;
}

function dispatchHookCommands(sourceRoots) {
  const commands = new Set();
  for (const sourceRoot of sourceRoots.filter(Boolean)) {
    const script = path.join(sourceRoot, "scripts", "dispatch-hook.mjs");
    commands.add(`node ${shellQuote(script)} --host codex --target claude`);
  }
  return commands;
}

function cleanHookGroups(groups, handlerMatches) {
  if (!Array.isArray(groups)) return null;
  const cleaned = [];
  for (const group of groups) {
    if (!group || typeof group !== "object" || !Array.isArray(group.hooks)) return null;
    const hooks = group.hooks.filter((handler) => !handlerMatches(handler));
    if (hooks.length) cleaned.push({ ...group, hooks });
  }
  return cleaned;
}

function installCodexDispatchHook(root, sourceRoot, scopeRoot, result) {
  const directory = path.join(root, ".codex");
  try { ensureRealDirectory(directory, scopeRoot); } catch (error) {
    result.conflicts.push(`.codex hook directory could not be prepared: ${error.message}`);
    return;
  }
  const file = path.join(directory, "hooks.json");
  if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) {
    result.conflicts.push(".codex/hooks.json is a symlink; dispatch hook not installed");
    return;
  }
  let data = {};
  let existingText = null;
  if (fs.existsSync(file)) {
    existingText = fs.readFileSync(file, "utf8");
    try { data = JSON.parse(existingText); } catch {
      result.conflicts.push(".codex/hooks.json is invalid JSON; preserved");
      return;
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      result.conflicts.push(".codex/hooks.json is not a JSON object; preserved");
      return;
    }
  }
  if (data.hooks !== undefined && (!data.hooks || typeof data.hooks !== "object" || Array.isArray(data.hooks))) {
    result.conflicts.push(".codex/hooks.json has a non-object hooks field; preserved");
    return;
  }
  const hooks = { ...(data.hooks ?? {}) };
  const previous = previousManagedSourceRoot(root);
  const commands = dispatchHookCommands([sourceRoot, previous]);
  const command = [...dispatchHookCommands([sourceRoot])][0];
  for (const event of ["UserPromptSubmit", "Stop"]) {
    const cleaned = cleanHookGroups(hooks[event] ?? [], (handler) =>
      handler?.type === "command" && commands.has(handler.command));
    if (cleaned === null) {
      result.conflicts.push(`.codex/hooks.json has an unsupported ${event} shape; preserved`);
      return;
    }
    cleaned.push({
      hooks: [{
        type: "command",
        command,
        timeout: 300,
        ...(event === "UserPromptSubmit" ? { additionalContextLimit: 0 } : {}),
      }],
    });
    hooks[event] = cleaned;
  }
  const next = {
    ...data,
    ...(existingText === null ? { description: "cc-suite project-scoped dispatch hook." } : {}),
    hooks,
  };
  const generated = `${JSON.stringify(next, null, 2)}\n`;
  if (generated === existingText) result.unchanged.push(".codex/hooks.json dispatch hook");
  else {
    writeAtomic(file, generated, existingText === null ? 0o600 : fs.statSync(file).mode & 0o777);
    result[existingText === null ? "created" : "updated"].push(".codex/hooks.json dispatch hook");
  }
}

function claudeHandler(sourceRoot) {
  const script = path.join(sourceRoot, "scripts", "dispatch-hook.mjs");
  return {
    type: "command",
    command: `node ${shellQuote(script)} --host claude --target codex`,
    timeout: 300,
  };
}

function isLegacyManagedClaudeStatusLine(value, sourceRoots) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return sourceRoots.filter(Boolean).some((sourceRoot) => {
    const script = path.join(sourceRoot, "scripts", "dispatch-statusline.mjs");
    return value.type === "command"
      && value.command === `node ${shellQuote(script)} --host claude`;
  });
}

function isManagedClaudeHandler(handler, sourceRoots) {
  if (handler?.type !== "command" || typeof handler.command !== "string") return false;
  return sourceRoots.filter(Boolean).some((sourceRoot) => {
    if (handler.command === claudeHandler(sourceRoot).command) return true;
    const legacyArgs = [
      path.join(sourceRoot, "scripts", "dispatch-hook.mjs"),
      "--host", "claude", "--target", "codex",
    ];
    return handler.command === "node"
      && Array.isArray(handler.args)
      && handler.args.length === legacyArgs.length
      && handler.args.every((value, index) => value === legacyArgs[index]);
  });
}

function installClaudeDispatchHooks(root, sourceRoot, scopeRoot, result) {
  const directory = path.join(root, ".claude");
  try { ensureRealDirectory(directory, scopeRoot); } catch (error) {
    result.conflicts.push(`.claude hook directory could not be prepared: ${error.message}`);
    return;
  }
  const file = path.join(directory, "settings.local.json");
  if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) {
    result.conflicts.push(".claude/settings.local.json is a symlink; dispatch hooks not installed");
    return;
  }
  let data = {};
  let existingText = null;
  if (fs.existsSync(file)) {
    existingText = fs.readFileSync(file, "utf8");
    try { data = JSON.parse(existingText); } catch {
      result.conflicts.push(".claude/settings.local.json is invalid JSON; preserved");
      return;
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      result.conflicts.push(".claude/settings.local.json is not a JSON object; preserved");
      return;
    }
  }
  if (data.hooks !== undefined && (!data.hooks || typeof data.hooks !== "object" || Array.isArray(data.hooks))) {
    result.conflicts.push(".claude/settings.local.json has a non-object hooks field; preserved");
    return;
  }
  const hooks = { ...(data.hooks ?? {}) };
  const sourceRoots = [sourceRoot, previousManagedSourceRoot(root)];
  for (const event of ["UserPromptSubmit", "UserPromptExpansion"]) {
    const cleaned = cleanHookGroups(hooks[event] ?? [], (handler) => isManagedClaudeHandler(handler, sourceRoots));
    if (cleaned === null) {
      result.conflicts.push(`.claude/settings.local.json has an unsupported ${event} shape; preserved`);
      return;
    }
    cleaned.push({
      ...(event === "UserPromptExpansion" ? { matcher: "^codex$" } : {}),
      hooks: [claudeHandler(sourceRoot)],
    });
    hooks[event] = cleaned;
  }
  const next = { ...data, hooks };
  if (isLegacyManagedClaudeStatusLine(next.statusLine, sourceRoots)) {
    delete next.statusLine;
  }
  const generated = `${JSON.stringify(next, null, 2)}\n`;
  if (generated === existingText) result.unchanged.push(".claude/settings.local.json dispatch hooks");
  else {
    writeAtomic(file, generated, existingText === null ? 0o600 : fs.statSync(file).mode & 0o777);
    result[existingText === null ? "created" : "updated"].push(".claude/settings.local.json dispatch hooks");
  }
}

function installProjectHooks(root, sourceRoot, scopeRoot, result) {
  installCodexDispatchHook(root, sourceRoot, scopeRoot, result);
  installClaudeDispatchHooks(root, sourceRoot, scopeRoot, result);
}

function removeCodexDispatchHook(root, sourceRoot, result) {
  const file = path.join(root, ".codex", "hooks.json");
  if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink()) return;
  const existingText = fs.readFileSync(file, "utf8");
  let data;
  try { data = JSON.parse(existingText); } catch { return; }
  const hooks = { ...(data.hooks ?? {}) };
  const commands = dispatchHookCommands([sourceRoot, previousManagedSourceRoot(root)]);
  for (const event of ["UserPromptSubmit", "Stop"]) {
    const cleaned = cleanHookGroups(hooks[event] ?? [], (handler) =>
      handler?.type === "command" && commands.has(handler.command));
    if (cleaned === null) return;
    if (cleaned.length) hooks[event] = cleaned;
    else delete hooks[event];
  }
  const next = { ...data, hooks };
  if (!Object.keys(hooks).length) delete next.hooks;
  if (next.description === "cc-suite project-scoped dispatch hook.") delete next.description;
  const generated = Object.keys(next).length ? `${JSON.stringify(next, null, 2)}\n` : null;
  if (generated === existingText) return;
  if (generated === null) fs.unlinkSync(file);
  else writeAtomic(file, generated, fs.statSync(file).mode & 0o777);
  removeEmpty(path.dirname(file));
  result.removed.push(".codex/hooks.json dispatch hook");
}

function removeClaudeDispatchHooks(root, sourceRoot, result) {
  const file = path.join(root, ".claude", "settings.local.json");
  if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink()) return;
  const existingText = fs.readFileSync(file, "utf8");
  let data;
  try { data = JSON.parse(existingText); } catch { return; }
  const hooks = { ...(data.hooks ?? {}) };
  const roots = [sourceRoot, previousManagedSourceRoot(root)];
  for (const event of ["UserPromptSubmit", "UserPromptExpansion"]) {
    const cleaned = cleanHookGroups(hooks[event] ?? [], (handler) => isManagedClaudeHandler(handler, roots));
    if (cleaned === null) return;
    if (cleaned.length) hooks[event] = cleaned;
    else delete hooks[event];
  }
  const next = { ...data, hooks };
  if (!Object.keys(hooks).length) delete next.hooks;
  if (isLegacyManagedClaudeStatusLine(next.statusLine, roots)) delete next.statusLine;
  const generated = Object.keys(next).length ? `${JSON.stringify(next, null, 2)}\n` : null;
  if (generated === existingText) return;
  if (generated === null) fs.unlinkSync(file);
  else writeAtomic(file, generated, fs.statSync(file).mode & 0o777);
  removeEmpty(path.dirname(file));
  result.removed.push(".claude/settings.local.json dispatch hooks");
}

function removeProjectHooks(root, sourceRoot, result) {
  removeCodexDispatchHook(root, sourceRoot, result);
  removeClaudeDispatchHooks(root, sourceRoot, result);
}

function managedExcludeBlock() {
  return [
    EXCLUDE_OPEN,
    "/.agents/skills/claude",
    "/.agents/skills/claude-*",
    "/.claude/skills/codex",
    "/.claude/skills/codex-*",
    EXCLUDE_CLOSE,
  ].join("\n");
}

function gitExcludePath(root, scopeRoot) {
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8" });
  if (top.status !== 0 || path.resolve(top.stdout.trim()) !== path.resolve(root)) return null;
  const common = spawnSync("git", ["rev-parse", "--git-common-dir"], { cwd: root, encoding: "utf8" });
  if (common.status !== 0 || !common.stdout.trim()) return null;
  const commonDir = path.resolve(root, common.stdout.trim());
  if (!isWithin(scopeRoot, commonDir)) return { outsideScope: commonDir };
  return { file: path.join(commonDir, "info", "exclude") };
}

function upsertLocalExclude(root, scopeRoot, result) {
  const resolved = gitExcludePath(root, scopeRoot);
  if (!resolved) return;
  if (resolved.outsideScope) {
    result.conflicts.push(`Git metadata is outside scope (${resolved.outsideScope}); local excludes skipped`);
    return;
  }
  ensureRealDirectory(path.dirname(resolved.file), scopeRoot);
  const existing = fs.existsSync(resolved.file) ? fs.readFileSync(resolved.file, "utf8") : "";
  const opens = existing.split(EXCLUDE_OPEN).length - 1;
  const closes = existing.split(EXCLUDE_CLOSE).length - 1;
  if (opens !== closes || opens > 1) {
    result.conflicts.push(".git/info/exclude has malformed cc-suite markers; preserved");
    return;
  }
  const block = managedExcludeBlock();
  let next;
  if (opens === 1) {
    const start = existing.indexOf(EXCLUDE_OPEN);
    const end = existing.indexOf(EXCLUDE_CLOSE, start) + EXCLUDE_CLOSE.length;
    const currentBlock = existing.slice(start, end);
    next = currentBlock === block
      ? existing
      : `${existing.slice(0, start)}${block}${existing.slice(end)}`;
  } else {
    next = `${existing.trimEnd()}${existing.trim() ? "\n\n" : ""}${block}\n`;
  }
  if (next !== existing) {
    writeAtomic(resolved.file, next, fs.existsSync(resolved.file) ? fs.statSync(resolved.file).mode & 0o777 : 0o644);
    result.updated.push(".git/info/exclude (local only)");
  } else {
    result.unchanged.push(".git/info/exclude (local only)");
  }
}

function removeLocalExclude(root, scopeRoot, result) {
  const resolved = gitExcludePath(root, scopeRoot);
  if (!resolved?.file || !fs.existsSync(resolved.file)) return;
  const text = fs.readFileSync(resolved.file, "utf8");
  const opens = text.split(EXCLUDE_OPEN).length - 1;
  const closes = text.split(EXCLUDE_CLOSE).length - 1;
  if (!opens && !closes) return;
  const start = text.indexOf(EXCLUDE_OPEN);
  const closeStart = text.indexOf(EXCLUDE_CLOSE);
  if (opens !== 1 || closes !== 1 || closeStart < start) {
    result.conflicts.push(".git/info/exclude has malformed cc-suite markers; preserved");
    return;
  }
  let end = closeStart + EXCLUDE_CLOSE.length;
  if (text[end] === "\n") end += 1;
  const cleaned = `${text.slice(0, start).trimEnd()}\n${text.slice(end).trimStart()}`.trim();
  writeAtomic(resolved.file, cleaned ? `${cleaned}\n` : "", fs.statSync(resolved.file).mode & 0o777);
  result.removed.push(".git/info/exclude cc-suite block");
}

function writeProjectMarker(root, scopeRoot, sourceRoot, profiles, result) {
  const directory = path.join(root, ".cc-suite");
  try {
    ensureRealDirectory(directory, scopeRoot);
  } catch (error) {
    result.conflicts.push(`.cc-suite/project.json could not be written: ${error.message}`);
    return;
  }
  const file = path.join(directory, "project.json");
  const marker = {
    schema: MARKER_SCHEMA,
    managedBy: MANAGED_BY,
    sourceRoot: path.resolve(sourceRoot),
    scopeRoot: path.resolve(scopeRoot),
    profiles: {
      claude: [...CLAUDE_PROFILE_SKILLS],
      codex: profiles.map((profile) => profile.name),
    },
  };
  const generated = `${JSON.stringify(marker, null, 2)}\n`;
  if (fs.existsSync(file)) {
    let current;
    try { current = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
    if (current?.managedBy !== MANAGED_BY || current?.schema !== MARKER_SCHEMA) {
      result.conflicts.push(".cc-suite/project.json is user-owned; marker preserved");
      return;
    }
    if (fs.readFileSync(file, "utf8") === generated) result.unchanged.push(".cc-suite/project.json");
    else {
      writeAtomic(file, generated, 0o600);
      result.updated.push(".cc-suite/project.json");
    }
  } else {
    writeAtomic(file, generated, 0o600);
    result.created.push(".cc-suite/project.json");
  }
}

export function installProjectDispatch({ root, scopeRoot, sourceRoot, catalog }) {
  const resolvedRoot = fs.realpathSync.native(path.resolve(root));
  const resolvedScope = fs.realpathSync.native(path.resolve(scopeRoot));
  const resolvedSource = fs.realpathSync.native(path.resolve(sourceRoot));
  if (!isWithin(resolvedScope, resolvedRoot)) throw new Error(`project outside scope: ${resolvedRoot}`);
  const result = { root: resolvedRoot, created: [], updated: [], unchanged: [], removed: [], conflicts: [] };
  installClaudeLinks(resolvedRoot, resolvedSource, resolvedScope, result);
  installCodexSkills(resolvedRoot, resolvedSource, resolvedScope, catalog, result);
  // Discovery stays project-local so the selectors do not appear outside the
  // configured scope. Execution hooks and state are scope/user-owned instead.
  // Migrate only recognizable cc-suite artifacts and preserve unrelated hook
  // definitions in the same files.
  removeProjectHooks(resolvedRoot, resolvedSource, result);
  removeOwnedLegacyCommand(resolvedRoot, result);
  removeManagedMcpBlock(resolvedRoot, result);
  removeLegacyCodexMcpEntry(resolvedRoot, result);
  removeProjectMarkerAndRuntime(
    resolvedRoot,
    resolvedScope,
    result,
    { preserveRuntime: resolvedRoot === resolvedScope },
  );
  upsertLocalExclude(resolvedRoot, resolvedScope, result);
  return result;
}

function removeProjectMarkerAndRuntime(root, scopeRoot, result, { preserveRuntime = false } = {}) {
  const base = path.join(root, ".cc-suite");
  const marker = path.join(base, "project.json");
  let ownedMarker = false;
  if (fs.existsSync(marker) && !fs.lstatSync(marker).isSymbolicLink()) {
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(marker, "utf8")); } catch {}
    if (parsed?.managedBy === MANAGED_BY && parsed?.schema === MARKER_SCHEMA) {
      ownedMarker = true;
      fs.unlinkSync(marker);
      result.removed.push(".cc-suite/project.json");
    } else result.conflicts.push(".cc-suite/project.json is user-owned; preserved");
  }
  const runtime = path.join(base, "runtime");
  if (
    ownedMarker
    && !preserveRuntime
    && isWithin(scopeRoot, runtime)
    && fs.existsSync(runtime)
    && !fs.lstatSync(runtime).isSymbolicLink()
  ) {
    fs.rmSync(runtime, { recursive: true });
    result.removed.push(".cc-suite/runtime (recent config and job state)");
  }
  removeEmpty(base);
}

export function removeProjectDispatch({ root, scopeRoot, sourceRoot }) {
  const resolvedRoot = fs.realpathSync.native(path.resolve(root));
  const resolvedScope = fs.realpathSync.native(path.resolve(scopeRoot));
  const resolvedSource = fs.realpathSync.native(path.resolve(sourceRoot));
  if (!isWithin(resolvedScope, resolvedRoot)) throw new Error(`project outside scope: ${resolvedRoot}`);
  const result = { root: resolvedRoot, created: [], updated: [], unchanged: [], removed: [], conflicts: [] };

  const agentsSkills = path.join(resolvedRoot, ".agents", "skills");
  for (const name of [...CLAUDE_PROFILE_SKILLS, ...LEGACY_CLAUDE_PROFILE_SKILLS]) {
    const target = path.join(agentsSkills, name);
    if (!fs.lstatSync(target, { throwIfNoEntry: false })) continue;
    const stat = fs.lstatSync(target);
    if (!stat.isSymbolicLink()) {
      result.conflicts.push(`${path.relative(resolvedRoot, target)} is user-owned; preserved`);
      continue;
    }
    const expected = path.join(resolvedSource, "skills", "cc-suite", name);
    if (symlinkResolvesTo(target, expected)) {
      fs.unlinkSync(target);
      result.removed.push(path.relative(resolvedRoot, target));
    } else result.conflicts.push(`${path.relative(resolvedRoot, target)} is unrelated; preserved`);
  }
  removeEmpty(agentsSkills);
  removeEmpty(path.dirname(agentsSkills));

  const claudeSkills = path.join(resolvedRoot, ".claude", "skills");
  if (fs.existsSync(claudeSkills) && !fs.lstatSync(claudeSkills).isSymbolicLink()) {
    for (const entry of fs.readdirSync(claudeSkills, { withFileTypes: true })) {
      const candidate = path.join(claudeSkills, entry.name);
      if ((entry.name === "codex" || entry.name.startsWith("codex-")) && entry.isDirectory() && !entry.isSymbolicLink() && directoryIsOwnedSkill(candidate)) {
        fs.unlinkSync(path.join(candidate, "SKILL.md"));
        fs.rmdirSync(candidate);
        result.removed.push(path.relative(resolvedRoot, candidate));
      } else if (entry.name === "codex" || entry.name.startsWith("codex-")) {
        result.conflicts.push(`${path.relative(resolvedRoot, candidate)} is user-owned; preserved`);
      }
    }
    removeEmpty(claudeSkills);
    removeEmpty(path.dirname(claudeSkills));
  }
  removeOwnedLegacyCommand(resolvedRoot, result);
  removeManagedMcpBlock(resolvedRoot, result);
  removeLegacyCodexMcpEntry(resolvedRoot, result);
  removeProjectHooks(resolvedRoot, resolvedSource, result);
  removeProjectMarkerAndRuntime(resolvedRoot, resolvedScope, result);
  removeLocalExclude(resolvedRoot, resolvedScope, result);
  return result;
}

export function inspectProjectDispatch({ root, sourceRoot }) {
  const problems = [];
  for (const name of CLAUDE_PROFILE_SKILLS) {
    const target = path.join(root, ".agents", "skills", name);
    try {
      if (!fs.lstatSync(target).isSymbolicLink()) problems.push(`${name}: not a symlink`);
      else if (fs.realpathSync.native(target) !== fs.realpathSync.native(path.join(sourceRoot, "skills", "cc-suite", name))) {
        problems.push(`${name}: wrong target`);
      }
    } catch { problems.push(`${name}: missing`); }
  }
  if (!directoryIsOwnedSkill(path.join(root, ".claude", "skills", "codex"))) {
    problems.push("codex: missing or user-owned");
  }
  const previous = previousManagedSourceRoot(root);
  if (previous) problems.push("legacy project marker remains");
  const codexCommands = dispatchHookCommands([sourceRoot, previous]);
  try {
    const hooks = JSON.parse(fs.readFileSync(path.join(root, ".codex", "hooks.json"), "utf8"));
    const found = ["UserPromptSubmit", "Stop"].some((event) =>
      (hooks?.hooks?.[event] ?? []).some((group) =>
        group?.hooks?.some((handler) => handler?.type === "command" && codexCommands.has(handler.command))));
    if (found) problems.push("legacy project-local Codex dispatch hook remains");
  } catch {}
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(root, ".claude", "settings.local.json"), "utf8"));
    const found = ["UserPromptSubmit", "UserPromptExpansion"].some((event) =>
      (settings?.hooks?.[event] ?? []).some((group) =>
        group?.hooks?.some((handler) => isManagedClaudeHandler(handler, [sourceRoot, previous]))));
    if (found) problems.push("legacy project-local Claude dispatch hook remains");
  } catch {}
  return { root, ok: problems.length === 0, problems };
}

export function managedLauncher(sourceRoot, scopeRoot) {
  const body = `#!/usr/bin/env bash\nexec node ${shellQuote(path.join(sourceRoot, "scripts", "sync-projects.mjs"))} "$@" --scope ${shellQuote(scopeRoot)}\n`;
  return `# cc-suite-managed-launcher sha256=${sha256(body)}\n${body}`;
}

export function launcherIsOwned(text) {
  const match = text.match(/^# cc-suite-managed-launcher sha256=([0-9a-f]{64})$/m);
  if (!match) return false;
  const start = match.index;
  let end = start + match[0].length;
  if (text[end] === "\n") end += 1;
  return sha256(text.slice(0, start) + text.slice(end)) === match[1];
}

export function writeManagedLauncher(scopeRoot, sourceRoot) {
  const directory = path.join(scopeRoot, ".cc-suite", "bin");
  ensureRealDirectory(directory, scopeRoot);
  const file = path.join(directory, "cc-suite-projects");
  const generated = managedLauncher(sourceRoot, scopeRoot);
  if (fs.existsSync(file) && !launcherIsOwned(fs.readFileSync(file, "utf8"))) {
    throw new Error(`${file} is user-owned; launcher not replaced`);
  }
  if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== generated) writeAtomic(file, generated, 0o755);
  return file;
}

export function removeManagedLauncher(scopeRoot) {
  const file = path.join(scopeRoot, ".cc-suite", "bin", "cc-suite-projects");
  if (!fs.existsSync(file)) return false;
  if (!launcherIsOwned(fs.readFileSync(file, "utf8"))) return false;
  fs.unlinkSync(file);
  removeEmpty(path.dirname(file));
  removeEmpty(path.join(scopeRoot, ".cc-suite"));
  return true;
}
