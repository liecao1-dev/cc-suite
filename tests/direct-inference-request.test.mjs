import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDirectInferenceRequest,
  runDirectInferenceRequest,
} from "../scripts/direct-inference-request.mjs";
import { cleanupDir, makeTempDir } from "./helpers.mjs";

function environmentFor(target, cwd) {
  assert.equal(path.isAbsolute(cwd), true);
  return {
    defaultConfig: target === "claude"
      ? { model: "sonnet", effort: "medium", access: "default" }
      : { model: "gpt-5.6-sol", effort: "medium", access: "workspace-write", approval: "on-request" },
  };
}

test("Claude workflow flags become one exact no-tools programmatic tuple", () => {
  const request = buildDirectInferenceRequest({
    argv: [
      "--target", "claude",
      "--request-id", "workflow-claude-1",
      "--",
      "-p",
      "--model", "claude-opus-5",
      "--effort", "max",
      "--no-session-persistence",
      "--tools", "",
      "--output-format", "text",
    ],
    env: { CC_SUITE_COMPOSER_HOST: "codex" },
    cwd: process.cwd(),
    stdin: "完整 Claude 请求\n",
    environmentFor,
  });
  assert.equal(request.target, "claude");
  assert.equal(request.prompt, "完整 Claude 请求\n");
  assert.deepEqual(request.config, {
    model: "claude-opus-5",
    effort: "max",
    access: "default",
  });
  assert.deepEqual(request.requestArgv, [
    "--request-id", "workflow-claude-1",
    "--conversation-id", "workflow-claude-1",
    "--model", "claude-opus-5",
    "--effort", "max",
    "--access", "default",
    "--tool-policy", "none",
    "--delivery", "workflow",
    "--prompt-stdin",
  ]);
});

test("Claude defaults are used and one positional prompt excludes stdin", () => {
  const request = buildDirectInferenceRequest({
    argv: ["--target", "claude", "--request-id", "claude-default", "--", "--print", "one prompt"],
    env: { CC_SUITE_COMPOSER_HOST: "codex" },
    cwd: process.cwd(),
    stdin: "",
    environmentFor,
  });
  assert.deepEqual(request.config, { model: "sonnet", effort: "medium", access: "default" });
  assert.equal(request.prompt, "one prompt");
  assert.equal(request.requestArgv.includes("--conversation-id"), false);
  assert.deepEqual(request.requestArgv.slice(-5), ["--tool-policy", "standard", "--delivery", "workflow", "--prompt-stdin"]);
  assert.throws(
    () => buildDirectInferenceRequest({
      argv: ["--target", "claude", "--request-id", "ambiguous", "--", "-p", "position"],
      env: { CC_SUITE_COMPOSER_HOST: "codex" },
      cwd: process.cwd(),
      stdin: "also stdin",
      environmentFor,
    }),
    /either stdin or one positional argument/,
  );
});

test("Claude rejects dangerous, unknown, nonempty-tools, and structured output options", () => {
  const base = ["--target", "claude", "--request-id", "reject-claude", "--", "-p"];
  const options = [
    ["--permission-mode", "bypassPermissions"],
    ["--dangerously-skip-permissions"],
    ["--safe-mode"],
    ["--tools", "Bash"],
    ["--output-format", "json"],
    ["--output-format", "stream-json"],
  ];
  for (const option of options) {
    assert.throws(
      () => buildDirectInferenceRequest({
        argv: [...base, ...option],
        env: { CC_SUITE_COMPOSER_HOST: "codex" },
        cwd: process.cwd(),
        stdin: "prompt",
        environmentFor,
      }),
    );
  }
});

test("restricted Codex exec maps cwd and the two allowed -c fields", () => {
  const fixture = makeTempDir("cc-suite-direct-codex-");
  try {
    const workspace = path.join(fixture, "workspace");
    fs.mkdirSync(workspace);
    const request = buildDirectInferenceRequest({
      argv: [
        "--target", "codex",
        "--request-id", "workflow-codex-1",
        "--",
        "exec",
        "--model=gpt-5.6-sol",
        "--sandbox", "read-only",
        "-C", "workspace",
        "--skip-git-repo-check",
        "--color", "never",
        "-c", 'model_reasoning_effort="max"',
        "-c", 'approval_policy="never"',
        "-",
      ],
      env: { CC_SUITE_COMPOSER_HOST: "claude" },
      cwd: fixture,
      stdin: "完整 Codex 请求\n",
      environmentFor,
    });
    assert.equal(request.cwd, fs.realpathSync(workspace));
    assert.deepEqual(request.config, {
      model: "gpt-5.6-sol",
      effort: "max",
      access: "read-only",
      approval: "never",
    });
    assert.equal(request.prompt, "完整 Codex 请求\n");
    assert.deepEqual(request.requestArgv, [
      "--request-id", "workflow-codex-1",
      "--model", "gpt-5.6-sol",
      "--effort", "max",
      "--access", "read-only",
      "--approval", "never",
      "--tool-policy", "standard",
      "--delivery", "workflow",
      "--prompt-stdin",
    ]);
  } finally {
    cleanupDir(fixture);
  }
});

test("Codex accepts one safe leading profile and normalizes the e alias", () => {
  for (const profileArgs of [
    ["--profile", "cli-zh"],
    ["--profile=cli-zh"],
  ]) {
    const request = buildDirectInferenceRequest({
      argv: [
        "--target", "codex",
        "--request-id", `profile-${profileArgs.length}`,
        "--",
        ...profileArgs,
        "e",
        "profiled prompt",
      ],
      env: { CC_SUITE_COMPOSER_HOST: "claude" },
      cwd: process.cwd(),
      stdin: "",
      environmentFor,
    });
    assert.equal(request.prompt, "profiled prompt");
    assert.deepEqual(request.config, {
      model: "gpt-5.6-sol",
      effort: "medium",
      access: "workspace-write",
      approval: "on-request",
    });
  }
});

test("Codex rejects danger, arbitrary config, structured output, and unknown options", () => {
  const cases = [
    ["exec", "--sandbox", "danger-full-access", "prompt"],
    ["exec", "--dangerously-bypass-approvals-and-sandbox", "prompt"],
    ["exec", "-c", "web_search=true", "prompt"],
    ["exec", "--json", "prompt"],
    ["exec", "--ephemeral", "prompt"],
    ["-p", "workflow-profile", "exec", "prompt"],
    ["--profile", "bad/profile", "exec", "prompt"],
    ["--profile", "one", "--profile", "two", "exec", "prompt"],
    ["--quiet", "exec", "prompt"],
  ];
  for (const targetArgv of cases) {
    assert.throws(
      () => buildDirectInferenceRequest({
        argv: ["--target", "codex", "--request-id", "reject-codex", "--", ...targetArgv],
        env: { CC_SUITE_COMPOSER_HOST: "claude" },
        cwd: process.cwd(),
        stdin: "",
        environmentFor,
      }),
    );
  }
});

test("adapter does not trust a composer-host environment and accepts no binary", () => {
  const request = buildDirectInferenceRequest({
    argv: ["--target", "claude", "--request-id", "broker-decides", "--", "-p", "prompt"],
    env: { CC_SUITE_COMPOSER_HOST: "claude" },
    cwd: process.cwd(),
    stdin: "",
    environmentFor,
  });
  assert.equal(request.target, "claude");
  assert.throws(
    () => buildDirectInferenceRequest({
      argv: ["--target", "claude", "--request-id", "no-binary", "--binary", "/tmp/fake", "--", "-p", "prompt"],
      env: { CC_SUITE_COMPOSER_HOST: "codex" },
      cwd: process.cwd(),
      stdin: "",
      environmentFor,
    }),
    /invalid direct inference control arguments/,
  );
});

test("runner sends only mapped arguments and the complete prompt through the active broker", async () => {
  let invocation;
  const exitCode = await runDirectInferenceRequest({
    argv: ["--target", "claude", "--request-id", "invoke-fixed", "--", "-p", "prompt"],
    env: { CC_SUITE_COMPOSER_HOST: "codex" },
    cwd: process.cwd(),
    stdin: "",
    environmentFor,
    brokerConfigFor: () => ({
      socketPath: "/fixed/session.sock",
      scopeRoot: "/fixed",
      sessionId: "a".repeat(32),
      secret: "b".repeat(64),
    }),
    invoke: async (value) => {
      invocation = value;
      return { exitCode: 7, stdout: "", stderr: "" };
    },
  });
  assert.equal(exitCode, 7);
  assert.equal(invocation.prompt, "prompt");
  assert.equal(invocation.target, "claude");
  assert.deepEqual(invocation.requestArgv.slice(0, 2), ["--request-id", "invoke-fixed"]);
  assert.equal(Object.hasOwn(invocation, "binary"), false);
  assert.equal(invocation.socketPath, "/fixed/session.sock");
});
