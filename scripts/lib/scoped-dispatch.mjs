import fs from "node:fs";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";

export const SCOPE_ENV = "CC_SUITE_SCOPE_ROOT";
export const LEGACY_SCOPE_ENV = "CC_SUITE_COMPOSER_SCOPE";
export const WORKSPACE_ENV = "CC_SUITE_WORKSPACE_ROOT";

export function pathIsWithin(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function realDirectory(directory, label) {
  let resolved;
  try {
    resolved = fs.realpathSync.native(path.resolve(directory));
  } catch (error) {
    throw new Error(`${label} is not readable: ${error.message}`);
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`${label} is not a directory: ${resolved}`);
  }
  return resolved;
}

export function configuredScopeRoot(env = process.env) {
  const configured = env[SCOPE_ENV] || env[LEGACY_SCOPE_ENV];
  if (typeof configured !== "string" || !configured.trim()) return null;
  try {
    return realDirectory(configured, "cc-suite scope");
  } catch {
    return null;
  }
}

export function resolveScopedWorkspace(cwd, env = process.env) {
  const scopeRoot = configuredScopeRoot(env);
  if (!scopeRoot) throw new Error("cc-suite scope is not configured");
  const selectedCwd = realDirectory(cwd, "dispatch working directory");
  if (!pathIsWithin(scopeRoot, selectedCwd)) {
    throw new Error(`dispatch working directory is outside scope: ${selectedCwd}`);
  }

  let workspaceRoot;
  const configuredWorkspace = env[WORKSPACE_ENV];
  if (typeof configuredWorkspace === "string" && configuredWorkspace.trim()) {
    workspaceRoot = realDirectory(configuredWorkspace, "dispatch workspace");
    if (!pathIsWithin(workspaceRoot, selectedCwd)) {
      throw new Error(`dispatch working directory is outside workspace: ${selectedCwd}`);
    }
    // A long-lived host can predate `git init` in its active directory. Keep
    // its launch boundary, but use the same discovered project identity as
    // the picker. Never widen that boundary to an enclosing Git repository.
    const discoveredRoot = realDirectory(
      resolveWorkspaceRoot(selectedCwd, workspaceRoot), "dispatch project",
    );
    if (pathIsWithin(workspaceRoot, discoveredRoot)) workspaceRoot = discoveredRoot;
  } else {
    workspaceRoot = realDirectory(resolveWorkspaceRoot(selectedCwd), "dispatch workspace");
  }
  if (!pathIsWithin(scopeRoot, workspaceRoot)) workspaceRoot = selectedCwd;

  const runtimeRoot = path.join(scopeRoot, ".cc-suite", "runtime");
  process.env[SCOPE_ENV] = scopeRoot;
  process.env[WORKSPACE_ENV] = workspaceRoot;
  process.env.CLAUDE_PLUGIN_DATA = runtimeRoot;
  return { scopeRoot, workspaceRoot, selectedCwd, runtimeRoot };
}

export function cwdIsInConfiguredScope(cwd, env = process.env) {
  try {
    resolveScopedWorkspace(cwd, env);
    return true;
  } catch {
    return false;
  }
}
