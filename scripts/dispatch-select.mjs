#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describeDispatchConfig } from "./lib/dispatch-config.mjs";
import {
  clearPendingDispatch,
  savePendingDispatch,
} from "./lib/dispatch-state.mjs";
import { runDispatchPicker } from "./dispatch-picker.mjs";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!value || !["--host", "--target", "--cwd", "--session-id"].includes(key)) {
      throw new Error(
        "usage: dispatch-select.mjs --host <codex|claude> --target <claude|codex> --cwd <dir> --session-id <id>",
      );
    }
    args[key.slice(2).replace("session-id", "sessionId")] = value;
  }
  if (!/^(codex|claude)$/.test(args.host) || !/^(codex|claude)$/.test(args.target)) {
    throw new Error("invalid host or target");
  }
  if (args.host === args.target) throw new Error("host and target must differ");
  if (!args.cwd || !args.sessionId) throw new Error("--cwd and --session-id are required");
  return args;
}

export function selectDispatchBeforeSend({ host, target, cwd, sessionId, picker = runDispatchPicker }) {
  clearPendingDispatch(cwd, { host, sessionId });
  const selected = picker({ target, cwd });
  if (selected.cancelled) return { status: "cancelled" };
  const pending = savePendingDispatch(cwd, {
    host,
    target,
    sessionId,
    config: selected.config,
    catalogVersion: selected.catalogVersion,
    selectedProfile: selected.profileId,
  });
  return {
    status: "selected",
    target,
    config: selected.config,
    description: describeDispatchConfig(target, selected.config),
    expiresAt: pending.expiresAt,
  };
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = selectDispatchBeforeSend({
      ...args,
      cwd: path.resolve(args.cwd),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`cc-suite selection: ${error.message}\n`);
    process.exitCode = 1;
  }
}
