import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import { cleanupDir, makeTempDir, writeExecutable } from "./helpers.mjs";
import { CLAUDE_DOCUMENT_TOOLS } from "../scripts/lib/claude-document-tools.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = path.join(PLUGIN_ROOT, "scripts", "claude-runner.mjs");
const FAKE_SESSION_ID = "12345678-1234-4234-8234-123456789abc";

function writeFakeClaude(bin) {
  writeExecutable(path.join(bin, "claude"), `#!/usr/bin/env node
const fs = require("node:fs");
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  let attempt = 1;
  if (process.env.FAKE_CLAUDE_ATTEMPT_FILE) {
    try { attempt = Number(fs.readFileSync(process.env.FAKE_CLAUDE_ATTEMPT_FILE, "utf8")) + 1; } catch {}
    fs.writeFileSync(process.env.FAKE_CLAUDE_ATTEMPT_FILE, String(attempt));
  }
  const capture = {
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    prompt,
    claudeOauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null,
    anthropicAuthToken: process.env.ANTHROPIC_AUTH_TOKEN ?? null,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? null,
    path: process.env.PATH,
    tmpdir: process.env.TMPDIR,
    calibreConfig: process.env.CALIBRE_CONFIG_DIRECTORY,
  };
  fs.writeFileSync(process.env.CAPTURE_CALL, JSON.stringify(capture));
  process.stdout.write(JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "${FAKE_SESSION_ID}",
  }) + "\\n");
  if (
    process.env.FAKE_CLAUDE_ERROR === "1"
    && (process.env.FAKE_CLAUDE_FAIL_ONCE !== "1" || attempt === 1)
  ) {
    process.stdout.write(JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      session_id: "${FAKE_SESSION_ID}",
      api_error_status: 401,
      total_cost_usd: 0,
      usage: {
        input_tokens: Number(process.env.FAKE_CLAUDE_INPUT_TOKENS ?? 0),
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      modelUsage: process.env.FAKE_CLAUDE_MODEL_USED === "1" ? {fake: {inputTokens: 1}} : {},
      result: "Failed to authenticate. API Error: 401 OAuth access token has expired.",
    }) + "\\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write(JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: "${FAKE_SESSION_ID}",
    result: process.env.FAKE_CLAUDE_RESULT ?? "Claude answer",
  }) + "\\n");
});
`);
}

function writeActivation(scope, claudeBinary) {
  fs.mkdirSync(path.join(scope, ".cc-suite"), { recursive: true });
  fs.writeFileSync(path.join(scope, ".cc-suite", "composer-activation.json"), JSON.stringify({
    schema: 1,
    managedBy: "cc-suite",
    scopeRoot: fs.realpathSync.native(scope),
    binaries: { claude: claudeBinary },
  }));
}

test("localchat uses scope activation while limiting the native Claude tools to the exact workspace", () => {
  const scope = makeTempDir("claude-localchat-");
  let policyFd;
  try {
    const workspace=path.join(scope,"project/sub"),bin=path.join(scope,"bin"),home=path.join(scope,"home");
    for(const directory of [workspace,bin,home])fs.mkdirSync(directory,{recursive:true});
    writeFakeClaude(bin);writeActivation(scope,path.join(bin,"claude"));
    const canonical=fs.realpathSync(workspace),policyFile=path.join(scope,"policy.json"),callFile=path.join(scope,"call.json");
    fs.writeFileSync(policyFile,JSON.stringify({schema:1,target:'claude',mode:'read-only',workspace:canonical}));
    policyFd=fs.openSync(policyFile,'r');
    const result=spawnSync(process.execPath,[RUNNER,'--model','opus','--effort','high','--permission-mode','plan','--timeout-ms','5000','--prompt-stdin'],{
      cwd:workspace,input:'只读任务',encoding:'utf8',stdio:['pipe','pipe','pipe',policyFd],
      env:{...process.env,HOME:home,PATH:`${bin}:${process.env.PATH??''}`,CAPTURE_CALL:callFile,CC_SUITE_SCOPE_ROOT:scope,CC_SUITE_WORKSPACE_ROOT:canonical,CC_SUITE_LOCALCHAT_POLICY_FD:'3'},
    });
    assert.equal(result.status,0,result.stderr);
    assert.equal(JSON.parse(result.stdout).cliStarted,true);
    const call=JSON.parse(fs.readFileSync(callFile,'utf8')),value=flag=>call.argv[call.argv.indexOf(flag)+1];
    assert.equal(value('--add-dir'),canonical);
    assert.equal(value('--tools'),'Read');
    assert.equal(value('--permission-mode'),'plan');
    assert.equal(value('--effort'),'high');
    assert.ok(call.argv.includes('--strict-mcp-config'));
    assert.deepEqual(JSON.parse(value('--mcp-config')),{mcpServers:{}});
    const settings=JSON.parse(value('--settings'));
    assert.deepEqual(settings.sandbox.filesystem.allowRead,[canonical]);
    assert.deepEqual(settings.sandbox.filesystem.allowWrite,[]);
    assert.match(call.prompt,/^This request already reached you by delegation from Chat through localchat\./);
    assert.ok(call.prompt.endsWith('只读任务'));
  }finally{if(policyFd!==undefined)fs.closeSync(policyFd);cleanupDir(scope);}
});

test("Claude runner uses the current CLI stream, returns a session id, and keeps the user's active subdirectory", () => {
  const scope = makeTempDir("claude-runner-");
  try {
    const home = path.join(scope, "home");
    const project = path.join(scope, "active-workspace");
    const nested = path.join(project, "packages", "中文 app");
    const bin = path.join(project, "bin");
    fs.mkdirSync(nested, { recursive: true });
    fs.mkdirSync(home);
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({
      mcpServers: {
        klode: {
          type: "stdio",
          command: "/fake/klode-mcp",
          args: ["--config", "/fake/library.toml"],
          env: {},
        },
        unrelated: {
          type: "stdio",
          command: "/fake/unrelated-mcp",
          args: [],
        },
      },
    }));
    const callFile = path.join(project, "call.json");
    writeFakeClaude(bin);
    writeActivation(scope, path.join(bin, "claude"));
    const task = `literal $(touch never) \`whoami\`\n${"x".repeat(3 * 1024 * 1024)}\nsecond line\n`;
    const result = spawnSync(process.execPath, [
      RUNNER, "--model", "default", "--effort", "medium",
      "--permission-mode", "default", "--timeout-ms", "5000", "--prompt-stdin",
    ], {
      cwd: nested,
      input: task,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        CAPTURE_CALL: callFile,
        FAKE_CLAUDE_RESULT: "  Claude answer\n\n",
        CLAUDE_CODE_OAUTH_TOKEN: "stale-oauth",
        ANTHROPIC_AUTH_TOKEN: "stale-auth",
        ANTHROPIC_API_KEY: "stale-key",
        CC_SUITE_SCOPE_ROOT: scope,
        CC_SUITE_WORKSPACE_ROOT: project,
        CLAUDE_PLUGIN_DATA: path.join(project, ".cc-suite", "runtime"),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "completed");
    assert.equal(output.rawOutput, "  Claude answer\n\n");
    assert.equal(output.threadId, FAKE_SESSION_ID);
    const stateKeys = fs.readdirSync(path.join(scope, ".cc-suite", "runtime", "state"));
    assert.equal(stateKeys.length, 1);
    assert.match(stateKeys[0], /^active-workspace-/);
    const call = JSON.parse(fs.readFileSync(callFile, "utf8"));
    assert.equal(fs.realpathSync(call.cwd), fs.realpathSync(nested));
    assert.equal(call.argv[0], "-p");
    assert.equal(call.argv[call.argv.indexOf("--output-format") + 1], "stream-json");
    assert.ok(call.argv.includes("--verbose"));
    assert.ok(call.argv.includes("--no-session-persistence"));
    assert.equal(call.argv[call.argv.indexOf("--add-dir") + 1], fs.realpathSync(scope));
    assert.equal(call.argv[call.argv.indexOf("--setting-sources") + 1], "");
    assert.equal(call.argv[call.argv.indexOf("--permission-mode") + 1], "dontAsk");
    assert.equal(call.argv[call.argv.indexOf("--effort") + 1], "medium");
    assert.equal(call.claudeOauthToken, null);
    assert.equal(call.anthropicAuthToken, null);
    assert.equal(call.anthropicApiKey, null);
    assert.equal(call.argv.includes("--tools"), false);
    assert.deepEqual(JSON.parse(call.argv[call.argv.indexOf("--mcp-config") + 1]), {
      mcpServers: {
      klode: {
        type: "stdio",
        command: "/fake/klode-mcp",
        args: ["--config", "/fake/library.toml"],
        env: {},
      },
      },
    });
    const settings = JSON.parse(call.argv[call.argv.indexOf("--settings") + 1]);
    assert.ok(settings.permissions.allow.includes("WebSearch"));
    assert.ok(settings.permissions.allow.includes("WebFetch"));
    assert.ok(settings.permissions.allow.includes("mcp__klode__list_kbs"));
    assert.ok(settings.permissions.allow.includes("mcp__klode__diagnose"));
    assert.equal(settings.permissions.allow.includes("mcp__klode__*"), false);
    const installedTools = CLAUDE_DOCUMENT_TOOLS.filter((file) => {
      try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); }
      catch { return false; }
    });
    assert.deepEqual(settings.permissions.allow.filter((rule) => rule.startsWith("Bash(")),
      installedTools.map((file) => `Bash(${file} *)`));
    for (const tool of installedTools) {
      assert.ok(call.path.split(path.delimiter).includes(path.dirname(tool)));
      assert.ok(call.prompt.includes(tool));
    }
    if (installedTools.length > 0) {
      assert.equal(call.tmpdir, path.join(fs.realpathSync(nested), ".runtime", "claude-document-tools"));
      assert.ok(fs.statSync(call.tmpdir).isDirectory());
    }
    assert.ok(settings.permissions.allow.includes(`Read(//${fs.realpathSync(scope).replace(/^\/+/, "")}/**)`));
    assert.ok(settings.permissions.allow.includes(`Edit(//${fs.realpathSync(project).replace(/^\/+/, "")}/**)`));
    assert.equal(settings.permissions.disableAutoMode, "disable");
    assert.equal(settings.permissions.disableBypassPermissionsMode, "disable");
    assert.equal(settings.sandbox.enabled, true);
    assert.equal(settings.sandbox.failIfUnavailable, true);
    assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
    assert.deepEqual(settings.sandbox.filesystem.allowWrite, [fs.realpathSync(project)]);
    assert.deepEqual(settings.sandbox.filesystem.allowRead, [fs.realpathSync(scope)]);
    assert.deepEqual(settings.sandbox.filesystem.denyRead, [fs.realpathSync(home)]);
    const prompt = call.prompt;
    assert.match(prompt, /^This request already reached you by delegation from OpenAI Codex\./);
    assert.ok(prompt.endsWith(task));
    assert.equal(fs.existsSync(path.join(nested, "never")), false);
  } finally { cleanupDir(scope); }
});

test("Claude runner disables every model tool for the none tool policy", () => {
  const scope = makeTempDir("claude-runner-no-tools-");
  try {
    const home = path.join(scope, "home");
    const project = path.join(scope, "active-workspace");
    const bin = path.join(project, "bin");
    fs.mkdirSync(home);
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(path.join(project, ".cc-suite"));
    fs.writeFileSync(path.join(project, ".cc-suite", "project.json"), JSON.stringify({
      schema: 1,
      managedBy: "cc-suite",
      scopeRoot: scope,
    }));
    fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({
      mcpServers: {
        klode: { type: "stdio", command: "/fake/klode-mcp", args: [] },
      },
    }));
    const callFile = path.join(project, "call.json");
    writeFakeClaude(bin);
    writeActivation(scope, path.join(bin, "claude"));
    const result = spawnSync(process.execPath, [
      RUNNER, "--model", "default", "--effort", "medium",
      "--permission-mode", "default", "--tool-policy", "none",
      "--timeout-ms", "5000", "--prompt-stdin",
    ], {
      cwd: project,
      input: "只分析文字，不使用工具",
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        CAPTURE_CALL: callFile,
        CC_SUITE_SCOPE_ROOT: scope,
        CC_SUITE_WORKSPACE_ROOT: project,
        CLAUDE_PLUGIN_DATA: path.join(project, ".cc-suite", "runtime"),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const call = JSON.parse(fs.readFileSync(callFile, "utf8"));
    const toolsIndex = call.argv.indexOf("--tools");
    assert.notEqual(toolsIndex, -1);
    assert.equal(call.argv[toolsIndex + 1], "");
    assert.equal(call.argv.includes("--mcp-config"), false);
    assert.equal(fs.existsSync(path.join(project, ".runtime", "claude-document-tools")), false);
    assert.equal(call.prompt.includes("document converters are pre-approved"), false);

    const settings = JSON.parse(call.argv[call.argv.indexOf("--settings") + 1]);
    assert.equal(settings.permissions.allow.includes("WebSearch"), false);
    assert.equal(settings.permissions.allow.includes("WebFetch"), false);
    assert.equal(settings.permissions.allow.some((rule) => rule.startsWith("mcp__klode__")), false);
    assert.deepEqual(settings.permissions.allow, [
      `Read(//${fs.realpathSync(scope).replace(/^\/+/, "")}/**)`,
      `Edit(//${fs.realpathSync(project).replace(/^\/+/, "")}/**)`,
    ]);
    assert.deepEqual(settings.sandbox, {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        allowWrite: [fs.realpathSync(project)],
        denyRead: [fs.realpathSync(home)],
        allowRead: [fs.realpathSync(scope)],
      },
    });
  } finally { cleanupDir(scope); }
});

test("Claude runner rejects unknown tool policies before starting Claude", () => {
  const result = spawnSync(process.execPath, [
    RUNNER, "--tool-policy", "unrestricted", "--", "prompt",
  ], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsupported Claude tool policy: unrestricted/);
});

test("plan mode keeps document conversion and workspace writes unapproved", () => {
  const project = makeTempDir("claude-runner-plan-");
  try {
    const bin = path.join(project, "bin");
    const callFile = path.join(project, "call.json");
    fs.mkdirSync(bin);
    writeFakeClaude(bin);
    writeActivation(project, path.join(bin, "claude"));
    const result = spawnSync(process.execPath, [
      RUNNER, "--permission-mode", "plan", "--timeout-ms", "5000", "--", "只分析",
    ], {
      cwd: project,
      encoding: "utf8",
      env: {
        ...process.env,
        CAPTURE_CALL: callFile,
        CC_SUITE_SCOPE_ROOT: project,
        CC_SUITE_WORKSPACE_ROOT: project,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const call = JSON.parse(fs.readFileSync(callFile, "utf8"));
    const settings = JSON.parse(call.argv[call.argv.indexOf("--settings") + 1]);
    assert.equal(call.argv[call.argv.indexOf("--permission-mode") + 1], "plan");
    assert.equal(settings.permissions.allow.some((rule) => /^(Bash|Edit)\(/.test(rule)), false);
    assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
    assert.equal(fs.existsSync(path.join(project, ".runtime", "claude-document-tools")), false);
    assert.equal(call.prompt.includes("document converters are pre-approved"), false);
  } finally { cleanupDir(project); }
});

test("Claude runner surfaces a structured OAuth failure from the current CLI", () => {
  const project = makeTempDir("claude-runner-error-");
  try {
    const bin = path.join(project, "bin");
    const callFile = path.join(project, "call.json");
    const attemptFile = path.join(project, "attempt.txt");
    fs.mkdirSync(bin);
    fs.mkdirSync(path.join(project, ".cc-suite"));
    fs.writeFileSync(path.join(project, ".cc-suite", "project.json"), JSON.stringify({ schema: 1, managedBy: "cc-suite", scopeRoot: project }));
    writeFakeClaude(bin);
    writeActivation(project, path.join(bin, "claude"));
    const result = spawnSync(process.execPath, [
      RUNNER, "--model", "claude-opus-4-6", "--effort", "low",
      "--permission-mode", "default", "--timeout-ms", "5000", "--prompt-stdin",
    ], {
      cwd: project,
      input: "继续回答",
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        CAPTURE_CALL: callFile,
        FAKE_CLAUDE_ATTEMPT_FILE: attemptFile,
        FAKE_CLAUDE_ERROR: "1",
        CC_SUITE_SCOPE_ROOT: project,
        CC_SUITE_WORKSPACE_ROOT: project,
        CLAUDE_PLUGIN_DATA: path.join(project, ".cc-suite", "runtime"),
      },
    });
    assert.notEqual(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "failed");
    assert.equal(output.threadId, FAKE_SESSION_ID);
    assert.match(output.error, /401 OAuth access token has expired/);
    assert.equal(fs.readFileSync(attemptFile, "utf8"), "2");
    const call = JSON.parse(fs.readFileSync(callFile, "utf8"));
    assert.equal(call.argv[call.argv.indexOf("--model") + 1], "claude-opus-4-6");
    assert.equal(call.argv[call.argv.indexOf("--effort") + 1], "low");
    assert.match(call.prompt, /继续回答$/);
  } finally { cleanupDir(project); }
});

test("Claude runner safely restarts once when OAuth expires before any task work", () => {
  const project = makeTempDir("claude-runner-auth-retry-");
  try {
    const bin = path.join(project, "bin");
    const callFile = path.join(project, "call.json");
    const attemptFile = path.join(project, "attempt.txt");
    fs.mkdirSync(bin);
    fs.mkdirSync(path.join(project, ".cc-suite"));
    fs.writeFileSync(path.join(project, ".cc-suite", "project.json"), JSON.stringify({
      schema: 1,
      managedBy: "cc-suite",
      scopeRoot: project,
    }));
    writeFakeClaude(bin);
    writeActivation(project, path.join(bin, "claude"));
    const result = spawnSync(process.execPath, [
      RUNNER, "--model", "opus", "--effort", "low",
      "--permission-mode", "default", "--timeout-ms", "5000", "--prompt-stdin",
    ], {
      cwd: project,
      input: "只回复 OK",
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        CAPTURE_CALL: callFile,
        FAKE_CLAUDE_ATTEMPT_FILE: attemptFile,
        FAKE_CLAUDE_ERROR: "1",
        FAKE_CLAUDE_FAIL_ONCE: "1",
        FAKE_CLAUDE_RESULT: "OK",
        CC_SUITE_SCOPE_ROOT: project,
        CC_SUITE_WORKSPACE_ROOT: project,
        CLAUDE_PLUGIN_DATA: path.join(project, ".cc-suite", "runtime"),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "completed");
    assert.equal(output.rawOutput, "OK");
    assert.equal(output.retryableExpiredOAuth, undefined);
    assert.equal(fs.readFileSync(attemptFile, "utf8"), "2");
  } finally { cleanupDir(project); }
});

test("Claude runner never retries an OAuth failure after model work", () => {
  const project = makeTempDir("claude-runner-auth-no-retry-");
  try {
    const bin = path.join(project, "bin");
    const callFile = path.join(project, "call.json");
    const attemptFile = path.join(project, "attempt.txt");
    fs.mkdirSync(bin);
    writeFakeClaude(bin);
    writeActivation(project, path.join(bin, "claude"));
    const result = spawnSync(process.execPath, [
      RUNNER, "--model", "opus", "--effort", "low",
      "--permission-mode", "default", "--timeout-ms", "5000", "--prompt-stdin",
    ], {
      cwd: project,
      input: "不得重复执行",
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        CAPTURE_CALL: callFile,
        FAKE_CLAUDE_ATTEMPT_FILE: attemptFile,
        FAKE_CLAUDE_ERROR: "1",
        FAKE_CLAUDE_FAIL_ONCE: "1",
        FAKE_CLAUDE_INPUT_TOKENS: "1",
        FAKE_CLAUDE_MODEL_USED: "1",
        CC_SUITE_SCOPE_ROOT: project,
        CC_SUITE_WORKSPACE_ROOT: project,
        CLAUDE_PLUGIN_DATA: path.join(project, ".cc-suite", "runtime"),
      },
    });
    assert.notEqual(result.status, 0);
    assert.equal(JSON.parse(result.stdout).status, "failed");
    assert.equal(fs.readFileSync(attemptFile, "utf8"), "1");
  } finally { cleanupDir(project); }
});

test("CLI compatibility calls keep the same scoped read/write boundary", () => {
  const project = makeTempDir("claude-runner-compat-");
  try {
    const bin = path.join(project, "bin");
    const callFile = path.join(project, "call.json");
    fs.mkdirSync(bin);
    fs.mkdirSync(path.join(project, ".cc-suite"));
    fs.writeFileSync(path.join(project, ".cc-suite", "project.json"), JSON.stringify({ schema: 1, managedBy: "cc-suite", scopeRoot: project }));
    fs.writeFileSync(path.join(project, ".claude.json"), JSON.stringify({
      mcpServers: {
        klode: { type: "stdio", command: "/fake/klode-mcp", args: [] },
      },
    }));
    writeFakeClaude(bin);
    writeActivation(project, path.join(bin, "claude"));
    const result = spawnSync(process.execPath, [
      RUNNER, "--model", "default", "--effort", "medium",
      "--permission-mode", "manual", "--timeout-ms", "5000", "--prompt-stdin",
    ], {
      cwd: project,
      input: "兼容模式",
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: project,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        CAPTURE_CALL: callFile,
        CC_SUITE_SCOPE_ROOT: project,
        CC_SUITE_WORKSPACE_ROOT: project,
        CLAUDE_PLUGIN_DATA: path.join(project, ".cc-suite", "runtime"),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.threadId, FAKE_SESSION_ID);
    const argv = JSON.parse(fs.readFileSync(callFile, "utf8")).argv;
    assert.ok(argv.includes("--no-session-persistence"));
    assert.equal(argv[argv.indexOf("--add-dir") + 1], fs.realpathSync(project));
    assert.equal(argv[argv.indexOf("--setting-sources") + 1], "");
    assert.equal(argv[argv.indexOf("--permission-mode") + 1], "dontAsk");
    const settings = JSON.parse(argv[argv.indexOf("--settings") + 1]);
    assert.deepEqual(settings.sandbox.filesystem.allowWrite, [fs.realpathSync(project)]);
    assert.ok(settings.permissions.allow.includes("mcp__klode__list_kbs"));
    assert.equal(settings.permissions.allow.includes("mcp__klode__*"), false);
    assert.deepEqual(JSON.parse(argv[argv.indexOf("--mcp-config") + 1]), {
      mcpServers: {
        klode: { type: "stdio", command: "/fake/klode-mcp", args: [] },
      },
    });
  } finally { cleanupDir(project); }
});
