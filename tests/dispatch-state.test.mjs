import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { cleanupDir, makeTempDir, withIsolatedEnv } from "./helpers.mjs";
import {
  PENDING_TTL_MS,
  MAX_PROGRAMMATIC_ACTIVE_REQUESTS,
  MAX_PROGRAMMATIC_TERMINAL_REQUESTS,
  PROGRAMMATIC_CLAIM_STALL_MS,
  PROGRAMMATIC_TERMINAL_RETENTION_MS,
  TICKET_TTL_MS,
  attributedClaudeResponse,
  claimDispatchTicket,
  configureProjectStateRoot,
  finishProgrammaticDispatch,
  prepareProgrammaticDispatch,
  readProgrammaticDispatch,
  recordExactClaudeResponse,
  recentDispatchRecord,
  recordDispatchConversation,
  recordRecentDispatch,
  savePendingDispatch,
  ticketForSubmittedPrompt,
  verifyExactClaudeResponse,
} from "../scripts/lib/dispatch-state.mjs";
import { getConfig, updateState } from "../scripts/lib/state.mjs";

test("Claude attribution starts on the next line without adding a blank line", () => {
  assert.equal(attributedClaudeResponse("Claude answer"), "Claude answer\n回答来自Claude。");
  assert.equal(attributedClaudeResponse("Claude answer\n"), "Claude answer\n回答来自Claude。");
  assert.equal(attributedClaudeResponse("Claude answer\n\n"), "Claude answer\n\n回答来自Claude。");
});

function managedProject() {
  const root = makeTempDir("cc-suite-dispatch-state-");
  const child = path.join(root, "packages", "app");
  fs.mkdirSync(child, { recursive: true });
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
    process.env.CC_SUITE_SCOPE_ROOT = project.root;
    process.env.CC_SUITE_WORKSPACE_ROOT = project.root;
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
      assert.equal(ready.ticket.hostSessionId, "session-a");
      assert.equal(ready.ticket.resumeThreadId, null);

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

test("programmatic requests reuse one hidden ticket and reject conflicting request ids", () => {
  withIsolatedEnv({ CLAUDE_PLUGIN_DATA: undefined }, () => {
    const project = managedProject();
    process.env.CC_SUITE_SCOPE_ROOT = project.root;
    process.env.CC_SUITE_WORKSPACE_ROOT = project.root;
    const payload = {
      host: "codex",
      target: "claude",
      sessionId: "a".repeat(32),
      requestId: "workflow-run-17",
      conversationId: "research-thread",
      config: { model: "opus", effort: "low", access: "dontAsk" },
      prompt: "只执行一次",
    };
    try {
      const first = prepareProgrammaticDispatch(project.child, payload, 1_000);
      assert.equal(first.status, "ready");
      assert.equal(first.reused, false);
      assert.equal(first.ticket.selectedProfile, "programmatic");
      assert.equal(first.ticket.exactRelay, false);
      assert.equal(first.ticket.hostSessionId, "programmatic:research-thread");

      const duplicate = prepareProgrammaticDispatch(project.child, payload, 1_100);
      assert.equal(duplicate.status, "ready");
      assert.equal(duplicate.reused, true);
      assert.equal(duplicate.ticket.token, first.ticket.token);

      const conflict = prepareProgrammaticDispatch(project.child, {
        ...payload,
        prompt: "同一 id 的不同任务",
      }, 1_200);
      assert.equal(conflict.status, "conflict");
      assert.equal(conflict.requestKey, first.requestKey);

      const refreshed = prepareProgrammaticDispatch(project.child, payload, 1_000 + TICKET_TTL_MS);
      assert.equal(refreshed.status, "ready");
      assert.equal(refreshed.reused, true);
      assert.notEqual(refreshed.ticket.token, first.ticket.token);
      assert.throws(
        () => claimDispatchTicket(project.child, first.ticket.token, 1_001 + TICKET_TTL_MS),
        /missing, expired, or already used/,
      );
    } finally {
      cleanupDir(project.root);
    }
  });
});

test("a claimed programmatic request never mints another ticket and keeps only terminal metadata", () => {
  withIsolatedEnv({ CLAUDE_PLUGIN_DATA: undefined }, () => {
    const project = managedProject();
    process.env.CC_SUITE_SCOPE_ROOT = project.root;
    process.env.CC_SUITE_WORKSPACE_ROOT = project.root;
    const payload = {
      host: "codex",
      target: "claude",
      sessionId: "b".repeat(32),
      requestId: "workflow-run-18",
      conversationId: "research-thread",
      config: { model: "opus", effort: "low", access: "dontAsk" },
      prompt: "不可重放",
    };
    try {
      const prepared = prepareProgrammaticDispatch(project.child, payload, 2_000);
      assert.throws(
        () => claimDispatchTicket(project.child, prepared.ticket.token, 2_050, "篡改后的任务"),
        /does not match its programmatic request/,
      );
      const claimed = claimDispatchTicket(
        project.child,
        prepared.ticket.token,
        2_100,
        payload.prompt,
      );
      assert.equal(claimed.programmaticRequestKey, prepared.requestKey);
      const afterClaim = prepareProgrammaticDispatch(project.child, payload, 2_200);
      assert.equal(afterClaim.status, "claimed");
      assert.throws(
        () => claimDispatchTicket(project.child, prepared.ticket.token, 2_300),
        /missing, expired, or already used/,
      );

      const rawOutput = "x".repeat(100_000);
      finishProgrammaticDispatch(project.child, prepared.requestKey, {
        status: "completed",
        jobId: "claude-dispatch-job-18",
        threadId: "12345678-1234-4234-8234-123456789abc",
        target: "claude",
        config: payload.config,
        rawOutput,
        contextSaved: true,
      }, 2_400);
      const terminal = prepareProgrammaticDispatch(project.child, payload, 2_500);
      assert.equal(terminal.status, "terminal");
      assert.equal(terminal.request.status, "completed");
      assert.equal(terminal.request.terminal.jobId, "claude-dispatch-job-18");
      assert.equal(Object.hasOwn(terminal.request.terminal, "rawOutput"), false);
      assert.equal(JSON.stringify(readProgrammaticDispatch(project.child, prepared.requestKey)).includes(rawOutput), false);
    } finally {
      cleanupDir(project.root);
    }
  });
});

test("programmatic delivery and tool policy are explicit parts of the request identity", () => {
  withIsolatedEnv({ CLAUDE_PLUGIN_DATA: undefined }, () => {
    const project = managedProject();
    process.env.CC_SUITE_SCOPE_ROOT = project.root;
    process.env.CC_SUITE_WORKSPACE_ROOT = project.root;
    const payload = {
      host: "codex",
      target: "claude",
      sessionId: "e".repeat(32),
      requestId: "host-relay-request",
      conversationId: "native-host-session",
      delivery: "host-relay",
      toolPolicy: "none",
      config: { model: "opus", effort: "low", access: "dontAsk" },
      prompt: "原样转发",
    };
    try {
      const prepared = prepareProgrammaticDispatch(project.child, payload, 3_000);
      assert.equal(prepared.ticket.delivery, "host-relay");
      assert.equal(prepared.ticket.toolPolicy, "none");
      assert.equal(prepared.ticket.hostSessionId, "native-host-session");
      assert.equal(prepared.ticket.exactRelay, true);
      assert.equal(prepareProgrammaticDispatch(project.child, {
        ...payload,
        delivery: "workflow",
      }, 3_100).status, "conflict");
      assert.equal(prepareProgrammaticDispatch(project.child, {
        ...payload,
        toolPolicy: "standard",
      }, 3_200).status, "conflict");
    } finally {
      cleanupDir(project.root);
    }
  });
});

test("an overdue claimed request atomically becomes stalled and can never run again", () => {
  withIsolatedEnv({ CLAUDE_PLUGIN_DATA: undefined }, () => {
    const project = managedProject();
    process.env.CC_SUITE_SCOPE_ROOT = project.root;
    process.env.CC_SUITE_WORKSPACE_ROOT = project.root;
    const payload = {
      host: "codex",
      target: "claude",
      sessionId: "f".repeat(32),
      requestId: "stalled-request",
      conversationId: "stalled-conversation",
      config: { model: "opus", effort: "low", access: "dontAsk" },
      prompt: "只能执行一次",
    };
    try {
      const prepared = prepareProgrammaticDispatch(project.child, payload, 10_000);
      claimDispatchTicket(project.child, prepared.ticket.token, 10_100, payload.prompt);

      assert.equal(
        prepareProgrammaticDispatch(
          project.child,
          payload,
          10_100 + PROGRAMMATIC_CLAIM_STALL_MS - 1,
        ).status,
        "claimed",
      );

      const observed = readProgrammaticDispatch(
        project.child,
        prepared.requestKey,
        10_100 + PROGRAMMATIC_CLAIM_STALL_MS,
      );
      assert.equal(observed.status, "stalled");
      assert.equal(observed.terminal.status, "stalled");
      assert.match(observed.terminal.error, /will not be run again/);

      const replay = prepareProgrammaticDispatch(
        project.child,
        payload,
        10_101 + PROGRAMMATIC_CLAIM_STALL_MS,
      );
      assert.equal(replay.status, "terminal");
      assert.equal(replay.request.status, "stalled");
      assert.equal(replay.request.ticketToken, prepared.ticket.token);

      const lateFinish = finishProgrammaticDispatch(project.child, prepared.requestKey, {
        status: "completed",
        jobId: "too-late",
      }, 10_102 + PROGRAMMATIC_CLAIM_STALL_MS);
      assert.equal(lateFinish.status, "stalled");
      assert.notEqual(lateFinish.terminal.jobId, "too-late");
      assert.throws(
        () => claimDispatchTicket(
          project.child,
          prepared.ticket.token,
          10_103 + PROGRAMMATIC_CLAIM_STALL_MS,
          payload.prompt,
        ),
        /missing, expired, or already used/,
      );
    } finally {
      cleanupDir(project.root);
    }
  });
});

test("one typed conversation rejects a second active request without creating a queue", () => {
  withIsolatedEnv({ CLAUDE_PLUGIN_DATA: undefined }, () => {
    const project = managedProject();
    process.env.CC_SUITE_SCOPE_ROOT = project.root;
    process.env.CC_SUITE_WORKSPACE_ROOT = project.root;
    const firstPayload = {
      host: "codex",
      target: "claude",
      sessionId: "1".repeat(32),
      requestId: "conversation-first",
      conversationId: "shared-conversation",
      config: { model: "opus", effort: "low", access: "dontAsk" },
      prompt: "第一项",
    };
    const secondPayload = {
      ...firstPayload,
      requestId: "conversation-second",
      prompt: "第二项",
    };
    try {
      const first = prepareProgrammaticDispatch(project.child, firstPayload, 20_000);
      const preparedBusy = prepareProgrammaticDispatch(project.child, secondPayload, 20_100);
      assert.deepEqual(preparedBusy, {
        status: "busy",
        reason: "conversation-active",
        requestKey: preparedBusy.requestKey,
        activeRequestKey: first.requestKey,
        activeStatus: "prepared",
      });
      assert.equal(
        readProgrammaticDispatch(project.child, preparedBusy.requestKey, 20_100),
        null,
      );

      claimDispatchTicket(project.child, first.ticket.token, 20_200, firstPayload.prompt);
      const claimedBusy = prepareProgrammaticDispatch(project.child, secondPayload, 20_300);
      assert.equal(claimedBusy.status, "busy");
      assert.equal(claimedBusy.reason, "conversation-active");
      assert.equal(claimedBusy.activeRequestKey, first.requestKey);
      assert.equal(claimedBusy.activeStatus, "claimed");

      const reverseDirection = prepareProgrammaticDispatch(project.child, {
        host: "claude",
        target: "codex",
        sessionId: "2".repeat(32),
        requestId: "conversation-reverse",
        conversationId: "shared-conversation",
        config: {
          model: "gpt-5.6-sol",
          effort: "low",
          access: "workspace-write",
          approval: "on-request",
        },
        prompt: "反向类型互不阻塞",
      }, 20_400);
      assert.equal(reverseDirection.status, "ready");

      finishProgrammaticDispatch(project.child, first.requestKey, {
        status: "completed",
        jobId: "first-complete",
      }, 20_500);
      const second = prepareProgrammaticDispatch(project.child, secondPayload, 20_600);
      assert.equal(second.status, "ready");
    } finally {
      cleanupDir(project.root);
    }
  });
});

test("programmatic registry cleanup is bounded while preserving every active request", () => {
  withIsolatedEnv({ CLAUDE_PLUGIN_DATA: undefined }, () => {
    const project = managedProject();
    process.env.CC_SUITE_SCOPE_ROOT = project.root;
    process.env.CC_SUITE_WORKSPACE_ROOT = project.root;
    const now = 1_000_000_000;
    const activePayload = {
      host: "codex",
      target: "claude",
      sessionId: "3".repeat(32),
      requestId: "protected-prepared",
      conversationId: "protected-prepared-conversation",
      config: { model: "opus", effort: "low", access: "dontAsk" },
      prompt: "尚未领取",
    };
    try {
      const prepared = prepareProgrammaticDispatch(project.child, activePayload, now - 1_000);
      const claimed = prepareProgrammaticDispatch(project.child, {
        ...activePayload,
        requestId: "protected-claimed",
        conversationId: "protected-claimed-conversation",
        prompt: "已领取但仍在上限内",
      }, now - 900);
      claimDispatchTicket(
        project.child,
        claimed.ticket.token,
        now - 800,
        "已领取但仍在上限内",
      );

      updateState(project.root, (state) => {
        const requests = { ...(state.config.programmaticDispatches ?? {}) };
        for (let index = 0; index < MAX_PROGRAMMATIC_TERMINAL_REQUESTS + 5; index += 1) {
          const requestKey = (index + 1).toString(16).padStart(64, "0");
          requests[requestKey] = {
            schema: 2,
            requestKey,
            status: "completed",
            completedAtMs: now - index,
            updatedAtMs: now - index,
          };
        }
        const expiredKey = "f".repeat(64);
        requests[expiredKey] = {
          schema: 2,
          requestKey: expiredKey,
          status: "failed",
          completedAtMs: now - PROGRAMMATIC_TERMINAL_RETENTION_MS - 1,
          updatedAtMs: now - PROGRAMMATIC_TERMINAL_RETENTION_MS - 1,
        };
        state.config.programmaticDispatches = requests;
      });

      const trigger = prepareProgrammaticDispatch(project.child, {
        ...activePayload,
        requestId: "cleanup-trigger",
        conversationId: "cleanup-trigger-conversation",
        prompt: "触发清理",
      }, now);
      assert.equal(trigger.status, "ready");

      const requests = getConfig(project.root).programmaticDispatches;
      assert.equal(requests[prepared.requestKey].status, "prepared");
      assert.equal(requests[claimed.requestKey].status, "claimed");
      assert.equal(requests[trigger.requestKey].status, "prepared");
      assert.equal(Object.hasOwn(requests, "f".repeat(64)), false);
      assert.equal(
        Object.values(requests).filter((request) => (
          ["completed", "failed", "stalled"].includes(request.status)
        )).length,
        MAX_PROGRAMMATIC_TERMINAL_REQUESTS,
      );
    } finally {
      cleanupDir(project.root);
    }
  });
});

test("programmatic registry refuses new work at active capacity without deleting active requests", () => {
  withIsolatedEnv({ CLAUDE_PLUGIN_DATA: undefined }, () => {
    const project = managedProject();
    process.env.CC_SUITE_SCOPE_ROOT = project.root;
    process.env.CC_SUITE_WORKSPACE_ROOT = project.root;
    const now = 2_000_000_000;
    try {
      configureProjectStateRoot(project.root);
      updateState(project.root, (state) => {
        const requests = {};
        for (let index = 0; index < MAX_PROGRAMMATIC_ACTIVE_REQUESTS; index += 1) {
          const requestKey = (index + 1).toString(16).padStart(64, "0");
          requests[requestKey] = {
            schema: 2,
            requestKey,
            status: index % 2 === 0 ? "prepared" : "claimed",
            host: "codex",
            target: "claude",
            conversationKey: (index + 1).toString(16).padStart(64, "0"),
            createdAtMs: now - 1_000,
            updatedAtMs: now - 1_000,
            ...(index % 2 === 0 ? {} : { claimedAtMs: now - 1_000 }),
          };
        }
        state.config.programmaticDispatches = requests;
      });

      const result = prepareProgrammaticDispatch(project.child, {
        host: "codex",
        target: "claude",
        sessionId: "4".repeat(32),
        requestId: "over-capacity",
        conversationId: "new-conversation",
        config: { model: "opus", effort: "low", access: "dontAsk" },
        prompt: "不得挤掉活动请求",
      }, now);
      assert.equal(result.status, "busy");
      assert.equal(result.reason, "registry-capacity");
      assert.equal(result.activeCount, MAX_PROGRAMMATIC_ACTIVE_REQUESTS);
      assert.equal(
        Object.values(getConfig(project.root).programmaticDispatches)
          .filter((request) => ["prepared", "claimed"].includes(request.status)).length,
        MAX_PROGRAMMATIC_ACTIVE_REQUESTS,
      );
    } finally {
      cleanupDir(project.root);
    }
  });
});

test("the same host session and target configuration resume their delegated conversation", () => {
  withIsolatedEnv({ CLAUDE_PLUGIN_DATA: undefined }, () => {
    const project = managedProject();
    process.env.CC_SUITE_SCOPE_ROOT = project.root;
    process.env.CC_SUITE_WORKSPACE_ROOT = project.root;
    const claudeConfig = { model: "claude-opus-4-6", effort: "low", access: "default" };
    try {
      recordDispatchConversation(project.child, {
        host: "codex",
        target: "claude",
        hostSessionId: "native-codex-session",
        threadId: "12345678-1234-4234-8234-123456789abc",
        config: claudeConfig,
        prompt: "先记住暗号",
        rawOutput: "已经记住",
      }, 900);
      savePendingDispatch(project.child, {
        host: "codex",
        target: "claude",
        sessionId: "composer-session",
        config: claudeConfig,
      }, 1_000);
      const continued = ticketForSubmittedPrompt(project.child, {
        host: "codex",
        sessionId: "composer-session",
        hostSessionId: "native-codex-session",
        prompt: "继续上面的讨论",
      }, 1_100);
      assert.equal(continued.ticket.resumeThreadId, "12345678-1234-4234-8234-123456789abc");
      assert.deepEqual(continued.ticket.conversationTurns, [{
        prompt: "先记住暗号",
        output: "已经记住",
      }]);

      savePendingDispatch(project.child, {
        host: "codex",
        target: "claude",
        sessionId: "composer-session",
        config: { ...claudeConfig, effort: "high" },
      }, 1_200);
      const changedConfig = ticketForSubmittedPrompt(project.child, {
        host: "codex",
        sessionId: "composer-session",
        hostSessionId: "native-codex-session",
        prompt: "改用另一配置",
      }, 1_300);
      assert.equal(changedConfig.ticket.resumeThreadId, null);
      assert.deepEqual(changedConfig.ticket.conversationTurns, []);
    } finally {
      cleanupDir(project.root);
    }
  });
});

test("expired pending selection is consumed and reported instead of silently routing", () => {
  withIsolatedEnv({ CLAUDE_PLUGIN_DATA: undefined }, () => {
    const project = managedProject();
    process.env.CC_SUITE_SCOPE_ROOT = project.root;
    process.env.CC_SUITE_WORKSPACE_ROOT = project.root;
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
    process.env.CC_SUITE_SCOPE_ROOT = project.root;
    process.env.CC_SUITE_WORKSPACE_ROOT = project.root;
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

test("different workspaces share one scope runtime without project-local state", () => {
  withIsolatedEnv({ CLAUDE_PLUGIN_DATA: undefined }, () => {
    const scope = makeTempDir("cc-suite-central-state-");
    const first = path.join(scope, "first-project");
    const second = path.join(scope, "second-project");
    fs.mkdirSync(first);
    fs.mkdirSync(second);
    try {
      process.env.CC_SUITE_SCOPE_ROOT = scope;
      process.env.CC_SUITE_WORKSPACE_ROOT = first;
      recordRecentDispatch(first, "codex", config, "2026-08-16T08:00:00.000Z");
      process.env.CC_SUITE_WORKSPACE_ROOT = second;
      recordRecentDispatch(second, "codex", { ...config, effort: "low" }, "2026-08-16T09:00:00.000Z");

      assert.equal(fs.existsSync(path.join(scope, ".cc-suite", "runtime", "state")), true);
      assert.equal(fs.existsSync(path.join(first, ".cc-suite")), false);
      assert.equal(fs.existsSync(path.join(second, ".cc-suite")), false);
      assert.equal(recentDispatchRecord(second, "codex")?.config.effort, "low");
      process.env.CC_SUITE_WORKSPACE_ROOT = first;
      assert.equal(recentDispatchRecord(first, "codex")?.config.effort, "high");
    } finally {
      cleanupDir(scope);
    }
  });
});

test("the Claude relay guard preserves the entire response and requires one attribution", () => {
  withIsolatedEnv({ CLAUDE_PLUGIN_DATA: undefined }, () => {
    const project = managedProject();
    process.env.CC_SUITE_SCOPE_ROOT = project.root;
    process.env.CC_SUITE_WORKSPACE_ROOT = project.root;
    const exact = "  Claude 原文第一行\n第二行\n\n";
    try {
      recordExactClaudeResponse(project.child, {
        host: "codex",
        target: "claude",
        hostSessionId: "native-codex-session",
        hostTurnId: "turn-1",
        jobId: "claude-dispatch-job-1",
        rawOutput: exact,
      }, 1_000);

      const wrapped = verifyExactClaudeResponse(project.root, {
        sessionId: "native-codex-session",
        lastAssistantMessage: `Claude 回答：\n${exact}`,
      }, 1_100);
      assert.equal(wrapped.status, "mismatch");
      const required = `${exact}回答来自Claude。`;
      assert.equal(wrapped.expected, required);
      assert.equal(wrapped.mismatchCount, 1);

      const trimmed = verifyExactClaudeResponse(project.root, {
        sessionId: "native-codex-session",
        lastAssistantMessage: exact.trim(),
      }, 1_200);
      assert.equal(trimmed.status, "mismatch");
      assert.equal(trimmed.mismatchCount, 2);

      const matched = verifyExactClaudeResponse(project.root, {
        sessionId: "native-codex-session",
        lastAssistantMessage: required,
      }, 1_300);
      assert.deepEqual(matched, { status: "matched", jobId: "claude-dispatch-job-1" });
      assert.deepEqual(verifyExactClaudeResponse(project.root, {
        sessionId: "native-codex-session",
        lastAssistantMessage: required,
      }, 1_400), { status: "none" });
    } finally {
      cleanupDir(project.root);
    }
  });
});
