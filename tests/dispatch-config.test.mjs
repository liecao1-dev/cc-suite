import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { cleanupDir, makeTempDir } from "./helpers.mjs";

import {
  buildDispatchProfiles,
  normalizeDispatchConfig,
  readRecentDispatch,
  withRecentDispatch,
} from "../scripts/lib/dispatch-config.mjs";

const codexCatalog = {
  models: ["gpt-new", "gpt-fast", "gpt-old"],
  modelsDetail: [
    { slug: "gpt-new", display_name: "GPT New", reasoning_efforts: ["low", "medium", "high"] },
    { slug: "gpt-fast", display_name: "GPT Fast", reasoning_efforts: ["low", "medium"] },
    { slug: "gpt-old", display_name: "GPT Old", reasoning_efforts: ["low", "high"] },
  ],
  efforts: ["low", "medium", "high"],
  access: ["read-only", "workspace-write", "danger-full-access"],
};

const PLUGIN_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const configCli = path.join(PLUGIN_ROOT, "scripts", "dispatch-config.mjs");

function runConfig(workspace, args) {
  const result = spawnSync(process.execPath, [configCli, ...args, "--cwd", workspace], {
    cwd: workspace,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("recent config is first, default config is second, remaining models follow", () => {
  const result = buildDispatchProfiles({
    target: "codex",
    recent: { model: "gpt-fast", effort: "low", access: "read-only" },
    defaultConfig: { model: "gpt-new", effort: "medium", access: "workspace-write" },
    catalog: codexCatalog,
  });

  assert.deepEqual(result.profiles.slice(0, 2).map((row) => row.id), ["recent", "default"]);
  assert.deepEqual(result.profiles[0].badges, ["recent"]);
  assert.deepEqual(result.profiles[1].badges, ["default"]);
  assert.equal(result.profiles[0].label, "GPT Fast");
  assert.equal(result.profiles[1].label, "GPT New");
  assert.equal(result.profiles[2].config.model, "gpt-fast");
});

test("identical recent and default configs merge without a duplicate row", () => {
  const same = { model: "gpt-new", effort: "medium", access: "workspace-write" };
  const result = buildDispatchProfiles({
    target: "codex",
    recent: same,
    defaultConfig: same,
    catalog: codexCatalog,
  });

  assert.equal(result.profiles[0].id, "recent");
  assert.deepEqual(result.profiles[0].badges, ["recent", "default"]);
  assert.equal(result.profiles.filter((row) => row.config.model === "gpt-new").length, 1);
});

test("a stale recent Codex model is omitted and reported", () => {
  const result = buildDispatchProfiles({
    target: "codex",
    recent: { model: "gpt-gone", effort: "medium", access: "workspace-write" },
    defaultConfig: { model: "gpt-new", effort: "medium", access: "workspace-write" },
    catalog: codexCatalog,
  });

  assert.equal(result.recentUnavailable, true);
  assert.equal(result.profiles[0].id, "default");
});

test("other model rows use a supported effort", () => {
  const result = buildDispatchProfiles({
    target: "codex",
    recent: null,
    defaultConfig: { model: "gpt-new", effort: "medium", access: "workspace-write" },
    catalog: codexCatalog,
  });
  const old = result.profiles.find((row) => row.config.model === "gpt-old");
  assert.equal(old.config.effort, "low");
});

test("recent state is target-scoped and preserves the other target", () => {
  let config = withRecentDispatch({}, "codex", {
    model: "gpt-new",
    effort: "high",
    access: "workspace-write",
  }, "2026-08-15T00:00:00.000Z");
  config = withRecentDispatch(config, "claude", {
    model: "opus",
    effort: "max",
    access: "plan",
  }, "2026-08-15T00:01:00.000Z");

  assert.equal(readRecentDispatch(config, "codex").model, "gpt-new");
  assert.equal(readRecentDispatch(config, "claude").model, "opus");
});

test("invalid target configuration is rejected before dispatch", () => {
  assert.throws(
    () => normalizeDispatchConfig("claude", { model: "opus", effort: "ultra", access: "default" }),
    /unsupported claude effort/
  );
  assert.throws(
    () => normalizeDispatchConfig("codex", { model: "gpt-new;rm", effort: "high", access: "workspace-write" }),
    /invalid model id/
  );
});

test("the CLI persists a Claude MRU and returns it before the default", () => {
  const workspace = makeTempDir();
  try {
    const recorded = runConfig(workspace, [
      "record",
      "--target", "claude",
      "--model", "opus",
      "--effort", "high",
      "--access", "plan",
    ]);
    assert.equal(recorded.status, "ok");

    const listed = runConfig(workspace, ["list", "--target", "claude"]);
    assert.deepEqual(listed.profiles.slice(0, 2).map((row) => row.id), ["recent", "default"]);
    assert.deepEqual(listed.profiles[0].config, {
      model: "opus",
      effort: "high",
      access: "plan",
    });
    assert.equal(listed.autoSelect, false);
  } finally {
    cleanupDir(workspace);
  }
});

test("the CLI merges a recent configuration that exactly matches the default", () => {
  const workspace = makeTempDir();
  try {
    runConfig(workspace, [
      "record",
      "--target", "claude",
      "--model", "default",
      "--effort", "medium",
      "--access", "default",
    ]);
    const listed = runConfig(workspace, ["list", "--target", "claude"]);
    assert.equal(listed.profiles[0].id, "recent");
    assert.deepEqual(listed.profiles[0].badges, ["recent", "default"]);
    assert.equal(listed.profiles.filter((row) => row.config.model === "default").length, 1);
  } finally {
    cleanupDir(workspace);
  }
});

test("the CLI resolves fixed Claude picker profiles before dispatch", () => {
  const workspace = makeTempDir();
  try {
    const sonnet = runConfig(workspace, [
      "resolve",
      "--target", "claude",
      "--profile", "model:sonnet",
    ]);
    assert.equal(sonnet.status, "ok");
    assert.deepEqual(sonnet.config, {
      model: "sonnet",
      effort: "medium",
      access: "default",
    });
    assert.equal(sonnet.usedInitialDefault, false);
  } finally {
    cleanupDir(workspace);
  }
});

test("the recent picker profile uses the MRU and has an explicit first-use fallback", () => {
  const workspace = makeTempDir();
  try {
    const firstUse = runConfig(workspace, [
      "resolve",
      "--target", "claude",
      "--profile", "recent",
    ]);
    assert.equal(firstUse.status, "ok");
    assert.equal(firstUse.resolvedFrom, "default");
    assert.equal(firstUse.usedInitialDefault, true);
    assert.deepEqual(firstUse.config, {
      model: "default",
      effort: "medium",
      access: "default",
    });

    runConfig(workspace, [
      "record",
      "--target", "claude",
      "--model", "opus",
      "--effort", "high",
      "--access", "plan",
    ]);
    const recent = runConfig(workspace, [
      "resolve",
      "--target", "claude",
      "--profile", "recent",
    ]);
    assert.equal(recent.status, "ok");
    assert.equal(recent.resolvedFrom, "recent");
    assert.equal(recent.usedInitialDefault, false);
    assert.deepEqual(recent.config, {
      model: "opus",
      effort: "high",
      access: "plan",
    });
  } finally {
    cleanupDir(workspace);
  }
});

test("the CLI rejects an unknown picker profile without recording state", () => {
  const workspace = makeTempDir();
  try {
    const resolved = runConfig(workspace, [
      "resolve",
      "--target", "claude",
      "--profile", "model:unknown",
    ]);
    assert.equal(resolved.status, "error");
    assert.equal(resolved.errorCode, "profile_resolution_failed");
    const recent = runConfig(workspace, ["recent", "--target", "claude"]);
    assert.equal(recent.recent, null);
  } finally {
    cleanupDir(workspace);
  }
});
