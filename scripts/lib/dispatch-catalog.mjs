import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  TARGETS,
  defaultEffortForModel,
  validateAgainstCatalog,
} from "./dispatch-config.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CODEX_EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

function orderedUnique(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value))];
}

function codexVersion(slug) {
  const match = String(slug).toLowerCase().match(/gpt-(\d+)(?:\.(\d+))?/);
  return match ? [Number(match[1]), Number(match[2] ?? 0)] : [-1, -1];
}

export function catalogFromCodexModelsCache(payload) {
  const models = Array.isArray(payload?.models) ? payload.models : [];
  const ranked = models
    .map((model, index) => {
      const slug = typeof model?.slug === "string" ? model.slug.trim() : "";
      const displayName = model?.display_name || slug;
      const description = model?.description || slug;
      const text = `${slug} ${displayName} ${description}`.toLowerCase();
      const [major, minor] = codexVersion(slug);
      const reasoning = (model?.supported_reasoning_levels ?? [])
        .map((level) => ({ effort: level?.effort, description: level?.description ?? "" }))
        .filter((level) => typeof level.effort === "string" && level.effort);
      return {
        index,
        slug,
        display_name: displayName,
        description,
        priority: Number(model?.priority ?? 0) || 0,
        reasoning_efforts: reasoning.map((level) => level.effort),
        reasoning_effort_details: reasoning,
        default_reasoning_effort: model?.default_reasoning_level ?? null,
        reviewOnly: slug.toLowerCase().includes("auto-review") || text.includes("automatic approval review"),
        latestRank: text.includes("latest") ? 0 : 1,
        major,
        minor,
      };
    })
    .filter((model) => MODEL_ID.test(model.slug))
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
  const discovered = orderedUnique(dispatchModels.flatMap((model) => model.reasoning_efforts));
  const efforts = [
    ...CODEX_EFFORT_ORDER.filter((effort) => discovered.includes(effort)),
    ...discovered.filter((effort) => !CODEX_EFFORT_ORDER.includes(effort)),
  ];
  return {
    models: dispatchModels.map((model) => model.slug),
    modelsDetail: dispatchModels.map(({
      slug, display_name, description, priority, reasoning_efforts,
      reasoning_effort_details, default_reasoning_effort,
    }) => ({
      slug,
      display_name,
      description,
      priority,
      reasoning_efforts,
      reasoning_effort_details,
      default_reasoning_effort,
    })),
    efforts,
    access: [...TARGETS.codex.access],
    approvals: [...TARGETS.codex.approvals],
    defaultModel: dispatchModels[0].slug,
    metadata: { source: "~/.codex/models_cache.json" },
  };
}

function commandOutput(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return result.status === 0 ? result.stdout.trim() : "";
}

function readCodexCatalog(home) {
  const file = path.join(home, ".codex", "models_cache.json");
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`无法读取 Codex 模型目录 ${file}: ${error.message}`);
  }
  const catalog = catalogFromCodexModelsCache(payload);
  catalog.metadata.codexVersion = commandOutput("codex", ["--version"]) || null;
  return catalog;
}

function titleCase(value) {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

export function claudeAliasesFromHelp(help) {
  const advertised = [];
  const modelSection = String(help).match(/--model <model>([\s\S]*?)(?:\n\s{2}--|\nCommands:)/)?.[1] ?? "";
  for (const match of modelSection.matchAll(/'([a-z][a-z0-9_-]{1,31})'/g)) {
    if (!match[1].startsWith("claude-")) advertised.push(match[1]);
  }
  return orderedUnique([...advertised, "opus", "sonnet", "haiku"]);
}

function choicesFromHelp(help, flag) {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const section = String(help).match(new RegExp(
    `${escaped} <[^>]+>([\\s\\S]*?)(?:\\n\\s{2}--|\\nCommands:)`,
  ))?.[1] ?? "";
  const parenthesized = section.match(/(?:choices?:|\()\s*([^)]*?)\)/i)?.[1] ?? "";
  return orderedUnique([...parenthesized.matchAll(/["']?([A-Za-z][A-Za-z0-9_-]*)["']?/g)]
    .map((match) => match[1])
    .filter((value) => !["choices", "choice"].includes(value.toLowerCase())));
}

/** Claude Code currently publishes capability choices globally rather than
 * per model. Keep those CLI-advertised rules exact and use local constants only
 * as a compatibility fallback for older help output. */
export function catalogFromClaudeHelp(help, version = null) {
  if (!String(help).trim()) throw new Error("Claude Code CLI help is empty");
  const aliases = claudeAliasesFromHelp(help);
  const efforts = choicesFromHelp(help, "--effort");
  const permissions = choicesFromHelp(help, "--permission-mode");
  const supportedEfforts = efforts.length ? efforts : [...TARGETS.claude.efforts];
  const supportedAccess = orderedUnique([
    "default",
    ...(permissions.length ? permissions : TARGETS.claude.access.filter((value) => value !== "default")),
  ]);
  const defaultEffort = supportedEfforts.includes(TARGETS.claude.defaultEffort)
    ? TARGETS.claude.defaultEffort
    : supportedEfforts[0];
  return {
    models: aliases,
    modelsDetail: aliases.map((slug) => ({
      slug,
      display_name: `Claude ${titleCase(slug)}`,
      description: `Claude Code model alias: ${slug}`,
      reasoning_efforts: [...supportedEfforts],
      default_reasoning_effort: defaultEffort,
    })),
    efforts: supportedEfforts,
    access: supportedAccess,
    defaultModel: "default",
    metadata: {
      source: "claude --help",
      capabilityScope: "Claude Code publishes effort and permission choices globally, not per model",
      claudeVersion: version,
    },
  };
}

function readClaudeCatalog() {
  const help = commandOutput("claude", ["--help"]);
  if (!help) throw new Error("Claude Code CLI 不可用，无法读取模型规则");
  return catalogFromClaudeHelp(help, commandOutput("claude", ["--version"]) || null);
}

function readJsonObject(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function parseTomlString(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) {
    try { return JSON.parse(trimmed); } catch { return null; }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
  return /^[A-Za-z0-9._:-]+$/.test(trimmed) ? trimmed : null;
}

export function readTopLevelTomlConfig(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return {}; }
  const result = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) break;
    const match = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*(?:#.*)?$/);
    if (!match) continue;
    const parsed = parseTomlString(match[2]);
    if (parsed !== null) result[match[1]] = parsed;
  }
  return result;
}

function markerFor(root) {
  return readJsonObject(path.join(root, ".cc-suite", "project.json"));
}

function overrideFile(root) {
  return path.join(root, ".cc-suite", "dispatch-defaults.json");
}

function applyLayer(current, sources, layer, source, fields) {
  if (!layer || typeof layer !== "object") return;
  for (const [output, input] of Object.entries(fields)) {
    const value = layer[input];
    if (typeof value === "string" && value.trim()) {
      current[output] = value.trim();
      sources[output] = source;
    }
  }
}

function resolveCodexConfiguredDefault(cwd, home) {
  const root = resolveWorkspaceRoot(cwd);
  const current = {};
  const sources = {};
  const fields = {
    model: "model",
    effort: "model_reasoning_effort",
    access: "sandbox_mode",
    approval: "approval_policy",
  };
  const userFile = path.join(home, ".codex", "config.toml");
  const projectFile = path.join(root, ".codex", "config.toml");
  applyLayer(current, sources, readTopLevelTomlConfig(userFile), userFile, fields);
  applyLayer(current, sources, readTopLevelTomlConfig(projectFile), projectFile, fields);
  return { current, sources, root };
}

function resolveClaudeConfiguredDefault(cwd, home) {
  const root = resolveWorkspaceRoot(cwd);
  const current = {};
  const sources = {};
  const fields = { model: "model", effort: "effortLevel", access: "permissionMode" };
  const files = [
    path.join(home, ".claude", "settings.json"),
    path.join(root, ".claude", "settings.json"),
    path.join(root, ".claude", "settings.local.json"),
  ];
  for (const file of files) {
    const layer = readJsonObject(file);
    applyLayer(current, sources, layer, file, fields);
    const nestedMode = layer?.permissions?.defaultMode;
    if (typeof nestedMode === "string" && nestedMode.trim()) {
      current.access = nestedMode.trim();
      sources.access = `${file} permissions.defaultMode`;
    }
  }
  return { current, sources, root };
}

function applyDispatchOverrides(target, configured, root) {
  const marker = markerFor(root);
  const scope = typeof marker?.scopeRoot === "string" ? marker.scopeRoot : root;
  const fields = target === "codex"
    ? { model: "model", effort: "effort", access: "access", approval: "approval" }
    : { model: "model", effort: "effort", access: "access" };
  const layers = [...new Set([scope, root])];
  for (const layerRoot of layers) {
    const file = overrideFile(layerRoot);
    const data = readJsonObject(file)?.[target];
    applyLayer(configured.current, configured.sources, data, `${file} (${target})`, fields);
  }
}

function includeClaudeModel(catalog, model) {
  if (catalog.models.includes(model) || model === "default") return;
  catalog.models.unshift(model);
  catalog.modelsDetail.unshift({
    slug: model,
    display_name: model,
    description: "Claude Code configured/full model ID",
    reasoning_efforts: [...TARGETS.claude.efforts],
    default_reasoning_effort: TARGETS.claude.defaultEffort,
  });
}

function sourceSummary(sources) {
  const labels = { model: "模型", effort: "推理", access: "权限", approval: "审批" };
  return Object.entries(sources)
    .filter(([, value]) => value)
    .map(([field, value]) => `${labels[field] ?? field}：${value}`)
    .join("；");
}

export function getDispatchEnvironment(target, cwd, options = {}) {
  if (!Object.hasOwn(TARGETS, target)) throw new Error(`unsupported dispatch target: ${target}`);
  const home = options.home ?? os.homedir();
  const catalog = target === "codex" ? readCodexCatalog(home) : readClaudeCatalog();
  const configured = target === "codex"
    ? resolveCodexConfiguredDefault(cwd, home)
    : resolveClaudeConfiguredDefault(cwd, home);
  applyDispatchOverrides(target, configured, configured.root);

  const model = configured.current.model || catalog.defaultModel;
  if (target === "claude") includeClaudeModel(catalog, model);
  if (target === "codex" && !catalog.models.includes(model)) {
    throw new Error(`Codex 默认模型 ${model} 不在当前模型目录中；来源：${configured.sources.model}`);
  }
  if (model === "default" && target === "claude" && !catalog.models.includes("default")) {
    catalog.models.unshift("default");
    catalog.modelsDetail.unshift({
      slug: "default",
      display_name: "Claude account default (not locally pinned)",
      description: "Claude Code account default; no concrete local model was configured",
      reasoning_efforts: [...TARGETS.claude.efforts],
      default_reasoning_effort: TARGETS.claude.defaultEffort,
    });
  }

  const effort = configured.current.effort
    || defaultEffortForModel(target, model, catalog);
  const access = configured.current.access || TARGETS[target].defaultAccess;
  const config = {
    model,
    effort,
    access,
    ...(target === "codex"
      ? { approval: configured.current.approval || TARGETS.codex.defaultApproval }
      : {}),
  };
  const normalized = validateAgainstCatalog(target, config, catalog);
  const sources = {
    model: configured.sources.model ?? (model === "default" ? "Claude account default (not locally pinned)" : catalog.metadata.source),
    effort: configured.sources.effort ?? `model catalog default for ${model}`,
    access: configured.sources.access ?? `${target} CLI default`,
    ...(target === "codex"
      ? { approval: configured.sources.approval ?? "Codex CLI default" }
      : {}),
  };
  return {
    target,
    cwd: path.resolve(cwd),
    projectRoot: configured.root,
    catalog,
    defaultConfig: normalized,
    defaultSources: sources,
    defaultSource: sourceSummary(sources),
  };
}
