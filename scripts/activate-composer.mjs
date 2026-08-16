#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  inspectComposerActivation,
  installComposerActivation,
  removeComposerActivation,
} from "./lib/composer-activation.mjs";

const SOURCE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const COMMANDS = new Set(["install", "status", "remove"]);

function parseArgs(argv) {
  const args = { command: "install", source: SOURCE_ROOT, json: false };
  let index = 0;
  if (argv[0] && !argv[0].startsWith("--")) args.command = argv[index++];
  if (!COMMANDS.has(args.command)) throw new Error(`unknown command: ${args.command}`);
  while (index < argv.length) {
    const key = argv[index++];
    if (key === "--json") {
      args.json = true;
      continue;
    }
    if (!["--scope", "--source", "--shell-file", "--real-codex", "--real-claude"].includes(key)) {
      throw new Error(`unexpected argument: ${key}`);
    }
    if (index >= argv.length || argv[index].startsWith("--")) throw new Error(`${key} requires a value`);
    args[key.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = argv[index++];
  }
  if (!args.scope) throw new Error("--scope is required");
  return args;
}

function print(value, json) {
  if (json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else if (value.ok !== undefined) {
    process.stdout.write(`${value.ok ? "✓" : "!"} cc-suite composer activation\n`);
    for (const problem of value.problems ?? []) process.stdout.write(`  ! ${problem}\n`);
  } else {
    for (const file of value.changed ?? value.removed ?? []) process.stdout.write(`${file}\n`);
  }
}

try {
  const args = parseArgs(process.argv.slice(2));
  let result;
  if (args.command === "install") {
    result = installComposerActivation({
      scopeRoot: args.scope,
      sourceRoot: args.source,
      shellFile: args.shellFile,
      codexBinary: args.realCodex,
      claudeBinary: args.realClaude,
    });
  } else if (args.command === "remove") {
    result = removeComposerActivation(args.scope);
  } else {
    result = inspectComposerActivation(args.scope);
    if (!result.ok) process.exitCode = 1;
  }
  print(result, args.json);
} catch (error) {
  process.stderr.write(`cc-suite composer activation: ${error.message}\n`);
  process.exitCode = 1;
}
