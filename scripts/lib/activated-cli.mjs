import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const MANAGED_BY = "cc-suite";
const MANIFEST_SCHEMA = 1;
const TARGETS = new Set(["claude", "codex"]);
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const MAX_PROBE_OUTPUT = 1024 * 1024;

function pathIsWithin(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function realDirectory(value, label) {
  let resolved;
  try {
    resolved = fs.realpathSync.native(path.resolve(value));
  } catch (error) {
    throw new Error(`${label} is not readable: ${error.message}`);
  }
  if (!fs.statSync(resolved).isDirectory()) throw new Error(`${label} is not a directory`);
  return resolved;
}

/**
 * Resolve one target CLI through the scope-owned composer activation manifest.
 * The returned path is canonical and cannot point back at a managed composer
 * shim, so noninteractive runners never depend on PATH ordering or recurse.
 */
export function resolveActivatedCliBinary(scopeRoot, target, {
  pathValue = process.env.PATH,
} = {}) {
  if (!TARGETS.has(target)) throw new Error(`unsupported activated CLI target: ${target}`);
  const scope = realDirectory(scopeRoot, "cc-suite scope");
  const manifestFile = path.join(scope, ".cc-suite", "composer-activation.json");
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  } catch (error) {
    throw new Error(`composer activation manifest is unavailable: ${error.message}`);
  }
  if (manifest?.managedBy !== MANAGED_BY || manifest?.schema !== MANIFEST_SCHEMA) {
    throw new Error("composer activation manifest is not owned by cc-suite");
  }
  if (manifest.scopeRoot !== scope) {
    throw new Error("composer activation manifest scope mismatch");
  }
  const configured = manifest?.binaries?.[target];
  if (
    typeof configured !== "string"
    || !path.isAbsolute(configured)
    || /[\r\n]/.test(configured)
  ) {
    throw new Error(`composer activation manifest has no absolute ${target} binary`);
  }
  const managedBin = path.join(scope, ".cc-suite", "bin");
  if (pathIsWithin(managedBin, configured)) {
    throw new Error(`composer activation ${target} binary points at a managed shim`);
  }
  let binary = null;
  try {
    binary = fs.realpathSync.native(configured);
    fs.accessSync(binary, fs.constants.X_OK);
    if (!fs.statSync(binary).isFile()) throw new Error("not a file");
  } catch {
    binary = null;
  }
  if (binary && pathIsWithin(managedBin, binary)) {
    throw new Error(`activated ${target} binary resolves to a managed shim`);
  }
  // The activation manifest is the trusted real-binary binding. A sync/repair
  // refreshes it from the current PATH even when the old executable still
  // exists; between syncs we retain that binding rather than allowing an
  // arbitrary inherited PATH entry to replace the target.
  if (binary) return binary;

  // Package managers may remove or move the executable before the next sync.
  // Recover from the current PATH, but never select cc-suite's own shim.
  for (const directory of String(pathValue ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.resolve(directory, target);
    if (pathIsWithin(managedBin, candidate)) continue;
    try {
      const resolved = fs.realpathSync.native(candidate);
      fs.accessSync(resolved, fs.constants.X_OK);
      if (!fs.statSync(resolved).isFile() || pathIsWithin(managedBin, resolved)) continue;
      return resolved;
    } catch {}
  }
  throw new Error(`activated ${target} binary is missing and no current executable was found outside the managed shim`);
}

function probe(binary, args, timeoutMs) {
  const result = spawnSync(binary, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    maxBuffer: MAX_PROBE_OUTPUT,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return { result, output };
}

function probeFailure(label, result) {
  if (result.error?.code === "ETIMEDOUT") return `${label} timed out`;
  if (result.error) return `${label} could not start (${result.error.code ?? result.error.message})`;
  if (result.status !== 0) return `${label} exited ${result.status ?? "without a status"}`;
  return null;
}

function missingOptions(output, options) {
  return options.filter((option) => !output.includes(option));
}

/**
 * Check only Codex's zero-model command surface. These probes never invoke
 * `codex exec` itself: they request version/help text and therefore do not
 * submit a task, contact a model, or consume tokens.
 */
export function inspectCodexCliCapabilities(binary, {
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
} = {}) {
  if (typeof binary !== "string" || !path.isAbsolute(binary)) {
    return { ok: false, version: null, problems: ["Codex binary is not an absolute path"] };
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Codex capability probe timeout must be a positive integer");
  }

  const versionProbe = probe(binary, ["--version"], timeoutMs);
  const execProbe = probe(binary, ["exec", "--help"], timeoutMs);
  const resumeProbe = probe(binary, ["exec", "resume", "--help"], timeoutMs);
  const problems = [];
  for (const [label, item] of [
    ["codex --version", versionProbe],
    ["codex exec --help", execProbe],
    ["codex exec resume --help", resumeProbe],
  ]) {
    const failure = probeFailure(label, item.result);
    if (failure) problems.push(failure);
  }

  const version = versionProbe.result.status === 0
    ? String(versionProbe.result.stdout ?? "").trim() || null
    : null;
  if (versionProbe.result.status === 0 && !version) problems.push("codex --version returned no version");

  if (execProbe.result.status === 0) {
    const missing = missingOptions(execProbe.output, [
      "--model",
      "--sandbox",
      "--skip-git-repo-check",
      "--json",
      "--output-last-message",
      "--config",
    ]);
    if (!/(?:^|\s)-c(?:,|\s)/m.test(execProbe.output)) missing.push("-c");
    if (!/(?:^|\s)-o(?:,|\s)/m.test(execProbe.output)) missing.push("-o");
    if (missing.length) problems.push(`codex exec is missing: ${missing.join(", ")}`);
  }
  if (resumeProbe.result.status === 0) {
    const missing = missingOptions(resumeProbe.output, [
      "SESSION_ID",
      "--model",
      "--skip-git-repo-check",
      "--json",
      "--output-last-message",
      "--config",
    ]);
    if (!/(?:^|\s)-c(?:,|\s)/m.test(resumeProbe.output)) missing.push("-c");
    if (!/(?:^|\s)-o(?:,|\s)/m.test(resumeProbe.output)) missing.push("-o");
    if (missing.length) problems.push(`codex exec resume is missing: ${missing.join(", ")}`);
  }
  return { ok: problems.length === 0, version, problems };
}

export function requireCompatibleCodexCli(binary, options) {
  const inspected = inspectCodexCliCapabilities(binary, options);
  if (!inspected.ok) {
    throw new Error(`activated Codex CLI is incompatible: ${inspected.problems.join("; ")}`);
  }
  return inspected;
}
