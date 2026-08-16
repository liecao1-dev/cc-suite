#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  TARGETS,
  buildDispatchProfiles,
  normalizeDispatchConfig,
  readRecentDispatch,
  withRecentDispatch,
} from "./lib/dispatch-config.mjs";
import { getConfig, setConfig } from "./lib/state.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function fail(message, code = 2) {
  process.stderr.write(`cc-suite: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const command = argv[0];
  const values = { command, cwd: process.cwd() };
  for (let i = 1; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) fail(`unexpected argument: ${key}`);
    if (i + 1 >= argv.length) fail(`${key} requires a value`);
    values[key.slice(2)] = argv[++i];
  }
  return values;
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function readCodexCatalog() {
  const result = spawnSync("bash", [path.join(ROOT, "scripts", "codex-preflight.sh")], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error(result.stderr.trim() || "Codex preflight produced no result");
  }
  const preflight = JSON.parse(result.stdout.trim().split("\n").at(-1));
  if (preflight.status !== "ok") {
    const error = new Error(preflight.error || "Codex is not ready");
    error.code = preflight.error_code;
    throw error;
  }
  if (!Array.isArray(preflight.models) || preflight.models.length === 0) {
    throw new Error("No Codex models are currently available");
  }
  return {
    models: preflight.models,
    modelsDetail: preflight.models_detail ?? [],
    efforts: preflight.reasoning_efforts ?? TARGETS.codex.efforts,
    access: preflight.sandbox_levels ?? TARGETS.codex.access,
    defaultModel: preflight.default_model || preflight.models[0],
    metadata: {
      codexVersion: preflight.codex_version,
      authMode: preflight.auth_mode,
    },
  };
}

function readClaudeCatalog() {
  return {
    models: ["default", "sonnet", "opus", "haiku"],
    modelsDetail: [
      { slug: "default", display_name: "Claude 默认模型", description: "Use Claude Code's configured default." },
      { slug: "sonnet", display_name: "Claude Sonnet" },
      { slug: "opus", display_name: "Claude Opus" },
      { slug: "haiku", display_name: "Claude Haiku" },
    ],
    efforts: [...TARGETS.claude.efforts],
    access: [...TARGETS.claude.access],
    defaultModel: "default",
    metadata: { source: "claude-octopus MCP tool schema" },
  };
}

function catalogFor(target) {
  if (target === "codex") return readCodexCatalog();
  if (target === "claude") return readClaudeCatalog();
  fail(`unsupported target: ${target}`);
}

function defaultConfig(target, catalog) {
  const detail = catalog.modelsDetail.find((entry) => entry.slug === catalog.defaultModel);
  const supportedEfforts = detail?.reasoning_efforts?.length
    ? detail.reasoning_efforts
    : catalog.efforts;
  const preferredEffort = TARGETS[target].defaultEffort;
  return {
    model: catalog.defaultModel,
    effort: supportedEfforts.includes(preferredEffort)
      ? preferredEffort
      : (supportedEfforts[0] ?? preferredEffort),
    access: TARGETS[target].defaultAccess,
  };
}

function configureStateRoot(cwd) {
  // Both Claude and Codex must see the same per-project MRU state. Keep it
  // local, private, and ignored instead of relying on either host's process env.
  process.env.CLAUDE_PLUGIN_DATA =
    process.env.CC_SUITE_STATE_ROOT || path.join(cwd, ".cc-suite", "runtime");
}

function validateAgainstCatalog(target, config, catalog) {
  if (target === "codex" && !catalog.models.includes(config.model)) {
    throw new Error(`Codex model is not in the current catalog: ${config.model}`);
  }
  const detail = catalog.modelsDetail.find((entry) => entry.slug === config.model);
  return normalizeDispatchConfig(target, config, {
    efforts: detail?.reasoning_efforts?.length ? detail.reasoning_efforts : catalog.efforts,
    access: catalog.access,
  });
}

function resolveProfile(target, profileId, catalog, cwd) {
  const fallback = defaultConfig(target, catalog);
  let config;
  let resolvedFrom = profileId;
  let usedInitialDefault = false;

  if (profileId === "recent") {
    const recent = readRecentDispatch(getConfig(cwd), target);
    if (recent) {
      try {
        config = validateAgainstCatalog(target, recent, catalog);
      } catch {
        // A removed model or capability must not leave the quick picker stuck.
        // Treat stale state exactly like a first use and make the fallback
        // visible in the machine-readable result.
      }
    }
    if (!config) {
      config = validateAgainstCatalog(target, fallback, catalog);
      resolvedFrom = "default";
      usedInitialDefault = true;
    }
  } else if (profileId === "default") {
    config = validateAgainstCatalog(target, fallback, catalog);
  } else if (profileId.startsWith("model:")) {
    const model = profileId.slice("model:".length);
    if (!catalog.models.includes(model)) {
      throw new Error(`${target} model is not in the current catalog: ${model}`);
    }
    const detail = catalog.modelsDetail.find((entry) => entry.slug === model);
    const supportedEfforts = detail?.reasoning_efforts?.length
      ? detail.reasoning_efforts
      : catalog.efforts;
    const preferredEffort = TARGETS[target].defaultEffort;
    config = validateAgainstCatalog(target, {
      model,
      effort: supportedEfforts.includes(preferredEffort)
        ? preferredEffort
        : (supportedEfforts[0] ?? preferredEffort),
      access: TARGETS[target].defaultAccess,
    }, catalog);
  } else {
    throw new Error(`unsupported profile: ${profileId}`);
  }

  return { config, resolvedFrom, usedInitialDefault };
}

const args = parseArgs(process.argv.slice(2));
if (!args.command || !["list", "resolve", "record", "recent"].includes(args.command)) {
  fail("usage: dispatch-config.mjs <list|resolve|record|recent> --target <codex|claude> [--cwd <dir>] ...");
}
if (!args.target) fail("--target is required");
if (!Object.hasOwn(TARGETS, args.target)) fail(`unsupported target: ${args.target}`);

const cwd = path.resolve(args.cwd);
if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) fail(`not a directory: ${cwd}`);
configureStateRoot(cwd);

if (args.command === "recent") {
  output({ target: args.target, recent: readRecentDispatch(getConfig(cwd), args.target) });
  process.exit(0);
}

let catalog;
try {
  catalog = catalogFor(args.target);
} catch (error) {
  output({ status: "error", target: args.target, errorCode: error.code ?? "preflight_failed", error: error.message });
  process.exit(0);
}

if (args.command === "list") {
  try {
    const recent = readRecentDispatch(getConfig(cwd), args.target);
    const built = buildDispatchProfiles({
      target: args.target,
      recent,
      defaultConfig: defaultConfig(args.target, catalog),
      catalog,
    });
    output({
      status: "ok",
      target: args.target,
      selectionRequired: true,
      autoSelect: false,
      ...built,
      capabilities: {
        models: catalog.models,
        modelsDetail: catalog.modelsDetail,
        efforts: catalog.efforts,
        access: catalog.access,
      },
      metadata: catalog.metadata,
    });
  } catch (error) {
    output({ status: "error", target: args.target, errorCode: "config_list_failed", error: error.message });
  }
  process.exit(0);
}

if (args.command === "resolve") {
  if (!args.profile) fail("--profile is required");
  try {
    const resolved = resolveProfile(args.target, args.profile, catalog, cwd);
    output({
      status: "ok",
      target: args.target,
      profile: args.profile,
      ...resolved,
      metadata: catalog.metadata,
    });
  } catch (error) {
    output({
      status: "error",
      target: args.target,
      errorCode: "profile_resolution_failed",
      error: error.message,
    });
  }
  process.exit(0);
}

try {
  const chosen = validateAgainstCatalog(args.target, {
    model: args.model,
    effort: args.effort,
    access: args.access,
  }, catalog);
  const next = withRecentDispatch(getConfig(cwd), args.target, chosen);
  setConfig(cwd, "recentDispatch", next.recentDispatch);
  output({ status: "ok", target: args.target, recorded: chosen });
} catch (error) {
  output({ status: "error", target: args.target, errorCode: "invalid_config", error: error.message });
}
