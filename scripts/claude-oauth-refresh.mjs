#!/usr/bin/env node
import process from "node:process";

import { ensureClaudeOAuthFresh } from "./lib/claude-oauth-refresh.mjs";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (argv[index] !== "--scope" || !argv[index + 1]) {
      throw new Error("usage: claude-oauth-refresh.mjs --scope <path>");
    }
    args.scopeRoot = argv[index + 1];
  }
  if (!args.scopeRoot) throw new Error("--scope is required");
  return args;
}

try {
  const result = ensureClaudeOAuthFresh(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ status: "failed", error: error.message })}\n`);
  process.exitCode = 1;
}

