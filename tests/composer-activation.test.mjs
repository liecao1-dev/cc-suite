import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  composerShellBlock,
  composerShimIsOwned,
  inspectComposerActivation,
  installComposerActivation,
  repairComposerActivation,
  removeComposerActivation,
} from "../scripts/lib/composer-activation.mjs";
import { cleanupDir, makeTempDir } from "./helpers.mjs";

const SOURCE_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

function fakeBinary(directory, name) {
  const file = path.join(directory, name);
  fs.writeFileSync(file, `#!/usr/bin/env bash\nprintf '%s\\n' '${name}-real' "$@"\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

test("composer activation is scoped, idempotent, inspectable, and reversible", () => {
  const fixture = makeTempDir("cc-suite-composer-activation-");
  const scope = path.join(fixture, "projects");
  const realBin = path.join(fixture, "real-bin");
  const shellFile = path.join(fixture, ".zshrc");
  try {
    fs.mkdirSync(scope);
    fs.mkdirSync(realBin);
    fs.writeFileSync(shellFile, "export KEEP_ME=1\n");
    const codexBinary = fakeBinary(realBin, "codex");
    const claudeBinary = fakeBinary(realBin, "claude");

    const first = installComposerActivation({
      scopeRoot: scope,
      sourceRoot: SOURCE_ROOT,
      shellFile,
      codexBinary,
      claudeBinary,
    });
    assert.equal(first.changed.length, 4);
    const codexShim = path.join(scope, ".cc-suite", "bin", "codex");
    const claudeShim = path.join(scope, ".cc-suite", "bin", "claude");
    assert.equal(composerShimIsOwned(fs.readFileSync(codexShim, "utf8")), true);
    assert.equal(composerShimIsOwned(fs.readFileSync(claudeShim, "utf8")), true);
    assert.match(fs.readFileSync(shellFile, "utf8"), /export KEEP_ME=1/);
    assert.match(fs.readFileSync(shellFile, "utf8"), /cc-suite-composer-activation/);
    assert.deepEqual(inspectComposerActivation(scope).problems, []);

    const inheritedPath = `${realBin}:${path.dirname(codexShim)}:${realBin}`;
    const sourced = spawnSync("/bin/zsh", [
      "-fc",
      'source "$1"; print -rl -- "$path[@]"',
      "zsh",
      shellFile,
    ], {
      encoding: "utf8",
      env: { ...process.env, PATH: inheritedPath },
    });
    assert.equal(sourced.status, 0, sourced.stderr);
    const resolvedPath = sourced.stdout.trim().split("\n");
    const shimDirectory = fs.realpathSync.native(path.dirname(codexShim));
    assert.equal(resolvedPath[0], shimDirectory);
    assert.equal(resolvedPath.filter((entry) => entry === shimDirectory).length, 1);

    const second = installComposerActivation({
      scopeRoot: scope,
      sourceRoot: SOURCE_ROOT,
      shellFile,
      codexBinary,
      claudeBinary,
    });
    assert.deepEqual(second.changed, []);

    const outside = path.join(fixture, "outside");
    fs.mkdirSync(outside);
    const bypass = spawnSync(codexShim, ["--version"], {
      cwd: outside,
      encoding: "utf8",
      env: { ...process.env, PATH: `${realBin}:${process.env.PATH ?? ""}` },
    });
    assert.equal(bypass.status, 0, bypass.stderr);
    assert.equal(bypass.stdout, "codex-real\n--version\n");

    const movedBin = path.join(fixture, "moved-bin");
    fs.mkdirSync(movedBin);
    fakeBinary(movedBin, "codex");
    fs.unlinkSync(codexBinary);
    const afterMove = spawnSync(codexShim, ["--version"], {
      cwd: outside,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${path.dirname(codexShim)}:${movedBin}:${path.dirname(process.execPath)}:${process.env.PATH ?? ""}`,
      },
    });
    assert.equal(afterMove.status, 0, afterMove.stderr);
    assert.equal(afterMove.stdout, "codex-real\n--version\n");

    const removed = removeComposerActivation(scope);
    assert.equal(removed.removed.length, 4);
    assert.equal(fs.existsSync(codexShim), false);
    assert.equal(fs.existsSync(claudeShim), false);
    assert.equal(fs.readFileSync(shellFile, "utf8"), "export KEEP_ME=1\n");
    assert.equal(inspectComposerActivation(scope).ok, false);
  } finally {
    cleanupDir(fixture);
  }
});

test("composer activation refuses a user-owned shim", () => {
  const fixture = makeTempDir("cc-suite-composer-collision-");
  const scope = path.join(fixture, "projects");
  const realBin = path.join(fixture, "real-bin");
  try {
    fs.mkdirSync(path.join(scope, ".cc-suite", "bin"), { recursive: true });
    fs.mkdirSync(realBin);
    fs.writeFileSync(path.join(scope, ".cc-suite", "bin", "codex"), "mine\n");
    assert.throws(() => installComposerActivation({
      scopeRoot: scope,
      sourceRoot: SOURCE_ROOT,
      shellFile: path.join(fixture, ".zshrc"),
      codexBinary: fakeBinary(realBin, "codex"),
      claudeBinary: fakeBinary(realBin, "claude"),
    }), /user-owned/);
    assert.equal(fs.readFileSync(path.join(scope, ".cc-suite", "bin", "codex"), "utf8"), "mine\n");
  } finally {
    cleanupDir(fixture);
  }
});

test("shell activation explicitly documents its cwd-only behavior", () => {
  assert.match(composerShellBlock("/tmp/projects"), /change composer behavior only while cwd is inside/);
  assert.match(composerShellBlock("/tmp/projects"), /\/tmp\/projects\/\.cc-suite\/bin/);
  assert.match(composerShellBlock("/tmp/projects"), /path=\(/);
});

test("repair retargets owned shims to the current source directory", () => {
  const fixture = makeTempDir("cc-suite-composer-retarget-");
  const scope = path.join(fixture, "projects");
  const firstSource = path.join(fixture, "release-1");
  const secondSource = path.join(fixture, "release-2");
  const realBin = path.join(fixture, "real-bin");
  const currentBin = path.join(fixture, "current-bin");
  const shellFile = path.join(fixture, ".zshrc");
  try {
    fs.mkdirSync(scope);
    fs.mkdirSync(firstSource);
    fs.mkdirSync(secondSource);
    fs.mkdirSync(realBin);
    fs.mkdirSync(currentBin);
    const codexBinary = fakeBinary(realBin, "codex");
    const claudeBinary = fakeBinary(realBin, "claude");
    installComposerActivation({
      scopeRoot: scope,
      sourceRoot: firstSource,
      shellFile,
      codexBinary,
      claudeBinary,
    });

    const currentCodex = fakeBinary(currentBin, "codex");
    const currentClaude = fakeBinary(currentBin, "claude");
    repairComposerActivation(scope, { sourceRoot: secondSource, pathValue: currentBin });
    const manifest = JSON.parse(fs.readFileSync(path.join(scope, ".cc-suite", "composer-activation.json"), "utf8"));
    assert.equal(manifest.sourceRoot, fs.realpathSync.native(secondSource));
    assert.equal(manifest.binaries.codex, path.resolve(currentCodex));
    assert.equal(manifest.binaries.claude, path.resolve(currentClaude));
    assert.match(fs.readFileSync(path.join(scope, ".cc-suite", "bin", "codex"), "utf8"), /release-2/);
  } finally {
    cleanupDir(fixture);
  }
});

test("an outside-scope command bypasses even when the installed source disappeared", () => {
  const fixture = makeTempDir("cc-suite-composer-outside-bypass-");
  const scope = path.join(fixture, "projects");
  const source = path.join(fixture, "removed-release");
  const outside = path.join(fixture, "outside");
  const realBin = path.join(fixture, "real-bin");
  try {
    fs.mkdirSync(scope);
    fs.mkdirSync(source);
    fs.mkdirSync(outside);
    fs.mkdirSync(realBin);
    installComposerActivation({
      scopeRoot: scope,
      sourceRoot: source,
      shellFile: path.join(fixture, ".zshrc"),
      codexBinary: fakeBinary(realBin, "codex"),
      claudeBinary: fakeBinary(realBin, "claude"),
    });
    fs.rmSync(source, { recursive: true });
    const result = spawnSync(path.join(scope, ".cc-suite", "bin", "codex"), ["--version"], {
      cwd: outside,
      encoding: "utf8",
      env: { ...process.env, PATH: `${realBin}:${process.env.PATH ?? ""}` },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "codex-real\n--version\n");
  } finally {
    cleanupDir(fixture);
  }
});
