import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { pathIsWithin } from "./scoped-dispatch.mjs";

const MANAGED_BY = "cc-suite";
const SCHEMA = 1;
const LAUNCHER_NAME = "cc-suite-dispatch-hook";
const LAUNCHER_MARKER = /^# cc-suite-managed-dispatch-hook sha256=([0-9a-f]{64})$/m;
const PROGRAMMATIC_LAUNCHER_NAME = "cc-suite-dispatch";
const PROGRAMMATIC_LAUNCHER_MARKER = /^# cc-suite-managed-programmatic-dispatch sha256=([0-9a-f]{64})$/m;

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function writeAtomic(file, content, mode = 0o600) {
  const directory = path.dirname(file);
  const temporary = path.join(directory, `.${path.basename(file)}.cc-suite-${process.pid}-${Math.random().toString(36).slice(2)}`);
  try {
    fs.writeFileSync(temporary, content, { encoding: "utf8", mode });
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function ensureRealDirectory(directory, boundary = null) {
  const resolved = path.resolve(directory);
  if (boundary && !pathIsWithin(boundary, resolved)) {
    throw new Error(`refusing directory outside boundary: ${resolved}`);
  }
  const stat = fs.lstatSync(resolved, { throwIfNoEntry: false });
  if (stat) {
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`${resolved} is not a real directory`);
    }
    return;
  }
  ensureRealDirectory(path.dirname(resolved), boundary);
  fs.mkdirSync(resolved, { mode: 0o700 });
}

function launcherPath(scopeRoot) {
  return path.join(scopeRoot, ".cc-suite", "bin", LAUNCHER_NAME);
}

function programmaticLauncherPath(scopeRoot) {
  return path.join(scopeRoot, ".cc-suite", "bin", PROGRAMMATIC_LAUNCHER_NAME);
}

function manifestPath(scopeRoot) {
  return path.join(scopeRoot, ".cc-suite", "user-dispatch.json");
}

function launcherBody({ scopeRoot, sourceRoot }) {
  return [
    "#!/usr/bin/env bash",
    `export CC_SUITE_SCOPE_ROOT=${shellQuote(scopeRoot)}`,
    `export CLAUDE_PLUGIN_DATA=${shellQuote(path.join(scopeRoot, ".cc-suite", "runtime"))}`,
    `exec node ${shellQuote(path.join(sourceRoot, "scripts", "dispatch-hook.mjs"))} "$@"`,
    "",
  ].join("\n");
}

function programmaticLauncherBody({ scopeRoot, sourceRoot }) {
  return [
    "#!/usr/bin/env bash",
    `export CC_SUITE_SCOPE_ROOT=${shellQuote(scopeRoot)}`,
    `export CLAUDE_PLUGIN_DATA=${shellQuote(path.join(scopeRoot, ".cc-suite", "runtime"))}`,
    // The stable launcher exposes only the strict compatibility adapter. The
    // state-writing dispatcher itself is broker-internal and requires a
    // one-use grant that callers cannot mint.
    `exec node ${shellQuote(path.join(sourceRoot, "scripts", "direct-inference-request.mjs"))} "$@"`,
    "",
  ].join("\n");
}

export function managedHookLauncher(options) {
  const body = launcherBody(options);
  const firstNewline = body.indexOf("\n") + 1;
  return `${body.slice(0, firstNewline)}# cc-suite-managed-dispatch-hook sha256=${sha256(body)}\n${body.slice(firstNewline)}`;
}

export function hookLauncherIsOwned(text) {
  const match = text.match(LAUNCHER_MARKER);
  if (!match) return false;
  const start = match.index;
  let end = start + match[0].length;
  if (text[end] === "\n") end += 1;
  return sha256(text.slice(0, start) + text.slice(end)) === match[1];
}

export function managedProgrammaticLauncher(options) {
  const body = programmaticLauncherBody(options);
  const firstNewline = body.indexOf("\n") + 1;
  return `${body.slice(0, firstNewline)}# cc-suite-managed-programmatic-dispatch sha256=${sha256(body)}\n${body.slice(firstNewline)}`;
}

export function programmaticLauncherIsOwned(text) {
  const match = text.match(PROGRAMMATIC_LAUNCHER_MARKER);
  if (!match) return false;
  const start = match.index;
  let end = start + match[0].length;
  if (text[end] === "\n") end += 1;
  return sha256(text.slice(0, start) + text.slice(end)) === match[1];
}

export function stableDispatchCommand(scopeRoot, host) {
  const pair = host === "codex"
    ? "--host codex --target claude"
    : host === "claude"
      ? "--host claude --target codex"
      : null;
  if (!pair) throw new Error(`unsupported host: ${host}`);
  return `${shellQuote(launcherPath(path.resolve(scopeRoot)))} ${pair}`;
}

function readManifest(scopeRoot) {
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath(scopeRoot), "utf8"));
    if (parsed?.managedBy === MANAGED_BY && parsed?.schema === SCHEMA) return parsed;
  } catch {}
  return null;
}

function readJsonObject(file) {
  if (!fs.existsSync(file)) return { data: {}, text: null };
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`${file} is a symlink; preserved`);
  const text = fs.readFileSync(file, "utf8");
  let data;
  try { data = JSON.parse(text); } catch {
    throw new Error(`${file} is invalid JSON; preserved`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`${file} is not a JSON object; preserved`);
  }
  if (data.hooks !== undefined && (!data.hooks || typeof data.hooks !== "object" || Array.isArray(data.hooks))) {
    throw new Error(`${file} has a non-object hooks field; preserved`);
  }
  return { data, text };
}

function cleanHookGroups(groups, handlerMatches) {
  if (!Array.isArray(groups)) throw new Error("hook event has an unsupported shape; preserved");
  const cleaned = [];
  for (const group of groups) {
    if (!group || typeof group !== "object" || !Array.isArray(group.hooks)) {
      throw new Error("hook group has an unsupported shape; preserved");
    }
    const hooks = group.hooks.filter((handler) => !handlerMatches(handler));
    if (hooks.length) cleaned.push({ ...group, hooks });
  }
  return cleaned;
}

function legacyCommands(sourceRoots, host) {
  return new Set(sourceRoots.filter(Boolean).map((sourceRoot) => {
    const script = path.join(sourceRoot, "scripts", "dispatch-hook.mjs");
    return `node ${shellQuote(script)} ${host === "codex" ? "--host codex --target claude" : "--host claude --target codex"}`;
  }));
}

function managedCommands({ scopeRoot, sourceRoots, host }) {
  return new Set([stableDispatchCommand(scopeRoot, host), ...legacyCommands(sourceRoots, host)]);
}

function handlerMatches(commands, handler) {
  return handler?.type === "command"
    && typeof handler.command === "string"
    && commands.has(handler.command);
}

function installManagedHandler(groups, {
  commands,
  stableCommand,
  expectedHandler,
  expectedMatcher,
}) {
  if (!Array.isArray(groups)) throw new Error("hook event has an unsupported shape; preserved");
  let installed = false;
  const updated = [];
  for (const group of groups) {
    if (!group || typeof group !== "object" || !Array.isArray(group.hooks)) {
      throw new Error("hook group has an unsupported shape; preserved");
    }
    const nextHooks = [];
    let keptStableInGroup = false;
    for (const handler of group.hooks) {
      if (!handlerMatches(commands, handler)) {
        nextHooks.push(handler);
        continue;
      }
      if (!installed && handler.command === stableCommand) {
        nextHooks.push(expectedHandler);
        installed = true;
        keptStableInGroup = true;
      }
      // Drop legacy definitions and duplicate stable definitions.
    }
    if (!nextHooks.length) continue;
    updated.push(keptStableInGroup && expectedMatcher !== undefined
      ? { ...group, matcher: expectedMatcher, hooks: nextHooks }
      : { ...group, hooks: nextHooks });
  }
  if (!installed) {
    updated.push({
      ...(expectedMatcher !== undefined ? { matcher: expectedMatcher } : {}),
      hooks: [expectedHandler],
    });
  }
  return updated;
}

function installCodexHooks({ scopeRoot, sourceRoots, homeRoot }) {
  const directory = path.join(homeRoot, ".codex");
  ensureRealDirectory(directory);
  const file = path.join(directory, "hooks.json");
  const { data, text } = readJsonObject(file);
  const hooks = { ...(data.hooks ?? {}) };
  const commands = managedCommands({ scopeRoot, sourceRoots, host: "codex" });
  const stableCommand = stableDispatchCommand(scopeRoot, "codex");
  for (const event of ["UserPromptSubmit", "Stop"]) {
    hooks[event] = installManagedHandler(hooks[event] ?? [], {
      commands,
      stableCommand,
      expectedHandler: {
        type: "command",
        command: stableCommand,
        timeout: 300,
        ...(event === "UserPromptSubmit" ? { additionalContextLimit: 0 } : {}),
      },
    });
  }
  const next = {
    ...data,
    ...(text === null ? { description: "User-level hooks; cc-suite dispatch is scope-gated at runtime." } : {}),
    hooks,
  };
  const generated = `${JSON.stringify(next, null, 2)}\n`;
  if (generated === text) return { file, changed: false };
  writeAtomic(file, generated, text === null ? 0o600 : fs.statSync(file).mode & 0o777);
  return { file, changed: true };
}

function installClaudeHooks({ scopeRoot, sourceRoots, homeRoot }) {
  const directory = path.join(homeRoot, ".claude");
  ensureRealDirectory(directory);
  const file = path.join(directory, "settings.json");
  const { data, text } = readJsonObject(file);
  const hooks = { ...(data.hooks ?? {}) };
  const commands = managedCommands({ scopeRoot, sourceRoots, host: "claude" });
  const stableCommand = stableDispatchCommand(scopeRoot, "claude");
  for (const event of ["UserPromptSubmit", "UserPromptExpansion"]) {
    hooks[event] = installManagedHandler(hooks[event] ?? [], {
      commands,
      stableCommand,
      expectedMatcher: event === "UserPromptExpansion" ? "^codex$" : undefined,
      expectedHandler: {
        type: "command",
        command: stableCommand,
        timeout: 300,
      },
    });
  }
  const generated = `${JSON.stringify({ ...data, hooks }, null, 2)}\n`;
  if (generated === text) return { file, changed: false };
  writeAtomic(file, generated, text === null ? 0o600 : fs.statSync(file).mode & 0o777);
  return { file, changed: true };
}

function removeHooks(file, commandsByEvent) {
  if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink()) return false;
  const { data, text } = readJsonObject(file);
  const hooks = { ...(data.hooks ?? {}) };
  let matched = false;
  for (const [event, commands] of Object.entries(commandsByEvent)) {
    const before = JSON.stringify(hooks[event] ?? []);
    const groups = cleanHookGroups(hooks[event] ?? [], (handler) => handlerMatches(commands, handler));
    if (JSON.stringify(groups) !== before) matched = true;
    if (groups.length) hooks[event] = groups;
    else delete hooks[event];
  }
  if (!matched) return false;
  const next = { ...data, hooks };
  if (!Object.keys(hooks).length) delete next.hooks;
  if (next.description === "User-level hooks; cc-suite dispatch is scope-gated at runtime.") delete next.description;
  if (!Object.keys(next).length) fs.unlinkSync(file);
  else writeAtomic(file, `${JSON.stringify(next, null, 2)}\n`, fs.statSync(file).mode & 0o777);
  return true;
}

export function installUserDispatch({ scopeRoot, sourceRoot, homeRoot = os.homedir() }) {
  const scope = fs.realpathSync.native(path.resolve(scopeRoot));
  const source = fs.realpathSync.native(path.resolve(sourceRoot));
  const home = fs.realpathSync.native(path.resolve(homeRoot));
  const previous = readManifest(scope);
  const sourceRoots = [source, previous?.sourceRoot];
  const bin = path.join(scope, ".cc-suite", "bin");
  ensureRealDirectory(bin, scope);
  ensureRealDirectory(path.join(scope, ".cc-suite", "runtime"), scope);

  const file = manifestPath(scope);
  if (fs.existsSync(file) && !previous) {
    throw new Error(`${file} is user-owned; user dispatch manifest preserved`);
  }

  const launcher = launcherPath(scope);
  const generatedLauncher = managedHookLauncher({ scopeRoot: scope, sourceRoot: source });
  if (fs.existsSync(launcher) && !hookLauncherIsOwned(fs.readFileSync(launcher, "utf8"))) {
    throw new Error(`${launcher} is user-owned; dispatch hook launcher preserved`);
  }
  const programmaticLauncher = programmaticLauncherPath(scope);
  const generatedProgrammaticLauncher = managedProgrammaticLauncher({ scopeRoot: scope, sourceRoot: source });
  if (
    fs.existsSync(programmaticLauncher)
    && !programmaticLauncherIsOwned(fs.readFileSync(programmaticLauncher, "utf8"))
  ) {
    throw new Error(`${programmaticLauncher} is user-owned; programmatic dispatch launcher preserved`);
  }

  const changed = [];
  if (!fs.existsSync(launcher) || fs.readFileSync(launcher, "utf8") !== generatedLauncher) {
    writeAtomic(launcher, generatedLauncher, 0o755);
    changed.push(launcher);
  }
  if (
    !fs.existsSync(programmaticLauncher)
    || fs.readFileSync(programmaticLauncher, "utf8") !== generatedProgrammaticLauncher
  ) {
    writeAtomic(programmaticLauncher, generatedProgrammaticLauncher, 0o755);
    changed.push(programmaticLauncher);
  }
  const codex = installCodexHooks({ scopeRoot: scope, sourceRoots, homeRoot: home });
  const claude = installClaudeHooks({ scopeRoot: scope, sourceRoots, homeRoot: home });
  if (codex.changed) changed.push(codex.file);
  if (claude.changed) changed.push(claude.file);

  const manifest = {
    schema: SCHEMA,
    managedBy: MANAGED_BY,
    scopeRoot: scope,
    sourceRoot: source,
    homeRoot: home,
    launcher,
    programmaticLauncher,
    codexHooks: codex.file,
    claudeSettings: claude.file,
  };
  const generatedManifest = `${JSON.stringify(manifest, null, 2)}\n`;
  if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== generatedManifest) {
    writeAtomic(file, generatedManifest, 0o600);
    changed.push(file);
  }
  return {
    scope,
    source,
    home,
    launcher,
    programmaticLauncher,
    codexHooks: codex.file,
    claudeSettings: claude.file,
    changed,
  };
}

export function inspectUserDispatch(scopeRoot) {
  const scope = fs.realpathSync.native(path.resolve(scopeRoot));
  const manifest = readManifest(scope);
  const problems = [];
  if (!manifest) return { ok: false, problems: ["user dispatch manifest missing"] };
  if (manifest.scopeRoot !== scope) problems.push("user dispatch scope mismatch");
  let launcherText = "";
  try { launcherText = fs.readFileSync(manifest.launcher, "utf8"); } catch {}
  const expectedLauncher = managedHookLauncher({ scopeRoot: scope, sourceRoot: manifest.sourceRoot });
  if (!hookLauncherIsOwned(launcherText) || launcherText !== expectedLauncher) {
    problems.push("stable dispatch hook launcher missing, stale, or user-owned");
  }
  const expectedProgrammaticPath = programmaticLauncherPath(scope);
  let programmaticText = "";
  try { programmaticText = fs.readFileSync(expectedProgrammaticPath, "utf8"); } catch {}
  const expectedProgrammatic = managedProgrammaticLauncher({
    scopeRoot: scope,
    sourceRoot: manifest.sourceRoot,
  });
  if (manifest.programmaticLauncher !== expectedProgrammaticPath) {
    problems.push("programmatic dispatch launcher path is missing or invalid");
  }
  if (
    !programmaticLauncherIsOwned(programmaticText)
    || programmaticText !== expectedProgrammatic
    || !(fs.statSync(expectedProgrammaticPath, { throwIfNoEntry: false })?.mode & 0o111)
  ) {
    problems.push("stable programmatic dispatch launcher missing, stale, or user-owned");
  }
  for (const [host, file, events] of [
    ["codex", manifest.codexHooks, ["UserPromptSubmit", "Stop"]],
    ["claude", manifest.claudeSettings, ["UserPromptSubmit", "UserPromptExpansion"]],
  ]) {
    try {
      const data = readJsonObject(file).data;
      const command = stableDispatchCommand(scope, host);
      for (const event of events) {
        const count = (data.hooks?.[event] ?? []).flatMap((group) => group?.hooks ?? [])
          .filter((handler) => handler?.type === "command" && handler.command === command).length;
        if (count !== 1) problems.push(`${host} user-level ${event} dispatch hook is missing or duplicated`);
      }
    } catch (error) {
      problems.push(error.message);
    }
  }
  return { ok: problems.length === 0, problems, manifest };
}

export function removeUserDispatch(scopeRoot) {
  const scope = fs.realpathSync.native(path.resolve(scopeRoot));
  const manifest = readManifest(scope);
  if (!manifest) return { removed: [] };
  if (fs.existsSync(manifest.launcher)) {
    const text = fs.readFileSync(manifest.launcher, "utf8");
    if (!hookLauncherIsOwned(text)) throw new Error(`${manifest.launcher} was edited; preserved`);
  }
  let programmaticLauncher = null;
  if (manifest.programmaticLauncher) {
    programmaticLauncher = programmaticLauncherPath(scope);
    if (manifest.programmaticLauncher !== programmaticLauncher) {
      throw new Error("programmatic dispatch launcher path is invalid; preserved");
    }
    if (
      fs.existsSync(programmaticLauncher)
      && !programmaticLauncherIsOwned(fs.readFileSync(programmaticLauncher, "utf8"))
    ) {
      throw new Error(`${programmaticLauncher} was edited; preserved`);
    }
  }
  const runtime = path.join(scope, ".cc-suite", "runtime");
  if (fs.existsSync(runtime)) {
    const stat = fs.lstatSync(runtime);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`${runtime} is not a real directory; centralized state preserved`);
    }
  }
  const sourceRoots = [manifest.sourceRoot];
  const removed = [];
  const codexCommands = managedCommands({ scopeRoot: scope, sourceRoots, host: "codex" });
  if (removeHooks(manifest.codexHooks, { UserPromptSubmit: codexCommands, Stop: codexCommands })) {
    removed.push(manifest.codexHooks);
  }
  const claudeCommands = managedCommands({ scopeRoot: scope, sourceRoots, host: "claude" });
  if (removeHooks(manifest.claudeSettings, { UserPromptSubmit: claudeCommands, UserPromptExpansion: claudeCommands })) {
    removed.push(manifest.claudeSettings);
  }
  if (fs.existsSync(manifest.launcher)) {
    fs.unlinkSync(manifest.launcher);
    removed.push(manifest.launcher);
  }
  if (programmaticLauncher && fs.existsSync(programmaticLauncher)) {
    fs.unlinkSync(programmaticLauncher);
    removed.push(programmaticLauncher);
  }
  if (fs.existsSync(runtime)) {
    fs.rmSync(runtime, { recursive: true });
    removed.push(runtime);
  }
  fs.unlinkSync(manifestPath(scope));
  removed.push(manifestPath(scope));
  return { removed };
}
