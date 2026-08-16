import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { cleanupDir, makeTempDir } from "./helpers.mjs";
import {
  catalogFromClaudeHelp,
  catalogFromCodexModelsCache,
  readTopLevelTomlConfig,
} from "../scripts/lib/dispatch-catalog.mjs";

test("Codex catalog preserves each model's own reasoning choices and default", () => {
  const catalog = catalogFromCodexModelsCache({ models: [
    {
      slug: "gpt-5.6-sol",
      display_name: "GPT 5.6 Sol",
      description: "Latest frontier",
      default_reasoning_level: "low",
      supported_reasoning_levels: [
        { effort: "low", description: "Fast" },
        { effort: "medium", description: "Balanced" },
        { effort: "ultra", description: "Deepest" },
      ],
    },
    {
      slug: "gpt-5.5",
      display_name: "GPT 5.5",
      default_reasoning_level: "medium",
      supported_reasoning_levels: [{ effort: "medium" }, { effort: "high" }],
    },
  ] });

  assert.deepEqual(catalog.models, ["gpt-5.6-sol", "gpt-5.5"]);
  assert.deepEqual(catalog.modelsDetail[0].reasoning_efforts, ["low", "medium", "ultra"]);
  assert.equal(catalog.modelsDetail[0].default_reasoning_effort, "low");
  assert.deepEqual(catalog.modelsDetail[1].reasoning_efforts, ["medium", "high"]);
  assert.equal(catalog.modelsDetail[1].default_reasoning_effort, "medium");
});

test("Claude catalog follows the current CLI's global effort and permission rules", () => {
  const help = `Usage: claude [options]\n\nOptions:\n  --effort <level>  Effort (low, medium, high, max)\n  --model <model>   Alias such as 'fable', 'opus', or 'sonnet'\n  --permission-mode <mode>  Permission (choices: "acceptEdits", "auto", "bypassPermissions", "plan")\n  --version         Print version\n`;
  const catalog = catalogFromClaudeHelp(help, "9.9.9");

  assert.deepEqual(catalog.models, ["fable", "opus", "sonnet", "haiku"]);
  assert.deepEqual(catalog.efforts, ["low", "medium", "high", "max"]);
  assert.deepEqual(catalog.access, ["default", "acceptEdits", "auto", "bypassPermissions", "plan"]);
  assert.deepEqual(catalog.modelsDetail[0].reasoning_efforts, catalog.efforts);
  assert.match(catalog.metadata.capabilityScope, /globally/);
  assert.equal(catalog.metadata.claudeVersion, "9.9.9");
});

test("top-level Codex defaults are read without leaking values from TOML tables", () => {
  const directory = makeTempDir("cc-suite-toml-");
  try {
    const file = path.join(directory, "config.toml");
    fs.writeFileSync(file, [
      'model = "gpt-5.6-sol"',
      'model_reasoning_effort = "max"',
      'sandbox_mode = "workspace-write"',
      'approval_policy = "on-request"',
      "",
      "[profiles.other]",
      'model = "must-not-win"',
      "",
    ].join("\n"));
    assert.deepEqual(readTopLevelTomlConfig(file), {
      model: "gpt-5.6-sol",
      model_reasoning_effort: "max",
      sandbox_mode: "workspace-write",
      approval_policy: "on-request",
    });
  } finally {
    cleanupDir(directory);
  }
});
