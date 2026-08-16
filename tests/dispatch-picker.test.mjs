import test from "node:test";
import assert from "node:assert/strict";

import {
  cycleConfigField,
  isRiskyConfig,
  pickerFields,
  runPreparedPicker,
} from "../scripts/dispatch-picker.mjs";

const catalog = {
  models: ["gpt-sol", "gpt-luna"],
  modelsDetail: [
    { slug: "gpt-sol", reasoning_efforts: ["low", "medium", "high", "ultra"] },
    { slug: "gpt-luna", reasoning_efforts: ["low", "medium", "high"] },
  ],
  efforts: ["low", "medium", "high", "ultra"],
  access: ["read-only", "workspace-write", "danger-full-access"],
  approvals: ["untrusted", "on-request", "never"],
};

class FakeTerminal {
  constructor(keys) {
    this.keys = [...keys];
    this.frames = [];
  }

  draw(lines) {
    this.frames.push(lines.join("\n"));
  }

  readKey() {
    assert.ok(this.keys.length, "picker requested an unexpected extra key");
    return this.keys.shift();
  }
}

function prepared(config) {
  return {
    catalog,
    defaultConfig: config,
    defaultSource: "fixture defaults",
    recentUnavailable: false,
    profiles: [
      {
        id: "recent",
        badges: ["recent"],
        label: "最近配置",
        description: "gpt-sol · low · sandbox=read-only · approval=on-request · 2026-08-16T00:00:00Z",
        config,
      },
      {
        id: "default",
        badges: ["default"],
        label: "默认配置",
        description: "gpt-sol · low · sandbox=read-only · approval=on-request · 来源：fixture defaults",
        config,
      },
    ],
  };
}

test("picker fields use the selected Codex model's exact reasoning levels", () => {
  const fields = pickerFields("codex", {
    model: "gpt-luna",
    effort: "medium",
    access: "workspace-write",
    approval: "on-request",
  }, catalog);
  assert.deepEqual(fields.map((field) => field.key), ["effort", "access", "approval"]);
  assert.deepEqual(fields[0].values, ["low", "medium", "high"]);
  assert.equal(fields[0].values.includes("ultra"), false);
});

test("Enter opens one compact row and arrow keys edit fields before confirmation", () => {
  const initial = {
    model: "gpt-sol",
    effort: "low",
    access: "read-only",
    approval: "on-request",
  };
  const terminal = new FakeTerminal([
    "enter",      // open recent row
    "right",      // effort: low -> medium
    "down",
    "right",      // access: read-only -> workspace-write
    "down",
    "right",      // approval: on-request -> never
    "enter",      // confirm
  ]);
  const result = runPreparedPicker({ target: "codex", prepared: prepared(initial), terminal });

  assert.deepEqual(result.config, {
    model: "gpt-sol",
    effort: "medium",
    access: "workspace-write",
    approval: "never",
  });
  assert.equal(result.profileId, "recent");
  assert.match(terminal.frames[0], /最近配置/);
  assert.match(terminal.frames[0], /2026-08-16T00:00:00Z/);
  assert.match(terminal.frames[0], /默认配置/);
  assert.match(terminal.frames[0], /来源：fixture defaults/);
  assert.match(terminal.frames.at(-1), /审批策略/);
});

test("dangerous access requires two consecutive Enter confirmations", () => {
  const initial = {
    model: "gpt-sol",
    effort: "low",
    access: "danger-full-access",
    approval: "never",
  };
  const terminal = new FakeTerminal(["enter", "enter", "enter"]);
  const result = runPreparedPicker({ target: "codex", prepared: prepared(initial), terminal });
  assert.equal(result.config.access, "danger-full-access");
  assert.match(terminal.frames.at(-1), /再次按 Enter 才确认/);
  assert.equal(isRiskyConfig("codex", result.config), true);
  assert.equal(isRiskyConfig("claude", { access: "bypassPermissions" }), true);
});

test("field cycling wraps without inventing unsupported combinations", () => {
  const field = { key: "effort", values: ["low", "medium", "high"] };
  assert.equal(cycleConfigField({ effort: "low" }, field, -1).effort, "high");
  assert.equal(cycleConfigField({ effort: "high" }, field, 1).effort, "low");
});
