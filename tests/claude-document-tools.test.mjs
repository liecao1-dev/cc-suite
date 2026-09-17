import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { prepareClaudeDocumentTools } from "../scripts/lib/claude-document-tools.mjs";
import { cleanupDir, makeTempDir, writeExecutable } from "./helpers.mjs";

test("document converters receive exact executable rules and workspace-local state", () => {
  const scope = makeTempDir("claude-document-tools-");
  try {
    const project = path.join(scope, "project");
    const bin = path.join(scope, "bin");
    fs.mkdirSync(project);
    fs.mkdirSync(bin);
    const toolPaths = ["pdftotext", "pdftoppm", "ebook-convert"].map((name) => path.join(bin, name));
    for (const file of toolPaths) writeExecutable(file, "#!/bin/sh\nexit 0\n");
    const originalEnv = {
      PATH: `${bin}${path.delimiter}/usr/bin`,
      TMPDIR: "/outside/tmp",
      CALIBRE_CONFIG_DIRECTORY: "/outside/config",
      CALIBRE_CACHE_DIRECTORY: "/outside/cache",
      CALIBRE_TEMP_DIR: "/outside/calibre-tmp",
      UNRELATED: "preserved",
    };
    const result = prepareClaudeDocumentTools({
      workspaceRoot: fs.realpathSync(project),
      executionCwd: fs.realpathSync(project),
    }, { env: originalEnv, toolPaths });
    assert.deepEqual(result.allow, toolPaths.map((file) => `Bash(${file} *)`));
    assert.equal(result.env.PATH, originalEnv.PATH);
    assert.equal(result.env.UNRELATED, "preserved");
    const scratch = path.join(fs.realpathSync(project), ".runtime", "claude-document-tools");
    assert.equal(result.env.TMPDIR, scratch);
    assert.equal(result.env.CALIBRE_TEMP_DIR, scratch);
    assert.equal(result.env.CALIBRE_CONFIG_DIRECTORY, path.join(scratch, "config"));
    assert.equal(result.env.CALIBRE_CACHE_DIRECTORY, path.join(scratch, "cache"));
    assert.equal(originalEnv.TMPDIR, "/outside/tmp");
    assert.ok(fs.statSync(scratch).isDirectory());
    assert.ok(result.instructions.includes(scratch));
    assert.deepEqual(prepareClaudeDocumentTools({
      workspaceRoot: fs.realpathSync(project), executionCwd: fs.realpathSync(project),
    }, { env: originalEnv, toolPaths }), result);
  } finally { cleanupDir(scope); }
});

test("absent or non-executable converters add no permissions, environment changes, or directories", () => {
  const project = makeTempDir("claude-document-tools-missing-");
  try {
    const disabled = path.join(project, "pdftotext");
    fs.writeFileSync(disabled, "not executable", { mode: 0o600 });
    const env = { PATH: "/usr/bin", TMPDIR: "/original/tmp" };
    assert.deepEqual(prepareClaudeDocumentTools({
      workspaceRoot: project, executionCwd: project,
    }, { env, toolPaths: [path.join(project, "missing"), disabled, project] }), {
      allow: [], env, instructions: "",
    });
    assert.equal(fs.existsSync(path.join(project, ".runtime")), false);
  } finally { cleanupDir(project); }
});

test("a scratch symlink cannot cause initialization writes outside the workspace", () => {
  const scope = makeTempDir("claude-document-tools-symlink-");
  try {
    const project = path.join(scope, "project");
    const outside = path.join(scope, "outside");
    fs.mkdirSync(project);
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(project, ".runtime"), "dir");
    const tool = path.join(scope, "pdftotext");
    writeExecutable(tool, "#!/bin/sh\nexit 0\n");
    assert.throws(() => prepareClaudeDocumentTools({
      workspaceRoot: fs.realpathSync(project), executionCwd: fs.realpathSync(project),
    }, { env: {}, toolPaths: [tool] }), /scratch directory escapes workspace/);
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally { cleanupDir(scope); }
});
