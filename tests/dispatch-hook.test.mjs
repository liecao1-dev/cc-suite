import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { cleanupDir, makeTempDir, withIsolatedEnv } from "./helpers.mjs";
import {
  claimDispatchTicket,
  savePendingDispatch,
} from "../scripts/lib/dispatch-state.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const HOOK = path.join(ROOT, "scripts", "dispatch-hook.mjs");

function managedProject() {
  const root = makeTempDir("cc-suite-dispatch-hook-");
  const child = path.join(root, "app");
  fs.mkdirSync(path.join(root, ".cc-suite"), { recursive: true });
  fs.mkdirSync(child);
  fs.writeFileSync(path.join(root, ".cc-suite", "project.json"), `${JSON.stringify({
    schema: 1,
    managedBy: "cc-suite",
    sourceRoot: ROOT,
    scopeRoot: root,
  }, null, 2)}\n`);
  return { root, child };
}

function runHook(project, input, host = "claude", target = "codex", extraEnv = {}) {
  return spawnSync(process.execPath, [HOOK, "--host", host, "--target", target], {
    cwd: project.child,
    env: { ...process.env, ...extraEnv },
    input: JSON.stringify({ cwd: project.child, ...input }),
    encoding: "utf8",
  });
}

test("the next ordinary prompt receives a locked one-shot executor ticket", () => {
  withIsolatedEnv({ CLAUDE_PLUGIN_DATA: undefined }, () => {
    const project = managedProject();
    try {
      const config = {
        model: "gpt-5.6-sol",
        effort: "max",
        access: "workspace-write",
        approval: "on-request",
      };
      savePendingDispatch(project.child, {
        host: "claude",
        target: "codex",
        sessionId: "hook-session",
        config,
        selectedProfile: "recent",
      });

      const result = runHook(project, {
        hook_event_name: "UserPromptSubmit",
        session_id: "hook-session",
        prompt: "请检查这个项目",
      });
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      const context = output.hookSpecificOutput.additionalContext;
      assert.match(context, /one-shot dispatch ticket/);
      assert.match(context, /Do not answer, solve/);
      assert.match(context, /gpt-5\.6-sol · max · sandbox=workspace-write · approval=on-request/);
      assert.match(context, /before sending the next task or follow-up.*select \/codex/s);
      const token = context.match(/--ticket "([a-f0-9]{32})"/)?.[1];
      assert.ok(token);
      assert.deepEqual(claimDispatchTicket(project.child, token).config, config);
    } finally {
      cleanupDir(project.root);
    }
  });
});

test("control commands do not consume the pending dispatch", () => {
  withIsolatedEnv({ CLAUDE_PLUGIN_DATA: undefined }, () => {
    const project = managedProject();
    try {
      savePendingDispatch(project.child, {
        host: "codex",
        target: "claude",
        sessionId: "codex-session",
        config: { model: "opus", effort: "high", access: "plan" },
      });
      const control = runHook(project, {
        hook_event_name: "UserPromptSubmit",
        session_id: "codex-session",
        prompt: "$some-other-skill",
      }, "codex", "claude");
      assert.equal(control.status, 0, control.stderr);
      assert.equal(control.stdout, "");

      const task = runHook(project, {
        hook_event_name: "UserPromptSubmit",
        session_id: "codex-session",
        prompt: "现在执行",
      }, "codex", "claude");
      assert.match(JSON.parse(task.stdout).hookSpecificOutput.additionalContext, /Locked target configuration: opus/);
    } finally {
      cleanupDir(project.root);
    }
  });
});

test("a submitted $claude fails closed while $claude-workflow-sync stays unrelated", () => {
  withIsolatedEnv({ CLAUDE_PLUGIN_DATA: undefined }, () => {
    const project = managedProject();
    try {
      const combined = runHook(project, {
        hook_event_name: "UserPromptSubmit",
        session_id: "codex-trigger-session",
        prompt: "$claude 帮我检查",
      }, "codex", "claude");
      const blocked = JSON.parse(combined.stdout);
      assert.equal(blocked.decision, "block");
      assert.match(blocked.reason, /\$claude 不应作为消息发送/);
      assert.match(blocked.reason, /发送前 composer 代理/);

      const unrelated = runHook(project, {
        hook_event_name: "UserPromptSubmit",
        session_id: "codex-trigger-session",
        prompt: "$claude-workflow-sync",
      }, "codex", "claude");
      assert.equal(unrelated.stdout, "");
    } finally {
      cleanupDir(project.root);
    }
  });
});

test("the composer session binds a pre-send selection before the native hook session exists", () => {
  withIsolatedEnv({ CLAUDE_PLUGIN_DATA: undefined }, () => {
    const project = managedProject();
    const composerSession = "c".repeat(32);
    try {
      savePendingDispatch(project.child, {
        host: "claude",
        target: "codex",
        sessionId: composerSession,
        config: {
          model: "gpt-5.6-sol",
          effort: "ultra",
          access: "workspace-write",
          approval: "on-request",
        },
      });
      const task = runHook(project, {
        hook_event_name: "UserPromptSubmit",
        session_id: "native-hook-session",
        prompt: "发送即开始派遣",
      }, "claude", "codex", {
        CC_SUITE_COMPOSER_HOST: "claude",
        CC_SUITE_COMPOSER_SESSION: composerSession,
      });
      assert.equal(task.status, 0, task.stderr);
      assert.match(JSON.parse(task.stdout).hookSpecificOutput.additionalContext, /gpt-5\.6-sol · ultra/);
    } finally {
      cleanupDir(project.root);
    }
  });
});
