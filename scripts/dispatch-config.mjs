#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

import {
  TARGETS,
  buildDispatchProfiles,
  validateAgainstCatalog,
} from "./lib/dispatch-config.mjs";
import { getDispatchEnvironment } from "./lib/dispatch-catalog.mjs";
import { recentDispatchRecord, recordRecentDispatch } from "./lib/dispatch-state.mjs";

function fail(message, code = 2) {
  process.stderr.write(`cc-suite: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const command = argv[0];
  const values = { command, cwd: process.cwd() };
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) fail(`invalid argument: ${key}`);
    values[key.slice(2)] = value;
  }
  return values;
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const args = parseArgs(process.argv.slice(2));
if (!args.command || !["list", "resolve", "record", "recent", "validate"].includes(args.command)) {
  fail("usage: dispatch-config.mjs <list|resolve|record|recent|validate> --target <codex|claude> [--cwd <dir>] ...");
}
if (!Object.hasOwn(TARGETS, args.target)) fail(`unsupported target: ${args.target}`);
const cwd = path.resolve(args.cwd);
if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) fail(`not a directory: ${cwd}`);

let environment;
try {
  environment = getDispatchEnvironment(args.target, cwd);
} catch (error) {
  output({ status: "error", target: args.target, errorCode: "catalog_failed", error: error.message });
  process.exit(0);
}

if (args.command === "recent") {
  output({ status: "ok", target: args.target, recent: recentDispatchRecord(cwd, args.target) });
  process.exit(0);
}

const recent = recentDispatchRecord(cwd, args.target);
const built = buildDispatchProfiles({
  target: args.target,
  recent,
  defaultConfig: environment.defaultConfig,
  defaultSource: environment.defaultSource,
  catalog: environment.catalog,
});

if (args.command === "list") {
  output({
    status: "ok",
    target: args.target,
    selectionRequired: true,
    autoSelect: false,
    ...built,
    defaultConfig: environment.defaultConfig,
    defaultSources: environment.defaultSources,
    capabilities: {
      models: environment.catalog.models,
      modelsDetail: environment.catalog.modelsDetail,
      efforts: environment.catalog.efforts,
      access: environment.catalog.access,
      ...(args.target === "codex" ? { approvals: environment.catalog.approvals } : {}),
    },
    metadata: environment.catalog.metadata,
  });
  process.exit(0);
}

if (args.command === "resolve") {
  const row = built.profiles.find((profile) => profile.id === args.profile);
  if (!row?.config) {
    output({ status: "error", target: args.target, errorCode: "profile_resolution_failed", error: `unsupported profile: ${args.profile}` });
  } else {
    output({
      status: "ok",
      target: args.target,
      profile: args.profile,
      config: row.config,
      resolvedFrom: row.resolvesTo ?? args.profile,
      usedInitialDefault: row.resolvesTo === "default",
      defaultSources: environment.defaultSources,
      metadata: environment.catalog.metadata,
    });
  }
  process.exit(0);
}

try {
  const config = validateAgainstCatalog(args.target, {
    model: args.model,
    effort: args.effort,
    access: args.access,
    ...(args.target === "codex" ? { approval: args.approval } : {}),
  }, environment.catalog);
  if (args.command === "record") recordRecentDispatch(cwd, args.target, config);
  output({
    status: "ok",
    target: args.target,
    [args.command === "record" ? "recorded" : "validated"]: config,
  });
} catch (error) {
  output({ status: "error", target: args.target, errorCode: "invalid_config", error: error.message });
}
