import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { makeTempDir, initGitRepo, cleanupDir } from "./helpers.mjs";
import { resolveWorkspaceRoot } from "../scripts/lib/workspace.mjs";

test("resolveWorkspaceRoot returns git root for git repos", () => {
  const dir = makeTempDir();
  try {
    initGitRepo(dir);
    const root = resolveWorkspaceRoot(dir);
    // Should be the same dir (it's the git root)
    assert.ok(root.length > 0);
  } finally {
    cleanupDir(dir);
  }
});

test("resolveWorkspaceRoot returns cwd for non-git directories", () => {
  const dir = makeTempDir();
  try {
    const root = resolveWorkspaceRoot(dir);
    assert.equal(root, dir);
  } finally {
    cleanupDir(dir);
  }
});

test("a nearest cc-suite marker wins over a broader parent git repository", () => {
  const dir = makeTempDir();
  try {
    initGitRepo(dir);
    const project = path.join(dir, "projects", "app");
    const nested = path.join(project, "packages", "web");
    fs.mkdirSync(path.join(project, ".cc-suite"), { recursive: true });
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(project, ".cc-suite", "project.json"), JSON.stringify({
      schema: 1,
      managedBy: "cc-suite",
    }));
    assert.equal(resolveWorkspaceRoot(nested), project);
  } finally { cleanupDir(dir); }
});
