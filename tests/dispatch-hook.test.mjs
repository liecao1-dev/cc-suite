import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { cleanupDir, makeTempDir, withIsolatedEnv } from "./helpers.mjs";
import {
  claimDispatchTicket,
  recordExactClaudeResponse,
  savePendingDispatch,
} from "../scripts/lib/dispatch-state.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const HOOK = path.join(ROOT, "scripts", "dispatch-hook.mjs");

function managedProject() {
  const root = makeTempDir("cc-suite-dispatch-hook-");
  const child = path.join(root, "app");
  fs.mkdirSync(child);
  return { root, child };
}

function runHook(project, input, host = "claude", target = "codex", extraEnv = {}) {
  return spawnSync(process.execPath, [HOOK, "--host", host, "--target", target], {
    cwd: project.child,
    env: {
      ...process.env,
      CC_SUITE_SCOPE_ROOT: project.root,
      CC_SUITE_WORKSPACE_ROOT: project.root,
      ...extraEnv,
    },
    input: JSON.stringify({ cwd: project.child, ...input }),
    encoding: "utf8",
  });
}

test("the next ordinary prompt receives a locked one-shot executor ticket", () => {
  withIsolatedEnv({ CLAUDE_PLUGIN_DATA: undefined }, () => {
    const project = managedProject();
    process.env.CC_SUITE_SCOPE_ROOT = project.root;
    process.env.CC_SUITE_WORKSPACE_ROOT = project.root;
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
      assert.match(context, /self-contained delegation prompt/);
      assert.match(context, /Relevant host conversation context/);
      assert.match(context, /Do not copy hidden system\/developer instructions/);
      assert.match(context, /Prepare the complete delegation prompt before starting/);
      assert.match(context, /exactly once with tty=false/);
      assert.match(context, /poll that same session with empty input/);
      assert.match(context, /ticket was not consumed because stdin was a TTY/);
      assert.doesNotMatch(context, /Run the current user prompt verbatim through/);
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

test("a host bound before a nested repository was created consumes that repository's selection", () => {
  withIsolatedEnv({}, () => {
    const project = managedProject();
    process.env.CC_SUITE_SCOPE_ROOT = project.root;
    try {
      // The composer/broker retain their launch boundary, while a later picker
      // discovers the newly initialized project inside it.
      assert.equal(spawnSync("git", ["init", "-q"], { cwd: project.child }).status, 0);
      process.env.CC_SUITE_WORKSPACE_ROOT = project.child;
      savePendingDispatch(project.child, {
        host: "codex", target: "claude", sessionId: "nested-project-session",
        config: { model: "haiku", effort: "low", access: "default" },
      });
      const result = runHook(project, {
        hook_event_name: "UserPromptSubmit",
        session_id: "nested-project-session", prompt: "Reply with OK",
      }, "codex", "claude");
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /one-shot dispatch ticket/);
      const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
      const token = context.match(/--ticket "([a-f0-9]{32})"/)?.[1];
      assert.ok(token);
      // The broker's executor also inherits the original parent boundary.
      process.env.CC_SUITE_WORKSPACE_ROOT = project.root;
      assert.equal(claimDispatchTicket(project.child, token).projectRoot, fs.realpathSync(project.child));

      const outside = runHook(project, {
        cwd: project.root, hook_event_name: "UserPromptSubmit",
        session_id: "nested-project-session", prompt: "Reply with OK",
      }, "codex", "claude", { CC_SUITE_WORKSPACE_ROOT: project.child });
      assert.equal(outside.stdout, "", "a narrower workspace must still reject its parent");
    } finally {
      cleanupDir(project.root);
    }
  });
});

test("control commands do not consume the pending dispatch", () => {
  withIsolatedEnv({ CLAUDE_PLUGIN_DATA: undefined }, () => {
    const project = managedProject();
    process.env.CC_SUITE_SCOPE_ROOT = project.root;
    process.env.CC_SUITE_WORKSPACE_ROOT = project.root;
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
      const context = JSON.parse(task.stdout).hookSpecificOutput.additionalContext;
      assert.match(context, /Locked target configuration: opus/);
      assert.match(context, /preserve rawOutput exactly, character for character/);
      assert.match(context, /回答来自Claude。 is the only permitted addition/);
      assert.match(context, /scope-owned user-level Stop hook will compare/);
    } finally {
      cleanupDir(project.root);
    }
  });
});

test("Codex Stop requires exact Claude output followed by the fixed attribution", () => {
  withIsolatedEnv({ CLAUDE_PLUGIN_DATA: undefined }, () => {
    const project = managedProject();
    process.env.CC_SUITE_SCOPE_ROOT = project.root;
    process.env.CC_SUITE_WORKSPACE_ROOT = project.root;
    const exact = "  Claude says this.\n第二行\n";
    try {
      recordExactClaudeResponse(project.child, {
        host: "codex",
        target: "claude",
        hostSessionId: "codex-native-session",
        jobId: "claude-dispatch-job-2",
        rawOutput: exact,
      });

      const missingAttribution = runHook(project, {
        hook_event_name: "Stop",
        session_id: "codex-native-session",
        turn_id: "turn-a",
        stop_hook_active: false,
        last_assistant_message: exact,
      }, "codex", "claude");
      assert.equal(missingAttribution.status, 0, missingAttribution.stderr);
      const blocked = JSON.parse(missingAttribution.stdout);
      assert.equal(blocked.decision, "block");
      assert.match(blocked.reason, /attributed Claude relay check failed/);
      const required = `${exact}回答来自Claude。`;
      assert.ok(blocked.reason.includes(`Required final message JSON string: ${JSON.stringify(required)}`));

      const duplicateAttribution = runHook(project, {
        hook_event_name: "Stop",
        session_id: "codex-native-session",
        turn_id: "turn-a",
        stop_hook_active: true,
        last_assistant_message: `${required}\n回答来自Claude。`,
      }, "codex", "claude");
      assert.equal(JSON.parse(duplicateAttribution.stdout).decision, "block");

      const matched = runHook(project, {
        hook_event_name: "Stop",
        session_id: "codex-native-session",
        turn_id: "turn-a",
        stop_hook_active: true,
        last_assistant_message: required,
      }, "codex", "claude");
      assert.equal(matched.status, 0, matched.stderr);
      assert.equal(matched.stdout, "");

      const alreadyConsumed = runHook(project, {
        hook_event_name: "Stop",
        session_id: "codex-native-session",
        last_assistant_message: "unrelated later answer",
      }, "codex", "claude");
      assert.equal(alreadyConsumed.stdout, "");
    } finally {
      cleanupDir(project.root);
    }
  });
});

test("a submitted $claude fails closed while $claude-workflow-sync stays unrelated", () => {
  withIsolatedEnv({ CLAUDE_PLUGIN_DATA: undefined }, () => {
    const project = managedProject();
    process.env.CC_SUITE_SCOPE_ROOT = project.root;
    process.env.CC_SUITE_WORKSPACE_ROOT = project.root;
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
    process.env.CC_SUITE_SCOPE_ROOT = project.root;
    process.env.CC_SUITE_WORKSPACE_ROOT = project.root;
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
      const context = JSON.parse(task.stdout).hookSpecificOutput.additionalContext;
      assert.match(context, /gpt-5\.6-sol · ultra/);
      const token = context.match(/--ticket "([a-f0-9]{32})"/)?.[1];
      const ticket = claimDispatchTicket(project.child, token);
      assert.equal(ticket.sessionId, composerSession);
      assert.equal(ticket.hostSessionId, "native-hook-session");
    } finally {
      cleanupDir(project.root);
    }
  });
});
