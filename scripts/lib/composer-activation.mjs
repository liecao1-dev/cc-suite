import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isWithin } from "./project-dispatch.mjs";

const MANAGED_BY = "cc-suite";
const SCHEMA = 1;
const SHELL_OPEN = "# >>> cc-suite-composer-activation >>>";
const SHELL_CLOSE = "# <<< cc-suite-composer-activation <<<";
const SHIM_MARKER = /^# cc-suite-managed-composer-shim sha256=([0-9a-f]{64})$/m;

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function writeAtomic(file, content, mode = 0o644) {
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

function ensureRealDirectory(directory, scopeRoot) {
  if (!isWithin(scopeRoot, directory)) throw new Error(`refusing directory outside scope: ${directory}`);
  if (fs.existsSync(directory)) {
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${directory} is not a real directory`);
    return;
  }
  ensureRealDirectory(path.dirname(directory), scopeRoot);
  fs.mkdirSync(directory);
}

function executable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function manifestPath(scopeRoot) {
  return path.join(scopeRoot, ".cc-suite", "composer-activation.json");
}

function readManifest(scopeRoot) {
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath(scopeRoot), "utf8"));
    if (parsed?.managedBy === MANAGED_BY && parsed?.schema === SCHEMA) return parsed;
  } catch {}
  return null;
}

function resolveBinary(name, { scopeRoot, pathValue, preferred }) {
  const bin = path.join(scopeRoot, ".cc-suite", "bin");
  const candidates = [
    preferred,
    ...String(pathValue ?? process.env.PATH ?? "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((directory) => path.join(directory, name)),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const absolute = path.resolve(candidate);
    if (isWithin(bin, absolute)) continue;
    if (executable(absolute)) return absolute;
  }
  throw new Error(`cannot find the real ${name} executable outside ${bin}`);
}

export function composerShimBody({ host, scopeRoot, sourceRoot, realBinary }) {
  return [
    "#!/usr/bin/env bash",
    `exec python3 ${shellQuote(path.join(sourceRoot, "scripts", "composer-proxy.py"))} --host ${host} --scope ${shellQuote(scopeRoot)} --source ${shellQuote(sourceRoot)} --real-binary ${shellQuote(realBinary)} -- "$@"`,
    "",
  ].join("\n");
}

export function composerShim(options) {
  const body = composerShimBody(options);
  const firstNewline = body.indexOf("\n") + 1;
  return `${body.slice(0, firstNewline)}# cc-suite-managed-composer-shim sha256=${sha256(body)}\n${body.slice(firstNewline)}`;
}

export function composerShimIsOwned(text) {
  const match = text.match(SHIM_MARKER);
  if (!match) return false;
  const start = match.index;
  let end = start + match[0].length;
  if (text[end] === "\n") end += 1;
  return sha256(text.slice(0, start) + text.slice(end)) === match[1];
}

export function composerShellBlock(scopeRoot) {
  const bin = path.join(scopeRoot, ".cc-suite", "bin");
  return [
    SHELL_OPEN,
    `# The shims below change composer behavior only while cwd is inside ${scopeRoot}.`,
    `typeset _cc_suite_composer_bin=${shellQuote(bin)}`,
    // Rebuild zsh's tied $path array instead of checking only for presence.
    // A parent shell may already carry this entry at low precedence; merely
    // seeing it would otherwise leave the real CLI ahead of the shim.
    `path=("$_cc_suite_composer_bin" "\${(@)path:#\${(b)_cc_suite_composer_bin}}")`,
    "export PATH",
    "unset _cc_suite_composer_bin",
    SHELL_CLOSE,
  ].join("\n");
}

function replaceShellBlock(text, replacement) {
  const opens = text.split(SHELL_OPEN).length - 1;
  const closes = text.split(SHELL_CLOSE).length - 1;
  if (opens !== closes || opens > 1) throw new Error("shell file has malformed cc-suite composer markers");
  if (!opens) return `${text.trimEnd()}${text.trim() ? "\n\n" : ""}${replacement}\n`;
  const start = text.indexOf(SHELL_OPEN);
  const end = text.indexOf(SHELL_CLOSE, start) + SHELL_CLOSE.length;
  return `${text.slice(0, start)}${replacement}${text.slice(end)}`;
}

function removeShellBlock(text, expected) {
  const start = text.indexOf(SHELL_OPEN);
  const close = text.indexOf(SHELL_CLOSE, start);
  if (start === -1 && close === -1) return text;
  if (start === -1 || close === -1) throw new Error("shell file has malformed cc-suite composer markers");
  const end = close + SHELL_CLOSE.length;
  if (text.slice(start, end) !== expected) {
    throw new Error("shell activation block was edited; preserved");
  }
  const before = text.slice(0, start);
  const after = text.slice(end);
  if (!before && after === "\n") return "";
  if (before.endsWith("\n\n") && after === "\n") return before.slice(0, -1);
  if (before.endsWith("\n\n") && after.startsWith("\n")) {
    return before.slice(0, -1) + after;
  }
  return before + after;
}

function writeOwnedShim(file, generated) {
  if (fs.existsSync(file) && !composerShimIsOwned(fs.readFileSync(file, "utf8"))) {
    throw new Error(`${file} is user-owned; composer shim not replaced`);
  }
  if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== generated) {
    writeAtomic(file, generated, 0o755);
    return true;
  }
  return false;
}

export function installComposerActivation({
  scopeRoot,
  sourceRoot,
  shellFile = path.join(os.homedir(), ".zshrc"),
  pathValue = process.env.PATH,
  codexBinary = null,
  claudeBinary = null,
}) {
  const scope = fs.realpathSync.native(path.resolve(scopeRoot));
  const source = fs.realpathSync.native(path.resolve(sourceRoot));
  const existing = readManifest(scope);
  const binaries = {
    codex: resolveBinary("codex", {
      scopeRoot: scope,
      pathValue,
      preferred: codexBinary ?? existing?.binaries?.codex,
    }),
    claude: resolveBinary("claude", {
      scopeRoot: scope,
      pathValue,
      preferred: claudeBinary ?? existing?.binaries?.claude,
    }),
  };
  const directory = path.join(scope, ".cc-suite", "bin");
  ensureRealDirectory(directory, scope);

  const generatedShims = {};
  for (const host of Object.keys(HOST_LABELS)) {
    const file = path.join(directory, host);
    const generated = composerShim({
      host,
      scopeRoot: scope,
      sourceRoot: source,
      realBinary: binaries[host],
    });
    if (fs.existsSync(file) && !composerShimIsOwned(fs.readFileSync(file, "utf8"))) {
      throw new Error(`${file} is user-owned; composer shim not replaced`);
    }
    generatedShims[host] = { file, generated };
  }

  const resolvedShell = path.resolve(shellFile);
  if (fs.lstatSync(resolvedShell, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error(`${resolvedShell} is a symlink; shell activation not edited`);
  }
  const shellText = fs.existsSync(resolvedShell) ? fs.readFileSync(resolvedShell, "utf8") : "";
  const nextShell = replaceShellBlock(shellText, composerShellBlock(scope));

  const manifest = {
    schema: SCHEMA,
    managedBy: MANAGED_BY,
    scopeRoot: scope,
    sourceRoot: source,
    shellFile: resolvedShell,
    binaries,
  };
  const file = manifestPath(scope);
  const generatedManifest = `${JSON.stringify(manifest, null, 2)}\n`;
  if (fs.existsSync(file)) {
    const current = readManifest(scope);
    if (!current) throw new Error(`${file} is user-owned; activation manifest preserved`);
  }

  // All ownership and shell-marker checks happen before the first file write,
  // so a collision cannot leave a half-installed activation behind.
  const changed = [];
  for (const { file: shimFile, generated } of Object.values(generatedShims)) {
    if (writeOwnedShim(shimFile, generated)) changed.push(shimFile);
  }
  if (nextShell !== shellText) {
    writeAtomic(resolvedShell, nextShell, fs.existsSync(resolvedShell) ? fs.statSync(resolvedShell).mode & 0o777 : 0o644);
    changed.push(resolvedShell);
  }
  if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== generatedManifest) {
    writeAtomic(file, generatedManifest, 0o600);
    changed.push(file);
  }
  return { scope, source, shellFile: resolvedShell, binaries, changed };
}

const HOST_LABELS = Object.freeze({ codex: "Codex", claude: "Claude" });

export function inspectComposerActivation(scopeRoot) {
  const scope = fs.realpathSync.native(path.resolve(scopeRoot));
  const manifest = readManifest(scope);
  const problems = [];
  if (!manifest) return { ok: false, problems: ["composer activation manifest missing"] };
  if (manifest.scopeRoot !== scope) problems.push("activation manifest scope mismatch");
  if (!manifest.sourceRoot || !fs.existsSync(manifest.sourceRoot)) problems.push("activation source missing");
  for (const host of Object.keys(HOST_LABELS)) {
    const shim = path.join(scope, ".cc-suite", "bin", host);
    try {
      const content = fs.readFileSync(shim, "utf8");
      const expected = composerShim({
        host,
        scopeRoot: scope,
        sourceRoot: manifest.sourceRoot,
        realBinary: manifest.binaries?.[host],
      });
      if (!composerShimIsOwned(content) || content !== expected || !executable(shim)) {
        problems.push(`${host} composer shim missing, stale, or user-owned`);
      }
    } catch {
      problems.push(`${host} composer shim missing, stale, or user-owned`);
    }
    if (!executable(manifest.binaries?.[host])) problems.push(`real ${host} executable missing`);
  }
  try {
    const shellText = fs.readFileSync(manifest.shellFile, "utf8");
    if (!shellText.includes(composerShellBlock(scope))) problems.push("shell PATH activation missing or edited");
  } catch {
    problems.push("shell PATH activation missing or edited");
  }
  return { ok: problems.length === 0, problems, manifest };
}

export function repairComposerActivation(scopeRoot) {
  const scope = fs.realpathSync.native(path.resolve(scopeRoot));
  const manifest = readManifest(scope);
  if (!manifest) return null;
  return installComposerActivation({
    scopeRoot: scope,
    sourceRoot: manifest.sourceRoot,
    shellFile: manifest.shellFile,
    codexBinary: manifest.binaries.codex,
    claudeBinary: manifest.binaries.claude,
  });
}

export function removeComposerActivation(scopeRoot) {
  const scope = fs.realpathSync.native(path.resolve(scopeRoot));
  const manifest = readManifest(scope);
  if (!manifest) return { removed: [] };
  const shellText = fs.existsSync(manifest.shellFile) ? fs.readFileSync(manifest.shellFile, "utf8") : "";
  const nextShell = removeShellBlock(shellText, composerShellBlock(scope));
  for (const host of Object.keys(HOST_LABELS)) {
    const shim = path.join(scope, ".cc-suite", "bin", host);
    if (!fs.existsSync(shim)) continue;
    if (!composerShimIsOwned(fs.readFileSync(shim, "utf8"))) {
      throw new Error(`${shim} was edited; preserved`);
    }
  }

  // Validate every managed artifact before removing any of them.
  const removed = [];
  if (nextShell !== shellText) {
    writeAtomic(manifest.shellFile, nextShell, fs.statSync(manifest.shellFile).mode & 0o777);
    removed.push(manifest.shellFile);
  }
  for (const host of Object.keys(HOST_LABELS)) {
    const shim = path.join(scope, ".cc-suite", "bin", host);
    if (!fs.existsSync(shim)) continue;
    fs.unlinkSync(shim);
    removed.push(shim);
  }
  fs.unlinkSync(manifestPath(scope));
  removed.push(manifestPath(scope));
  return { removed };
}
