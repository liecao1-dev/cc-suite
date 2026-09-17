import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { runProgrammaticRequest } from "../scripts/dispatch-request.mjs";
import {
  claimDispatchTicket,
  finishProgrammaticDispatch,
} from "../scripts/lib/dispatch-state.mjs";
import { resolveJobFile, writeJobFile } from "../scripts/lib/state.mjs";
import { cleanupDir, isolateEnv, makeTempDir } from "./helpers.mjs";

function environment(target, defaultOverride = {}) {
  const codex = target === "codex";
  const defaultConfig = codex
    ? {
      model: "gpt-5.6-sol",
      effort: "high",
      access: "workspace-write",
      approval: "on-request",
      ...defaultOverride,
    }
    : {
      model: "opus",
      effort: "low",
      access: "dontAsk",
      ...defaultOverride,
    };
  return {
    defaultConfig,
    catalog: codex
      ? {
        models: ["gpt-5.6-sol"],
        modelsDetail: [{ slug: "gpt-5.6-sol", reasoning_efforts: ["low", "high"] }],
        efforts: ["low", "high"],
        access: ["read-only", "workspace-write", "danger-full-access"],
        approvals: ["on-request", "never"],
      }
      : {
        models: ["opus"],
        modelsDetail: [{ slug: "opus", reasoning_efforts: ["low", "high"] }],
        efforts: ["low", "high"],
        access: ["default", "dontAsk", "plan"],
      },
  };
}

function requestEnv(scope, host = "codex") {
  return {
    CC_SUITE_SCOPE_ROOT: scope,
    CC_SUITE_WORKSPACE_ROOT: scope,
    CC_SUITE_COMPOSER_HOST: host,
    CC_SUITE_COMPOSER_SESSION: "a".repeat(32),
    CC_SUITE_DISPATCH_BROKER_SOCKET: path.join(scope, "broker.sock"),
    CC_SUITE_DISPATCH_BROKER_SECRET: "b".repeat(64),
    CC_SUITE_PROGRAMMATIC_BROKER_GRANT: "c".repeat(64),
  };
}

function brokerDoubles(scope) {
  return {
    brokerConfigFor: () => ({
      socketPath: path.join(scope, "broker.sock"),
      scopeRoot: scope,
      sessionId: "a".repeat(32),
      secret: "b".repeat(64),
      programmaticGrant: "c".repeat(64),
    }),
    authorizeBrokerLaunch: async () => {},
  };
}

function claudeArgs(requestId = "request-1") {
  return [
    "--request-id", requestId,
    "--conversation-id", "conversation-1",
    "--model", "opus",
    "--effort", "low",
    "--access", "dontAsk",
    "--prompt-stdin",
  ];
}

test("programmatic request executes once and replays the persisted result for the same id", async () => {
  const scope = makeTempDir("cc-suite-request-");
  const child = path.join(scope, "packages", "app");
  fs.mkdirSync(child, { recursive: true });
  const env = requestEnv(scope);
  const restoreEnv = isolateEnv(env);
  try {
    let executions = 0;
    let artifactFile = null;
    const relay = async ({ ticket, cwd, task }) => {
      executions += 1;
      const claimed = claimDispatchTicket(cwd, ticket, Date.now(), task);
      assert.equal(task, "同一任务只执行一次");
      assert.equal(claimed.hostSessionId, "programmatic:conversation-1");
      const jobId = "claude-dispatch-programmatic-1";
      artifactFile = writeJobFile(claimed.projectRoot, jobId, {
        rawOutput: "原样结果",
        threadId: "12345678-1234-4234-8234-123456789abc",
      });
      const output = {
        jobId,
        status: "completed",
        threadId: "12345678-1234-4234-8234-123456789abc",
        rawOutput: "原样结果",
        target: "claude",
        config: claimed.config,
        selectedProfile: "programmatic",
        contextResumed: false,
        contextMode: "new",
        contextSaved: true,
        exactRelayArmed: false,
      };
      finishProgrammaticDispatch(cwd, claimed.programmaticRequestKey, output);
      return { exitCode: 0, stdout: `${JSON.stringify(output)}\n`, stderr: "" };
    };

    const first = await runProgrammaticRequest({
      argv: claudeArgs(),
      env: process.env,
      cwd: child,
      stdin: "同一任务只执行一次",
      relay,
      environmentForTarget: environment,
      ...brokerDoubles(scope),
    });
    assert.equal(first.output.status, "completed");
    assert.equal(first.output.rawOutput, "原样结果");
    assert.equal(first.output.idempotentReplay, false);
    assert.equal(first.output.atMostOnce, true);

    const replayed = await runProgrammaticRequest({
      argv: claudeArgs(),
      env: process.env,
      cwd: child,
      stdin: "同一任务只执行一次",
      relay,
      environmentForTarget: environment,
      ...brokerDoubles(scope),
    });
    assert.equal(executions, 1);
    assert.equal(replayed.output.status, "completed");
    assert.equal(replayed.output.rawOutput, "原样结果");
    assert.equal(replayed.output.idempotentReplay, true);

    fs.unlinkSync(artifactFile ?? resolveJobFile(scope, "claude-dispatch-programmatic-1"));
    const missingResult = await runProgrammaticRequest({
      argv: claudeArgs(),
      env: process.env,
      cwd: child,
      stdin: "同一任务只执行一次",
      relay,
      environmentForTarget: environment,
      ...brokerDoubles(scope),
    });
    assert.equal(executions, 1);
    assert.equal(missingResult.output.status, "failed");
    assert.equal(missingResult.output.originalStatus, "completed");
    assert.equal(missingResult.output.rawOutputUnavailable, true);
    assert.match(missingResult.output.error, /will not be run again/);
    assert.equal(missingResult.exitCode, 1);

    await assert.rejects(() => runProgrammaticRequest({
      argv: claudeArgs(),
      env: process.env,
      cwd: child,
      stdin: "同一 id 的另一项任务",
      relay,
      environmentForTarget: environment,
      ...brokerDoubles(scope),
    }), /conflicts with different request content/);
    assert.equal(executions, 1);
  } finally {
    restoreEnv();
    cleanupDir(scope);
  }
});

test("programmatic request fails before state creation without an active broker", async () => {
  const scope = makeTempDir("cc-suite-request-no-broker-");
  const env = {
    CC_SUITE_SCOPE_ROOT: scope,
    CC_SUITE_WORKSPACE_ROOT: scope,
    CC_SUITE_COMPOSER_HOST: "codex",
    CC_SUITE_COMPOSER_SESSION: "c".repeat(32),
  };
  const restoreEnv = isolateEnv(env);
  try {
    await assert.rejects(() => runProgrammaticRequest({
      argv: claudeArgs("no-broker"),
      env: process.env,
      cwd: scope,
      stdin: "不得写状态",
      environmentForTarget: environment,
    }), /requires the active composer broker/);
    assert.equal(fs.existsSync(path.join(scope, ".cc-suite")), false);
  } finally {
    restoreEnv();
    cleanupDir(scope);
  }
});

test("programmatic request cannot run unless the broker supplied its private launch grant", async () => {
  const scope = makeTempDir("cc-suite-request-no-grant-");
  const env = requestEnv(scope);
  delete env.CC_SUITE_PROGRAMMATIC_BROKER_GRANT;
  const restoreEnv = isolateEnv(env);
  try {
    await assert.rejects(() => runProgrammaticRequest({
      argv: claudeArgs("no-launch-grant"),
      env: process.env,
      cwd: scope,
      stdin: "不得直接运行",
      environmentForTarget: environment,
      brokerConfigFor: () => ({
        socketPath: path.join(scope, "broker.sock"),
        scopeRoot: scope,
        sessionId: "a".repeat(32),
        secret: "b".repeat(64),
      }),
      authorizeBrokerLaunch: async () => assert.fail("authorization must not run"),
    }), /must be launched by the active composer broker/);
    assert.equal(fs.existsSync(path.join(scope, ".cc-suite")), false);
  } finally {
    restoreEnv();
    cleanupDir(scope);
  }
});

test("stale broker environment is rejected before request state is written", async () => {
  const scope = makeTempDir("cc-suite-request-stale-broker-");
  const env = requestEnv(scope);
  const restoreEnv = isolateEnv(env);
  try {
    await assert.rejects(() => runProgrammaticRequest({
      argv: claudeArgs("stale-broker"),
      env: process.env,
      cwd: scope,
      stdin: "不得写状态",
      environmentForTarget: environment,
    }), /does not match|socket is unavailable/);
    assert.equal(fs.existsSync(path.join(scope, ".cc-suite")), false);
  } finally {
    restoreEnv();
    cleanupDir(scope);
  }
});

test("programmatic Codex danger-full-access cannot be authorized by request arguments", async () => {
  const scope = makeTempDir("cc-suite-request-danger-");
  const env = requestEnv(scope, "claude");
  const args = [
    "--request-id", "danger-request",
    "--model", "gpt-5.6-sol",
    "--effort", "high",
    "--access", "danger-full-access",
    "--approval", "never",
    "--prompt-stdin",
  ];
  const restoreEnv = isolateEnv(env);
  try {
    await assert.rejects(() => runProgrammaticRequest({
      argv: args,
      env: process.env,
      cwd: scope,
      stdin: "不得仅凭参数升级权限",
      relay: async () => assert.fail("relay must not run"),
      environmentForTarget: environment,
      ...brokerDoubles(scope),
    }), /danger-full-access is not authorized/);

    await assert.rejects(() => runProgrammaticRequest({
      argv: args,
      env: process.env,
      cwd: scope,
      stdin: "审批策略也不得扩大",
      relay: async () => assert.fail("relay must not run"),
      environmentForTarget: (target) => environment(target, {
        access: "danger-full-access",
        approval: "on-request",
      }),
      ...brokerDoubles(scope),
    }), /danger-full-access is not authorized/);
    assert.equal(fs.existsSync(path.join(scope, ".cc-suite")), false);
  } finally {
    restoreEnv();
    cleanupDir(scope);
  }
});

test("programmatic request stays within the active configured workspace", async () => {
  const scope = makeTempDir("cc-suite-request-scope-");
  const workspace = path.join(scope, "workspace");
  const sibling = path.join(scope, "sibling");
  fs.mkdirSync(workspace);
  fs.mkdirSync(sibling);
  const env = { ...requestEnv(scope), CC_SUITE_WORKSPACE_ROOT: workspace };
  const restoreEnv = isolateEnv(env);
  try {
    await assert.rejects(() => runProgrammaticRequest({
      argv: claudeArgs("outside-workspace"),
      env: process.env,
      cwd: sibling,
      stdin: "不得越过活动工作区",
      relay: async () => assert.fail("relay must not run"),
      environmentForTarget: environment,
      ...brokerDoubles(scope),
    }), /outside workspace/);
    assert.equal(fs.existsSync(path.join(scope, ".cc-suite")), false);
  } finally {
    restoreEnv();
    cleanupDir(scope);
  }
});

test("host-relay delivery is bound to the broker-fixed composer session", async () => {
  const scope = makeTempDir("cc-suite-request-host-relay-");
  const env = requestEnv(scope);
  const restoreEnv = isolateEnv(env);
  try {
    await assert.rejects(() => runProgrammaticRequest({
      argv: [
        "--request-id", "forged-host-relay",
        "--conversation-id", "not-the-real-session",
        "--model", "opus",
        "--effort", "low",
        "--access", "dontAsk",
        "--delivery", "host-relay",
        "--prompt-stdin",
      ],
      env: process.env,
      cwd: scope,
      stdin: "不得伪造宿主会话",
      relay: async () => assert.fail("relay must not run"),
      environmentForTarget: environment,
      ...brokerDoubles(scope),
    }), /fixed active composer session id/);
    assert.equal(fs.existsSync(path.join(scope, ".cc-suite")), false);
  } finally {
    restoreEnv();
    cleanupDir(scope);
  }
});

test("a disconnect after claim reports in-progress and the same id never relays twice", async () => {
  const scope = makeTempDir("cc-suite-request-claimed-disconnect-");
  const env = requestEnv(scope);
  const restoreEnv = isolateEnv(env);
  try {
    let executions = 0;
    const relay = async ({ ticket, cwd, task }) => {
      executions += 1;
      claimDispatchTicket(cwd, ticket, Date.now(), task);
      throw new Error("connection reset after claim");
    };
    const options = {
      argv: claudeArgs("claimed-disconnect"),
      env: process.env,
      cwd: scope,
      stdin: "只能认领一次",
      relay,
      environmentForTarget: environment,
      ...brokerDoubles(scope),
    };
    const first = await runProgrammaticRequest(options);
    assert.equal(first.output.status, "in_progress");
    assert.equal(first.output.atMostOnce, true);
    const retried = await runProgrammaticRequest(options);
    assert.equal(retried.output.status, "in_progress");
    assert.equal(retried.output.idempotentReplay, true);
    assert.equal(executions, 1);
  } finally {
    restoreEnv();
    cleanupDir(scope);
  }
});

test("a second id for an active conversation returns an explicit busy response", async () => {
  const scope = makeTempDir("cc-suite-request-conversation-busy-");
  const env = requestEnv(scope);
  const restoreEnv = isolateEnv(env);
  let releaseFirst;
  try {
    let announceRelay;
    const relayStarted = new Promise((resolve) => { announceRelay = resolve; });
    const relay = ({ ticket, cwd, task }) => new Promise((resolve) => {
      announceRelay();
      releaseFirst = () => {
        const claimed = claimDispatchTicket(cwd, ticket, Date.now(), task);
        const jobId = "claude-dispatch-busy-first";
        writeJobFile(claimed.projectRoot, jobId, { rawOutput: "第一项完成" });
        const output = {
          jobId,
          status: "completed",
          rawOutput: "第一项完成",
          target: "claude",
          config: claimed.config,
          selectedProfile: "programmatic",
        };
        finishProgrammaticDispatch(cwd, claimed.programmaticRequestKey, output);
        resolve({ exitCode: 0, stdout: `${JSON.stringify(output)}\n`, stderr: "" });
      };
    });
    const first = runProgrammaticRequest({
      argv: claudeArgs("busy-first"),
      env: process.env,
      cwd: scope,
      stdin: "第一项",
      relay,
      environmentForTarget: environment,
      ...brokerDoubles(scope),
    });
    await relayStarted;
    const second = await runProgrammaticRequest({
      argv: claudeArgs("busy-second"),
      env: process.env,
      cwd: scope,
      stdin: "第二项",
      relay: async () => assert.fail("busy request must not relay"),
      environmentForTarget: environment,
      ...brokerDoubles(scope),
    });
    assert.equal(second.exitCode, 1);
    assert.equal(second.output.status, "busy");
    assert.equal(second.output.reason, "conversation-active");
    assert.equal(second.output.activeStatus, "prepared");
    const release = releaseFirst;
    releaseFirst = null;
    release();
    assert.equal((await first).output.status, "completed");
  } finally {
    releaseFirst?.();
    restoreEnv();
    cleanupDir(scope);
  }
});
