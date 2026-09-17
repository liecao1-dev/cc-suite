import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { cleanupDir, makeTempDir } from "./helpers.mjs";
import {
  inspectUserDispatch,
  installUserDispatch,
  removeUserDispatch,
  stableDispatchCommand,
} from "../scripts/lib/user-dispatch.mjs";

const SOURCE_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const HOOK = path.join(SOURCE_ROOT, "scripts", "dispatch-hook.mjs");

test("source updates replace only the stable launcher and keep hook definitions byte-identical", () => {
  const fixture = makeTempDir("cc-suite-user-dispatch-");
  try {
    const scope = path.join(fixture, "scope");
    const home = path.join(fixture, "home");
    const secondSource = path.join(fixture, "updated-source");
    fs.mkdirSync(scope);
    fs.mkdirSync(home);
    fs.mkdirSync(path.join(home, ".codex"));
    fs.mkdirSync(path.join(home, ".claude"));
    fs.mkdirSync(path.join(secondSource, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(secondSource, "scripts", "dispatch-hook.mjs"), "// updated fixture\n");
    fs.writeFileSync(path.join(secondSource, "scripts", "direct-inference-request.mjs"), "// updated request fixture\n");
    fs.writeFileSync(path.join(home, ".codex", "hooks.json"), `${JSON.stringify({
      hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "node user-hook.mjs" }] }] },
    }, null, 2)}\n`);
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), `${JSON.stringify({
      theme: "dark",
      hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "node user-claude-hook.mjs" }] }] },
    }, null, 2)}\n`);

    const first = installUserDispatch({ scopeRoot: scope, sourceRoot: SOURCE_ROOT, homeRoot: home });
    const codexDefinition = fs.readFileSync(first.codexHooks, "utf8");
    const claudeDefinition = fs.readFileSync(first.claudeSettings, "utf8");
    const firstLauncher = fs.readFileSync(first.launcher, "utf8");
    const firstProgrammaticLauncher = fs.readFileSync(first.programmaticLauncher, "utf8");
    assert.match(codexDefinition, /user-hook\.mjs/);
    assert.match(claudeDefinition, /user-claude-hook\.mjs/);
    assert.match(codexDefinition, /cc-suite-dispatch-hook/);
    assert.equal(first.programmaticLauncher, path.join(fs.realpathSync(scope), ".cc-suite", "bin", "cc-suite-dispatch"));
    assert.match(firstProgrammaticLauncher, /scripts\/direct-inference-request\.mjs/);
    assert.notEqual(fs.statSync(first.programmaticLauncher).mode & 0o111, 0);
    assert.equal(inspectUserDispatch(scope).ok, true);

    const second = installUserDispatch({ scopeRoot: scope, sourceRoot: secondSource, homeRoot: home });
    assert.equal(fs.readFileSync(second.codexHooks, "utf8"), codexDefinition);
    assert.equal(fs.readFileSync(second.claudeSettings, "utf8"), claudeDefinition);
    assert.notEqual(fs.readFileSync(second.launcher, "utf8"), firstLauncher);
    assert.notEqual(fs.readFileSync(second.programmaticLauncher, "utf8"), firstProgrammaticLauncher);
    assert.match(fs.readFileSync(second.programmaticLauncher, "utf8"), /updated-source\/scripts\/direct-inference-request\.mjs/);
    assert.equal(stableDispatchCommand(scope, "codex").includes(secondSource), false);
    assert.equal(inspectUserDispatch(scope).ok, true);
  } finally {
    cleanupDir(fixture);
  }
});

test("sync preserves the trusted Codex hook position while removing duplicates", () => {
  const fixture = makeTempDir("cc-suite-user-hook-position-");
  try {
    const scope = path.join(fixture, "scope");
    const home = path.join(fixture, "home");
    fs.mkdirSync(scope);
    fs.mkdirSync(home);
    const installed = installUserDispatch({ scopeRoot: scope, sourceRoot: SOURCE_ROOT, homeRoot: home });
    const command = stableDispatchCommand(installed.scope, "codex");
    const payload = JSON.parse(fs.readFileSync(installed.codexHooks, "utf8"));
    const stableGroup = payload.hooks.UserPromptSubmit.findIndex((group) => (
      group.hooks.some((handler) => handler.command === command)
    ));
    const stableHandler = payload.hooks.UserPromptSubmit[stableGroup].hooks.findIndex((handler) => (
      handler.command === command
    ));
    payload.hooks.UserPromptSubmit[stableGroup].hooks.push({
      type: "command",
      command: "node later-handler.mjs",
    });
    payload.hooks.UserPromptSubmit.push({
      hooks: [{ type: "command", command }],
    });
    fs.writeFileSync(installed.codexHooks, `${JSON.stringify(payload, null, 2)}\n`);

    installUserDispatch({ scopeRoot: scope, sourceRoot: SOURCE_ROOT, homeRoot: home });
    const repaired = JSON.parse(fs.readFileSync(installed.codexHooks, "utf8"));
    assert.equal(repaired.hooks.UserPromptSubmit[stableGroup].hooks[stableHandler].command, command);
    assert.equal(repaired.hooks.UserPromptSubmit[stableGroup].hooks[stableHandler + 1].command, "node later-handler.mjs");
    assert.equal(repaired.hooks.UserPromptSubmit.flatMap((group) => group.hooks)
      .filter((handler) => handler.command === command).length, 1);
    const once = fs.readFileSync(installed.codexHooks, "utf8");
    installUserDispatch({ scopeRoot: scope, sourceRoot: SOURCE_ROOT, homeRoot: home });
    assert.equal(fs.readFileSync(installed.codexHooks, "utf8"), once);
  } finally {
    cleanupDir(fixture);
  }
});

test("the stable programmatic launcher is inspected, repaired, and removed with user dispatch", () => {
  const fixture = makeTempDir("cc-suite-user-programmatic-");
  try {
    const scope = path.join(fixture, "scope");
    const home = path.join(fixture, "home");
    fs.mkdirSync(scope);
    fs.mkdirSync(home);

    const installed = installUserDispatch({ scopeRoot: scope, sourceRoot: SOURCE_ROOT, homeRoot: home });
    const codexDefinition = fs.readFileSync(installed.codexHooks, "utf8");
    const claudeDefinition = fs.readFileSync(installed.claudeSettings, "utf8");
    fs.unlinkSync(installed.programmaticLauncher);
    assert.match(
      inspectUserDispatch(scope).problems.join("\n"),
      /stable programmatic dispatch launcher missing/,
    );

    const repaired = installUserDispatch({ scopeRoot: scope, sourceRoot: SOURCE_ROOT, homeRoot: home });
    assert.equal(fs.existsSync(repaired.programmaticLauncher), true);
    assert.equal(fs.readFileSync(repaired.codexHooks, "utf8"), codexDefinition);
    assert.equal(fs.readFileSync(repaired.claudeSettings, "utf8"), claudeDefinition);
    assert.equal(inspectUserDispatch(scope).ok, true);

    const removed = removeUserDispatch(scope);
    assert.equal(removed.removed.includes(repaired.programmaticLauncher), true);
    assert.equal(fs.existsSync(repaired.programmaticLauncher), false);
  } finally {
    cleanupDir(fixture);
  }
});

test("a user-owned programmatic launcher is preserved", () => {
  const fixture = makeTempDir("cc-suite-user-programmatic-collision-");
  try {
    const scope = path.join(fixture, "scope");
    const home = path.join(fixture, "home");
    const launcher = path.join(scope, ".cc-suite", "bin", "cc-suite-dispatch");
    fs.mkdirSync(path.dirname(launcher), { recursive: true });
    fs.mkdirSync(home);
    fs.writeFileSync(launcher, "user-owned\n");

    assert.throws(
      () => installUserDispatch({ scopeRoot: scope, sourceRoot: SOURCE_ROOT, homeRoot: home }),
      /user-owned; programmatic dispatch launcher preserved/,
    );
    assert.equal(fs.readFileSync(launcher, "utf8"), "user-owned\n");
    assert.equal(fs.existsSync(path.join(home, ".codex", "hooks.json")), false);
    assert.equal(fs.existsSync(path.join(home, ".claude", "settings.json")), false);
  } finally {
    cleanupDir(fixture);
  }
});

test("removal refuses an edited programmatic launcher before changing hooks", () => {
  const fixture = makeTempDir("cc-suite-user-programmatic-edited-");
  try {
    const scope = path.join(fixture, "scope");
    const home = path.join(fixture, "home");
    fs.mkdirSync(scope);
    fs.mkdirSync(home);
    const installed = installUserDispatch({ scopeRoot: scope, sourceRoot: SOURCE_ROOT, homeRoot: home });
    const codexDefinition = fs.readFileSync(installed.codexHooks, "utf8");
    const claudeDefinition = fs.readFileSync(installed.claudeSettings, "utf8");
    fs.writeFileSync(installed.programmaticLauncher, "edited by user\n");

    assert.throws(() => removeUserDispatch(scope), /was edited; preserved/);
    assert.equal(fs.readFileSync(installed.codexHooks, "utf8"), codexDefinition);
    assert.equal(fs.readFileSync(installed.claudeSettings, "utf8"), claudeDefinition);
    assert.equal(fs.existsSync(installed.launcher), true);
    assert.equal(fs.readFileSync(installed.programmaticLauncher, "utf8"), "edited by user\n");
  } finally {
    cleanupDir(fixture);
  }
});

test("user-level hook is a silent no-op outside the configured scope", () => {
  const fixture = makeTempDir("cc-suite-user-hook-scope-");
  try {
    const scope = path.join(fixture, "scope");
    const outside = path.join(fixture, "outside");
    fs.mkdirSync(scope);
    fs.mkdirSync(outside);
    const result = spawnSync(process.execPath, [HOOK, "--host", "codex", "--target", "claude"], {
      cwd: outside,
      env: { ...process.env, CC_SUITE_SCOPE_ROOT: scope },
      input: JSON.stringify({
        cwd: outside,
        hook_event_name: "UserPromptSubmit",
        session_id: "outside-session",
        prompt: "$claude 不应被改变",
      }),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(fs.existsSync(path.join(scope, ".cc-suite", "runtime")), false);
  } finally {
    cleanupDir(fixture);
  }
});

test("an unarmed in-scope prompt exits without creating centralized state", () => {
  const scope = makeTempDir("cc-suite-user-hook-unarmed-");
  try {
    const workspace = path.join(scope, "workspace");
    fs.mkdirSync(workspace);
    const result = spawnSync(process.execPath, [HOOK, "--host", "codex", "--target", "claude"], {
      cwd: workspace,
      env: { ...process.env, CC_SUITE_SCOPE_ROOT: scope },
      input: JSON.stringify({
        cwd: workspace,
        hook_event_name: "UserPromptSubmit",
        session_id: "ordinary-session",
        prompt: "ordinary prompt",
      }),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(fs.existsSync(path.join(scope, ".cc-suite", "runtime")), false);
  } finally {
    cleanupDir(scope);
  }
});
