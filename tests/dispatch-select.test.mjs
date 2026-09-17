import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { selectDispatchBeforeSend } from "../scripts/dispatch-select.mjs";
import {
  savePendingDispatch,
  ticketForSubmittedPrompt,
} from "../scripts/lib/dispatch-state.mjs";
import { cleanupDir, makeTempDir, withIsolatedEnv } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

function managedProject() {
  const root = makeTempDir("cc-suite-pre-send-select-");
  const child = path.join(root, "app");
  fs.mkdirSync(child);
  return { root, child };
}

test("composer selection arms one dispatch before any task is submitted", () => {
  withIsolatedEnv({ CLAUDE_PLUGIN_DATA: undefined }, () => {
    const project = managedProject();
    process.env.CC_SUITE_SCOPE_ROOT = project.root;
    process.env.CC_SUITE_WORKSPACE_ROOT = project.root;
    try {
      const config = { model: "opus", effort: "high", access: "plan" };
      const result = selectDispatchBeforeSend({
        host: "codex",
        target: "claude",
        cwd: project.child,
        sessionId: "a".repeat(32),
        picker: () => ({
          cancelled: false,
          config,
          profileId: "model:opus",
          catalogVersion: "2.1.233",
        }),
      });
      assert.equal(result.status, "selected");
      assert.match(result.description, /opus · high · permission=plan/);

      const ready = ticketForSubmittedPrompt(project.child, {
        host: "codex",
        sessionId: "a".repeat(32),
        prompt: "真正发送的任务",
      });
      assert.equal(ready.status, "ready");
      assert.deepEqual(ready.ticket.config, config);
    } finally {
      cleanupDir(project.root);
    }
  });
});

test("cancelling the pre-send picker leaves no dispatch armed", () => {
  withIsolatedEnv({ CLAUDE_PLUGIN_DATA: undefined }, () => {
    const project = managedProject();
    process.env.CC_SUITE_SCOPE_ROOT = project.root;
    process.env.CC_SUITE_WORKSPACE_ROOT = project.root;
    const sessionId = "b".repeat(32);
    try {
      savePendingDispatch(project.child, {
        host: "claude",
        target: "codex",
        sessionId,
        config: {
          model: "gpt-5.6-sol",
          effort: "max",
          access: "workspace-write",
          approval: "on-request",
        },
      });
      assert.deepEqual(selectDispatchBeforeSend({
        host: "claude",
        target: "codex",
        cwd: project.child,
        sessionId,
        picker: () => ({ cancelled: true }),
      }), { status: "cancelled" });
      assert.equal(ticketForSubmittedPrompt(project.child, {
        host: "claude",
        sessionId,
        prompt: "不应派遣",
      }).status, "none");
    } finally {
      cleanupDir(project.root);
    }
  });
});
