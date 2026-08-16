#!/usr/bin/env node
// Install, inspect, repair, or remove the lightweight dispatch surface for
// every actual project root under a bounded directory.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  catalogFromModelsCache,
  discoverProjectRoots,
  inspectProjectDispatch,
  installProjectDispatch,
  isWithin,
  removeManagedLauncher,
  removeProjectDispatch,
  writeManagedLauncher,
} from "./lib/project-dispatch.mjs";
import {
  inspectComposerActivation,
  repairComposerActivation,
} from "./lib/composer-activation.mjs";

const SOURCE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const COMMANDS = new Set(["sync", "status", "remove", "list"]);

function fail(message, code = 2) {
  process.stderr.write(`cc-suite: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const args = { command: "sync", source: SOURCE_ROOT, json: false };
  let index = 0;
  if (argv[0] && !argv[0].startsWith("--")) {
    args.command = argv[0];
    index = 1;
  }
  if (!COMMANDS.has(args.command)) fail(`unknown command: ${args.command}`);
  while (index < argv.length) {
    const key = argv[index++];
    if (key === "--json") {
      args.json = true;
      continue;
    }
    if (!["--scope", "--project", "--source", "--catalog-file"].includes(key)) {
      fail(`unexpected argument: ${key}`);
    }
    if (index >= argv.length || argv[index].startsWith("--")) fail(`${key} requires a value`);
    args[key.slice(2).replace("catalog-file", "catalogFile")] = argv[index++];
  }
  if (!args.scope) fail("--scope is required");
  return args;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`cannot read JSON ${file}: ${error.message}`);
  }
}

function loadCatalog(file) {
  const payload = readJson(file ?? path.join(os.homedir(), ".codex", "models_cache.json"));
  if (
    Array.isArray(payload?.models)
    && payload.models.every((model) => typeof model === "string")
    && Array.isArray(payload?.modelsDetail)
    && typeof payload?.defaultModel === "string"
  ) return payload;
  return catalogFromModelsCache(payload);
}

function summarizeResult(result) {
  const changed = result.created.length + result.updated.length + result.removed.length;
  return {
    root: result.root,
    changed,
    created: result.created,
    updated: result.updated,
    removed: result.removed,
    conflicts: result.conflicts,
  };
}

function printHuman(command, scope, roots, results, launcher, activation) {
  process.stdout.write(`cc-suite ${command}: ${scope}\n`);
  process.stdout.write(`projects: ${roots.length}\n`);
  for (const result of results) {
    if (result.error) {
      process.stdout.write(`! ${result.root}: ${result.error}\n`);
      continue;
    }
    if (Object.hasOwn(result, "ok")) {
      process.stdout.write(`${result.ok ? "✓" : "!"} ${result.root}${result.problems.length ? ` — ${result.problems.join("; ")}` : ""}\n`);
      continue;
    }
    const summary = summarizeResult(result);
    process.stdout.write(`${summary.conflicts.length ? "!" : "✓"} ${summary.root} — ${summary.changed} change(s)\n`);
    for (const conflict of summary.conflicts) process.stdout.write(`    ! ${conflict}\n`);
  }
  if (launcher) process.stdout.write(`launcher: ${launcher}\n`);
  if (activation) {
    process.stdout.write(`${activation.ok ? "✓" : "!"} composer pre-send proxy${activation.problems?.length ? ` — ${activation.problems.join("; ")}` : ""}\n`);
  }
}

const args = parseArgs(process.argv.slice(2));
const scope = fs.realpathSync.native(path.resolve(args.scope));
const source = fs.realpathSync.native(path.resolve(args.source));
let roots;
if (args.project) {
  const project = fs.realpathSync.native(path.resolve(args.project));
  if (!isWithin(scope, project)) fail(`project is outside scope: ${project}`);
  roots = [project];
} else {
  roots = discoverProjectRoots(scope);
}

if (args.command === "list") {
  const output = { command: args.command, scope, roots };
  if (args.json) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  else roots.forEach((root) => process.stdout.write(`${root}\n`));
  process.exit(0);
}

let launcher = null;
let activation = null;
const results = [];
let catalog = null;
if (args.command === "sync") {
  try {
    catalog = loadCatalog(args.catalogFile);
  } catch (error) {
    // The exact discovery skills and hooks are model-agnostic. A missing
    // runtime catalog must not prevent project coverage; the pre-send picker
    // reads and validates the live catalog when the user selects /codex.
    if (args.catalogFile) fail(error.message, 1);
    catalog = null;
  }
}

for (const root of roots) {
  try {
    if (args.command === "sync") {
      results.push(installProjectDispatch({ root, scopeRoot: scope, sourceRoot: source, catalog }));
    } else if (args.command === "remove") {
      results.push(removeProjectDispatch({ root, scopeRoot: scope, sourceRoot: source }));
    } else {
      results.push(inspectProjectDispatch({ root, sourceRoot: source }));
    }
  } catch (error) {
    results.push({ root, error: error.message });
  }
}

try {
  if (args.command === "sync" && !args.project) launcher = writeManagedLauncher(scope, source);
  if (args.command === "remove" && !args.project && removeManagedLauncher(scope)) {
    launcher = "removed";
  }
} catch (error) {
  results.push({ root: scope, error: `launcher: ${error.message}` });
}

try {
  if (args.command === "sync" && !args.project) repairComposerActivation(scope);
  if (args.command === "sync" || args.command === "status") {
    activation = inspectComposerActivation(scope);
  }
} catch (error) {
  results.push({ root: scope, error: `composer activation: ${error.message}` });
}

const output = {
  command: args.command,
  scope,
  source,
  roots,
  launcher,
  activation,
  catalog: catalog ? { defaultModel: catalog.defaultModel, models: catalog.models } : undefined,
  results: results.map((result) => result.error || Object.hasOwn(result, "ok") ? result : summarizeResult(result)),
};
if (args.json) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
else printHuman(args.command, scope, roots, results, launcher, activation);

if (
  results.some((result) => result.error || result.ok === false || result.conflicts?.length)
  || (args.command === "status" && activation?.ok === false)
) {
  process.exitCode = 1;
}
