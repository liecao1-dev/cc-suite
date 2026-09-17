import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  inspectCodexCliCapabilities,
  requireCompatibleCodexCli,
  resolveActivatedCliBinary,
} from "../scripts/lib/activated-cli.mjs";
import { cleanupDir, makeTempDir, writeExecutable } from "./helpers.mjs";

function writeManifest(scope, binaries) {
  const directory = path.join(scope, ".cc-suite");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "composer-activation.json"), `${JSON.stringify({
    schema: 1,
    managedBy: "cc-suite",
    scopeRoot: fs.realpathSync.native(scope),
    binaries,
  }, null, 2)}\n`);
}

function fakeCodex(file, { compatible = true } = {}) {
  const execHelp = compatible
    ? "Usage: codex exec [OPTIONS] [PROMPT]\\n  -m, --model <MODEL>\\n  -s, --sandbox <MODE>\\n  --skip-git-repo-check\\n  --json\\n  -c, --config <key=value>\\n  -o, --output-last-message <FILE>\\n"
    : "Usage: codex exec [PROMPT]\\n";
  const resumeHelp = compatible
    ? "Usage: codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]\\n  -m, --model <MODEL>\\n  --skip-git-repo-check\\n  --json\\n  -c, --config <key=value>\\n  -o, --output-last-message <FILE>\\n"
    : "Usage: codex exec resume [PROMPT]\\n";
  writeExecutable(file, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (process.env.PROBE_LOG) require("node:fs").appendFileSync(process.env.PROBE_LOG, JSON.stringify(args) + "\\n");
if (args.length === 1 && args[0] === "--version") process.stdout.write("codex-cli test\\n");
else if (args.join(" ") === "exec --help") process.stdout.write(${JSON.stringify(execHelp)});
else if (args.join(" ") === "exec resume --help") process.stdout.write(${JSON.stringify(resumeHelp)});
else process.exitCode = 91;
`);
}

test("activation resolver follows a stable launcher when an update retargets it", () => {
  const scope = makeTempDir("cc-suite-activated-cli-");
  try {
    const release = path.join(scope, "release");
    fs.mkdirSync(release);
    const first = path.join(release, "codex-v1");
    const second = path.join(release, "codex-v2");
    fakeCodex(first);
    fakeCodex(second);
    const stable = path.join(release, "codex");
    fs.symlinkSync(first, stable);
    writeManifest(scope, { codex: stable, claude: second });

    assert.equal(resolveActivatedCliBinary(scope, "codex", { pathValue: "" }), fs.realpathSync.native(first));
    fs.unlinkSync(stable);
    fs.symlinkSync(second, stable);
    assert.equal(resolveActivatedCliBinary(scope, "codex", { pathValue: "" }), fs.realpathSync.native(second));
  } finally {
    cleanupDir(scope);
  }
});

test("activation resolver rediscovers either CLI after a package-manager path move", () => {
  const scope = makeTempDir("cc-suite-activated-cli-moved-");
  try {
    const oldBin = path.join(scope, "old-bin");
    const newBin = path.join(scope, "new-bin");
    const managedBin = path.join(scope, ".cc-suite", "bin");
    fs.mkdirSync(oldBin);
    fs.mkdirSync(newBin);
    fs.mkdirSync(managedBin, { recursive: true });
    const binaries = {};
    for (const target of ["codex", "claude"]) {
      const oldBinary = path.join(oldBin, target);
      const currentBinary = path.join(newBin, target);
      fakeCodex(oldBinary);
      fakeCodex(currentBinary);
      fakeCodex(path.join(managedBin, target));
      binaries[target] = oldBinary;
    }
    writeManifest(scope, binaries);
    fs.rmSync(oldBin, { recursive: true });

    for (const target of ["codex", "claude"]) {
      assert.equal(resolveActivatedCliBinary(scope, target, {
        pathValue: `${managedBin}${path.delimiter}${newBin}`,
      }), fs.realpathSync.native(path.join(newBin, target)));
    }
  } finally {
    cleanupDir(scope);
  }
});

test("activation resolver keeps the trusted manifest binding while it still exists", () => {
  const scope = makeTempDir("cc-suite-activated-cli-current-path-");
  try {
    const oldBin = path.join(scope, "old-bin");
    const currentBin = path.join(scope, "current-bin");
    fs.mkdirSync(oldBin);
    fs.mkdirSync(currentBin);
    const oldBinary = path.join(oldBin, "codex");
    const currentBinary = path.join(currentBin, "codex");
    fakeCodex(oldBinary);
    fakeCodex(currentBinary);
    writeManifest(scope, { codex: oldBinary });

    assert.equal(resolveActivatedCliBinary(scope, "codex", {
      pathValue: currentBin,
    }), fs.realpathSync.native(oldBinary));
  } finally {
    cleanupDir(scope);
  }
});

test("activation resolver rejects a manifest that points back to its managed shim", () => {
  const scope = makeTempDir("cc-suite-activated-cli-loop-");
  try {
    const shim = path.join(scope, ".cc-suite", "bin", "codex");
    fs.mkdirSync(path.dirname(shim), { recursive: true });
    fakeCodex(shim);
    writeManifest(scope, { codex: shim });
    assert.throws(
      () => resolveActivatedCliBinary(scope, "codex"),
      /managed shim/,
    );
  } finally {
    cleanupDir(scope);
  }
});

test("Codex capability inspection runs only version and help probes", () => {
  const fixture = makeTempDir("cc-suite-codex-capabilities-");
  try {
    const binary = path.join(fixture, "codex");
    const log = path.join(fixture, "probes.jsonl");
    fakeCodex(binary);
    const previous = process.env.PROBE_LOG;
    process.env.PROBE_LOG = log;
    try {
      assert.deepEqual(requireCompatibleCodexCli(binary), {
        ok: true,
        version: "codex-cli test",
        problems: [],
      });
    } finally {
      if (previous === undefined) delete process.env.PROBE_LOG;
      else process.env.PROBE_LOG = previous;
    }
    assert.deepEqual(
      fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse),
      [["--version"], ["exec", "--help"], ["exec", "resume", "--help"]],
    );
  } finally {
    cleanupDir(fixture);
  }
});

test("Codex capability inspection reports removed execution flags before inference", () => {
  const fixture = makeTempDir("cc-suite-codex-incompatible-");
  try {
    const binary = path.join(fixture, "codex");
    fakeCodex(binary, { compatible: false });
    const inspected = inspectCodexCliCapabilities(binary);
    assert.equal(inspected.ok, false);
    assert.match(inspected.problems.join("; "), /codex exec is missing/);
    assert.match(inspected.problems.join("; "), /codex exec resume is missing/);
    assert.throws(() => requireCompatibleCodexCli(binary), /activated Codex CLI is incompatible/);
  } finally {
    cleanupDir(fixture);
  }
});
