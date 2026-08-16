import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { cleanupDir, makeTempDir, withIsolatedEnv } from "./helpers.mjs";
import {
  PENDING_TTL_MS,
  claimDispatchTicket,
  recentDispatchRecord,
  recordRecentDispatch,
  savePendingDispatch,
  ticketForSubmittedPrompt,
} from "../scripts/lib/dispatch-state.mjs";

function managedProject() {
  const root = makeTempDir("cc-suite-dispatch-state-");
  const child = path.join(root, "packages", "app");
  fs.mkdirSync(path.join(root, ".cc-suite"), { recursive: true });
  fs.mkdirSync(child, { recursive: true });
  fs.writeFileSync(path.join(root, ".cc-suite", "project.json"), `${JSON.stringify({
    schema: 1,
    managedBy: "cc-suite",
    sourceRoot: "/fixture/cc-suite",
    scopeRoot: root,
  }, null, 2)}\n`);
  return { root, child };
}

const config = Object.freeze({
  model: "gpt-5.6-sol",
  effort: "high",
  access: "workspace-write",
  approval: "on-request",
});

test("pending selection survives control prompts and becomes one one-shot ticket", () => {
  withIsolatedEnv({ CLAUDE_PLUGIN_DATA: undefined }, () => {
    const project = managedProject();
    try {
      savePendingDispatch(project.child, {
        host: "claude",
        target: "codex",
        sessionId: "session-a",
        config,
        selectedProfile: "model:gpt-5.6-sol",
      }, 1_000);

      assert.deepEqual(ticketForSubmittedPrompt(project.child, {
        host: "claude",
        sessionId: "session-a",
        prompt: "/status",
      }, 1_100), { status: "control" });
      assert.equal(ticketForSubmittedPrompt(project.child, {
        host: "claude",
        sessionId: "different-session",
        prompt: "do not steal the pending task",
      }, 1_200).status, "none");

      const ready = ticketForSubmittedPrompt(project.child, {
        host: "claude",
        sessionId: "session-a",
        prompt: "完成这个任务",
      }, 1_300);
      assert.equal(ready.status, "ready");
      assert.equal(ready.ticket.selectedCwd, fs.realpathSync(project.child));
      assert.deepEqual(ready.ticket.config, config);

      const claimed = claimDispatchTicket(project.root, ready.ticket.token, 1_400);
      assert.equal(claimed.token, ready.ticket.token);
      assert.throws(
        () => claimDispatchTicket(project.root, ready.ticket.token, 1_500),
        /missing, expired, or already used/,
      );
      assert.equal(ticketForSubmittedPrompt(project.child, {
        host: "claude",
        sessionId: "session-a",
        prompt: "第二项任务",
      }, 1_600).status, "none");
    } finally {
      cleanupDir(project.root);
    }
  });
});

test("expired pending selection is consumed and reported instead of silently routing", () => {
  withIsolatedEnv({ CLAUDE_PLUGIN_DATA: undefined }, () => {
    const project = managedProject();
    try {
      savePendingDispatch(project.root, {
        host: "codex",
        target: "claude",
        sessionId: "session-expired",
        config: { model: "opus", effort: "medium", access: "default" },
      }, 10_000);
      const expired = ticketForSubmittedPrompt(project.root, {
        host: "codex",
        sessionId: "session-expired",
        prompt: "晚到的任务",
      }, 10_000 + PENDING_TTL_MS);
      assert.equal(expired.status, "expired");
      assert.equal(ticketForSubmittedPrompt(project.root, {
        host: "codex",
        sessionId: "session-expired",
        prompt: "不会自动复用",
      }, 10_001 + PENDING_TTL_MS).status, "none");
    } finally {
      cleanupDir(project.root);
    }
  });
});

test("recent configuration stores the exact tuple and use timestamp per target", () => {
  withIsolatedEnv({ CLAUDE_PLUGIN_DATA: undefined }, () => {
    const project = managedProject();
    try {
      const usedAt = "2026-08-16T08:00:00.000Z";
      recordRecentDispatch(project.root, "codex", config, usedAt);
      assert.deepEqual(recentDispatchRecord(project.child, "codex"), { config, usedAt });
      assert.equal(recentDispatchRecord(project.child, "claude"), null);
    } finally {
      cleanupDir(project.root);
    }
  });
});
