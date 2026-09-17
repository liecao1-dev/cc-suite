#!/usr/bin/env node
import process from "node:process";

import { resolveActivatedCliBinary } from "./lib/activated-cli.mjs";

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!["--scope", "--target"].includes(key) || value === undefined) {
      throw new Error("usage: resolve-activated-cli.mjs --scope <path> --target <claude|codex>");
    }
    if (values[key] !== undefined) throw new Error(`${key} may be specified only once`);
    values[key] = value;
  }
  return { scope: values["--scope"], target: values["--target"] };
}

try {
  const args = parseArgs(process.argv.slice(2));
  process.stdout.write(`${resolveActivatedCliBinary(args.scope, args.target)}\n`);
} catch (error) {
  process.stderr.write(`cc-suite activated CLI resolver: ${error.message}\n`);
  process.exitCode = 1;
}
