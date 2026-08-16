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
    const bypass = spawnSync(codexShim, ["--version"], { cwd: outside, encoding: "utf8" });
    assert.equal(bypass.status, 0, bypass.stderr);
    assert.equal(bypass.stdout, "codex-real\n--version\n");

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
