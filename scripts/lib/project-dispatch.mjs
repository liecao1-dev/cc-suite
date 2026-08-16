import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const CLAUDE_PROFILE_SKILLS = Object.freeze([
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
    if (entries.some((entry) => entry.isFile() && PROJECT_MARKERS.has(entry.name))) {
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

function codexVersion(slug) {
  const match = String(slug).toLowerCase().match(/gpt-(\d+)(?:\.(\d+))?/);
  return match ? [Number(match[1]), Number(match[2] ?? 0)] : [-1, -1];
}

/** Convert Codex's user cache into the same ordered catalog the picker uses,
 * without launching a model call or writing outside the requested scope. */
export function catalogFromModelsCache(payload) {
  const models = Array.isArray(payload?.models) ? payload.models : [];
  const ranked = models
    .map((model, index) => {
      const slug = typeof model?.slug === "string" ? model.slug.trim() : "";
      const displayName = model?.display_name || slug;
      const description = model?.description || slug;
      const text = `${slug} ${displayName} ${description}`.toLowerCase();
      const [major, minor] = codexVersion(slug);
      return {
        index,
        slug,
        display_name: displayName,
        description,
        priority: Number(model?.priority ?? 0) || 0,
        reasoning_efforts: (model?.supported_reasoning_levels ?? [])
          .map((level) => level?.effort)
          .filter((effort) => typeof effort === "string" && effort),
        reviewOnly: slug.toLowerCase().includes("auto-review") || text.includes("automatic approval review"),
        latestRank: text.includes("latest") ? 0 : 1,
        major,
        minor,
      };
    })
    .filter((model) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(model.slug))
    .sort((a, b) =>
      Number(a.reviewOnly) - Number(b.reviewOnly)
      || a.latestRank - b.latestRank
      || b.major - a.major
      || b.minor - a.minor
      || a.priority - b.priority
      || a.index - b.index
    );

  const dispatchModels = ranked.filter((model) => !model.reviewOnly);
  if (!dispatchModels.length) throw new Error("Codex models cache contains no general dispatch models");
  const preferredEfforts = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
  const effortSet = new Set(dispatchModels.flatMap((model) => model.reasoning_efforts));
  return {
    models: dispatchModels.map((model) => model.slug),
    modelsDetail: dispatchModels.map(({ slug, display_name, description, priority, reasoning_efforts }) => ({
      slug,
      display_name,
      description,
      priority,
      reasoning_efforts,
    })),
    efforts: preferredEfforts.filter((effort) => effortSet.has(effort)),
    access: ["read-only", "workspace-write", "danger-full-access"],
    defaultModel: dispatchModels[0].slug,
  };
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

function slugify(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "model";
}

export function buildCodexSkillProfiles(catalog) {
  const details = new Map((catalog.modelsDetail ?? []).map((entry) => [entry.slug, entry]));
  const profiles = [
    {
      name: "codex-1-recent",
      profile: "recent",
      title: "Codex 1｜派遣｜最近配置",
      description: "使用本项目上一次选择的完整配置；首次使用时明确采用默认配置。",
    },
    {
      name: "codex-2-default",
      profile: "default",
      title: "Codex 2｜派遣｜默认配置",
      description: `使用当前 Codex 默认模型 ${catalog.defaultModel}、推荐推理强度和 workspace-write。`,
    },
  ];
  let index = 3;
  const usedNames = new Set(profiles.map((profile) => profile.name));
  for (const model of catalog.models) {
    if (model === catalog.defaultModel) continue;
    let name = `codex-${index}-${slugify(model)}`;
    if (usedNames.has(name)) name += `-${sha256(model).slice(0, 6)}`;
    usedNames.add(name);
    const detail = details.get(model);
    profiles.push({
      name,
      profile: `model:${model}`,
      title: `Codex ${index}｜派遣｜${detail?.display_name ?? model}`,
      description: `使用 ${model}、该模型推荐推理强度和 workspace-write。`,
    });
    index += 1;
  }
  return profiles;
}

export function renderCodexSkill(profile, sourceRoot) {
  const configScript = shellQuote(path.join(sourceRoot, "scripts", "dispatch-config.mjs"));
  const runnerScript = shellQuote(path.join(sourceRoot, "scripts", "codex-runner.mjs"));
  const body = `---
name: ${profile.name}
description: ${yamlQuote(`${profile.title}。${profile.description} 输入 /codex 后在发送前选择此项，追加大白话任务并一次发送。`)}
argument-hint: ${yamlQuote("<用大白话写任务>")}
disable-model-invocation: true
allowed-tools:
  - Bash
---

# ${profile.title}

用户已经在发送消息前选定本配置。不要再展示配置列表，不要询问编号，也不要把任务
改写成 implement、review、plan、audit 或 debug 等工作流。

1. 将 \`$ARGUMENTS\` 原样视为本次任务。若去掉首尾空白后为空，只询问“这次要
   Codex 做什么？”，拿到任务前不要解析或记录配置。
2. 在当前工作目录运行：

   \`\`\`bash
   node ${configScript} resolve --target codex --profile ${shellQuote(profile.profile)} --cwd "$PWD"
   \`\`\`

   只解析 stdout JSON。\`status\` 不为 \`ok\` 时显示错误并停止；不得由 Claude
   冒充 Codex 完成任务。
3. 任务非空后，用返回的 \`config.model\`、\`config.effort\` 和 \`config.access\`
   调用同一脚本的 \`record\` 命令。记录失败就停止。
4. 使用高熵且未在任务中单独成行出现的 heredoc 结束符，把用户任务通过 stdin
   交给 runner；不得把任务拼进 shell 参数：

   \`\`\`bash
   node ${runnerScript} \\
     --kind dispatch \\
     --model "{model}" \\
     --effort "{effort}" \\
     --sandbox "{access}" \\
     --timeout-ms 900000 \\
     --summary "codex dispatch" \\
     --prompt-stdin <<'CC_SUITE_TASK_<fresh-random-suffix>'
   {task}
   CC_SUITE_TASK_<fresh-random-suffix>
   \`\`\`

   runner 会在子进程边界加入“不得把任务派回 Claude”的固定提示，并从用户当前
   子目录启动 Codex。不得使用 \`--resume\`。
5. \`status=completed\` 时原样呈现 \`rawOutput\`，并简短列出配置与 \`jobId\`；
   \`failed\` 或 \`stalled\` 时显示错误并停止，不要自动代答或重试。
6. 最后提醒：下一次任务或追问仍要重新输入 \`/codex\` 并在发送前选择配置。
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
    if (!entry.name.startsWith("codex-") || desired.has(entry.name)) continue;
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
    const generated = renderCodexSkill(profile, sourceRoot);
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

function managedExcludeBlock() {
  return [
    EXCLUDE_OPEN,
    "/.agents/skills/claude-*",
    "/.claude/skills/codex-*",
    "/.cc-suite/project.json",
    "/.cc-suite/runtime/",
    "/.cc-suite/cache/",
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
  const profiles = installCodexSkills(resolvedRoot, resolvedSource, resolvedScope, catalog, result);
  removeOwnedLegacyCommand(resolvedRoot, result);
  removeManagedMcpBlock(resolvedRoot, result);
  removeLegacyCodexMcpEntry(resolvedRoot, result);
  writeProjectMarker(resolvedRoot, resolvedScope, resolvedSource, profiles, result);
  upsertLocalExclude(resolvedRoot, resolvedScope, result);
  return result;
}

function removeProjectMarkerAndRuntime(root, scopeRoot, result) {
  const base = path.join(root, ".cc-suite");
  const marker = path.join(base, "project.json");
  if (fs.existsSync(marker) && !fs.lstatSync(marker).isSymbolicLink()) {
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(marker, "utf8")); } catch {}
    if (parsed?.managedBy === MANAGED_BY && parsed?.schema === MARKER_SCHEMA) {
      fs.unlinkSync(marker);
      result.removed.push(".cc-suite/project.json");
    } else result.conflicts.push(".cc-suite/project.json is user-owned; preserved");
  }
  const runtime = path.join(base, "runtime");
  if (isWithin(scopeRoot, runtime) && fs.existsSync(runtime) && !fs.lstatSync(runtime).isSymbolicLink()) {
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
  for (const name of CLAUDE_PROFILE_SKILLS) {
    const target = path.join(agentsSkills, name);
    if (!fs.lstatSync(target, { throwIfNoEntry: false })) continue;
    const stat = fs.lstatSync(target);
    if (!stat.isSymbolicLink()) {
      result.conflicts.push(`${path.relative(resolvedRoot, target)} is user-owned; preserved`);
      continue;
    }
    let real = null;
    try { real = fs.realpathSync.native(target); } catch {}
    if (real && isWithin(path.join(resolvedSource, "skills", "cc-suite"), real)) {
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
      if (entry.name.startsWith("codex-") && entry.isDirectory() && !entry.isSymbolicLink() && directoryIsOwnedSkill(candidate)) {
        fs.unlinkSync(path.join(candidate, "SKILL.md"));
        fs.rmdirSync(candidate);
        result.removed.push(path.relative(resolvedRoot, candidate));
      } else if (entry.name.startsWith("codex-")) {
        result.conflicts.push(`${path.relative(resolvedRoot, candidate)} is user-owned; preserved`);
      }
    }
    removeEmpty(claudeSkills);
    removeEmpty(path.dirname(claudeSkills));
  }
  removeOwnedLegacyCommand(resolvedRoot, result);
  removeManagedMcpBlock(resolvedRoot, result);
  removeLegacyCodexMcpEntry(resolvedRoot, result);
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
  const marker = path.join(root, ".cc-suite", "project.json");
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(marker, "utf8")); } catch {}
  if (parsed?.managedBy !== MANAGED_BY || parsed?.schema !== MARKER_SCHEMA) problems.push("project marker missing");
  for (const name of parsed?.profiles?.codex ?? []) {
    if (!directoryIsOwnedSkill(path.join(root, ".claude", "skills", name))) problems.push(`${name}: missing or user-owned`);
  }
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
