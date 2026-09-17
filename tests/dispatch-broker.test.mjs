import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { cleanupDir, writeExecutable } from "./helpers.mjs";
import {
  BROKER_TIMEOUT_MS,
  dispatchBrokerConfig,
  relayDispatchThroughBroker,
  relayProgrammaticRequestThroughBroker,
} from "../scripts/lib/dispatch-broker-client.mjs";
import { PROGRAMMATIC_CLAIM_STALL_MS } from "../scripts/lib/dispatch-state.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const BROKER = path.join(ROOT, "scripts", "dispatch-broker.mjs");

test("broker wait window outlives the 60-minute dispatch terminalization window", () => {
  assert.equal(BROKER_TIMEOUT_MS, 3_660_000);
  assert.ok(BROKER_TIMEOUT_MS > PROGRAMMATIC_CLAIM_STALL_MS);
});

async function waitFor(check, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for broker");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await exited;
}

test("broker refuses to start without a fixed host and 32-hex session identity", () => {
  const scope = fs.mkdtempSync("/private/tmp/ccb-identity-");
  try {
    const result = spawnSync(process.execPath, [
      BROKER,
      "--socket", path.join(scope, "unused.sock"),
      "--secret", "a".repeat(64),
      "--scope", scope,
      "--workspace", scope,
      "--source", scope,
      "--parent-pid", String(process.pid),
    ], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /invalid composer session id/);
  } finally {
    cleanupDir(scope);
  }
});

test("composer broker runs only the fixed executor with a clean target sandbox environment", async () => {
  const scope = fs.mkdtempSync("/private/tmp/ccb-");
  const workspace = path.join(scope, "workspace");
  const outsideWorkspace = path.join(scope, "other-workspace");
  const source = path.join(scope, "source");
  const scripts = path.join(source, "scripts");
  const capture = path.join(scope, "capture.json");
  const sessionId = "1".repeat(32);
  const socketPath = path.join(scope, ".cc-suite", "runtime", "brokers", `${sessionId}.sock`);
  const secret = "a".repeat(64);
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(outsideWorkspace);
  fs.mkdirSync(scripts, { recursive: true });
  writeExecutable(path.join(scripts, "dispatch-execute.mjs"), `#!/usr/bin/env node
import fs from "node:fs";
const task = fs.readFileSync(0, "utf8");
const capture = {
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  task,
  codexSandbox: process.env.CODEX_SANDBOX ?? null,
  brokerBypass: process.env.CC_SUITE_DISPATCH_BROKER_BYPASS ?? null,
  scope: process.env.CC_SUITE_SCOPE_ROOT ?? null,
  workspace: process.env.CC_SUITE_WORKSPACE_ROOT ?? null,
  composerHost: process.env.CC_SUITE_COMPOSER_HOST ?? null,
  composerSession: process.env.CC_SUITE_COMPOSER_SESSION ?? null,
  brokerSocket: process.env.CC_SUITE_DISPATCH_BROKER_SOCKET ?? null,
  claudeCode: process.env.CLAUDECODE ?? null,
  claudeOauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null,
  anthropicAuthToken: process.env.ANTHROPIC_AUTH_TOKEN ?? null,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? null,
};
fs.writeFileSync(process.env.CC_SUITE_TEST_CAPTURE, JSON.stringify(capture));
process.stdout.write(JSON.stringify({ status: "completed", rawOutput: "BROKER OK" }) + "\\n");
`);
  writeExecutable(path.join(scripts, "dispatch-request.mjs"), "#!/usr/bin/env node\nprocess.exit(99);\n");

  let stderr = "";
  const broker = spawn(process.execPath, [
    BROKER,
    "--socket", socketPath,
    "--secret", secret,
    "--scope", scope,
    "--workspace", workspace,
    "--source", source,
    "--parent-pid", String(process.pid),
    "--host", "codex",
    "--session-id", sessionId,
  ], {
    env: {
      ...process.env,
      CODEX_SANDBOX: "seatbelt",
      CC_SUITE_COMPOSER_HOST: "forged-host",
      CC_SUITE_COMPOSER_SESSION: "f".repeat(32),
      CC_SUITE_DISPATCH_BROKER_SOCKET: "/tmp/forged.sock",
      CC_SUITE_DISPATCH_BROKER_SECRET: "f".repeat(64),
      CLAUDECODE: "1",
      CLAUDE_CODE_OAUTH_TOKEN: "stale-oauth",
      ANTHROPIC_AUTH_TOKEN: "stale-auth",
      ANTHROPIC_API_KEY: "stale-key",
      CC_SUITE_TEST_CAPTURE: capture,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  broker.stderr.setEncoding("utf8");
  broker.stderr.on("data", (chunk) => { stderr += chunk; });

  try {
    await waitFor(() => fs.existsSync(socketPath) || broker.exitCode !== null);
    assert.equal(broker.exitCode, null, stderr);
    assert.equal(fs.statSync(path.dirname(socketPath)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);

    const response = await relayDispatchThroughBroker({
      socketPath,
      scopeRoot: fs.realpathSync(scope),
      sessionId,
      secret,
      ticket: "b".repeat(32),
      cwd: workspace,
      task: "完整任务",
      timeoutMs: 5_000,
    });
    assert.equal(response.exitCode, 0, response.stderr);
    assert.equal(JSON.parse(response.stdout).rawOutput, "BROKER OK");
    const recorded = JSON.parse(fs.readFileSync(capture, "utf8"));
    assert.deepEqual(recorded.argv, [
      "--ticket", "b".repeat(32), "--prompt-stdin",
    ]);
    assert.equal(recorded.cwd, fs.realpathSync(workspace));
    assert.equal(recorded.task, "完整任务");
    assert.equal(recorded.codexSandbox, null);
    assert.equal(recorded.brokerBypass, "1");
    assert.equal(recorded.scope, fs.realpathSync(scope));
    assert.equal(recorded.workspace, fs.realpathSync(workspace));
    assert.equal(recorded.composerHost, null);
    assert.equal(recorded.composerSession, null);
    assert.equal(recorded.brokerSocket, null);
    assert.equal(recorded.claudeCode, null);
    assert.equal(recorded.claudeOauthToken, null);
    assert.equal(recorded.anthropicAuthToken, null);
    assert.equal(recorded.anthropicApiKey, null);

    const rejected = await relayDispatchThroughBroker({
      socketPath,
      scopeRoot: fs.realpathSync(scope),
      sessionId,
      secret,
      ticket: "c".repeat(32),
      cwd: outsideWorkspace,
      task: "不得执行",
      timeoutMs: 5_000,
    });
    assert.equal(rejected.exitCode, 1);
    assert.match(rejected.stderr, /outside the active workspace/);
    assert.equal(JSON.parse(fs.readFileSync(capture, "utf8")).task, "完整任务");
  } finally {
    await stopChild(broker);
    await waitFor(() => !fs.existsSync(socketPath));
    cleanupDir(scope);
  }
});

test("programmatic requests are rebound to the broker's fixed host and return through the same broker", async () => {
  const scope = fs.mkdtempSync("/private/tmp/ccb-programmatic-");
  const workspace = path.join(scope, "workspace");
  const source = path.join(scope, "source");
  const scripts = path.join(source, "scripts");
  const requestCapture = path.join(scope, "request.json");
  const executeCapture = path.join(scope, "execute.json");
  const sessionId = "2".repeat(32);
  const socketPath = path.join(scope, ".cc-suite", "runtime", "brokers", `${sessionId}.sock`);
  const secret = "c".repeat(64);
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(scripts, { recursive: true });
  writeExecutable(path.join(scripts, "dispatch-execute.mjs"), `#!/usr/bin/env node
import fs from "node:fs";
const task = fs.readFileSync(0, "utf8");
fs.writeFileSync(process.env.CC_SUITE_TEST_EXECUTE_CAPTURE, JSON.stringify({
  argv: process.argv.slice(2),
  task,
  host: process.env.CC_SUITE_COMPOSER_HOST ?? null,
  session: process.env.CC_SUITE_COMPOSER_SESSION ?? null,
  socket: process.env.CC_SUITE_DISPATCH_BROKER_SOCKET ?? null,
  secret: process.env.CC_SUITE_DISPATCH_BROKER_SECRET ?? null,
  grant: process.env.CC_SUITE_PROGRAMMATIC_BROKER_GRANT ?? null,
  codexSandbox: process.env.CODEX_SANDBOX ?? null,
  claudeCode: process.env.CLAUDECODE ?? null,
}));
process.stdout.write(JSON.stringify({ status: "completed", rawOutput: "PROGRAMMATIC OK" }) + "\\n");
`);
  writeExecutable(path.join(scripts, "dispatch-request.mjs"), `#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
function exchange(request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: process.env.CC_SUITE_DISPATCH_BROKER_SOCKET });
    const chunks = [];
    socket.once("connect", () => socket.end(JSON.stringify({
      ...request,
      secret: process.env.CC_SUITE_DISPATCH_BROKER_SECRET,
    }) + "\\n"));
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.once("error", reject);
    socket.once("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
  });
}
const task = fs.readFileSync(0, "utf8");
fs.writeFileSync(process.env.CC_SUITE_TEST_REQUEST_CAPTURE, JSON.stringify({
  argv: process.argv.slice(2),
  task,
  host: process.env.CC_SUITE_COMPOSER_HOST,
  session: process.env.CC_SUITE_COMPOSER_SESSION,
  scope: process.env.CC_SUITE_SCOPE_ROOT,
  workspace: process.env.CC_SUITE_WORKSPACE_ROOT,
  socket: process.env.CC_SUITE_DISPATCH_BROKER_SOCKET,
  hasSecret: /^[a-f0-9]{64}$/.test(process.env.CC_SUITE_DISPATCH_BROKER_SECRET ?? ""),
  hasGrant: /^[a-f0-9]{64}$/.test(process.env.CC_SUITE_PROGRAMMATIC_BROKER_GRANT ?? ""),
  claudeOauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null,
  anthropicAuthToken: process.env.ANTHROPIC_AUTH_TOKEN ?? null,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? null,
}));
const authorized = await exchange({
  kind: "authorize-programmatic",
  programmaticGrant: process.env.CC_SUITE_PROGRAMMATIC_BROKER_GRANT,
});
if (authorized.exitCode !== 0) process.exit(91);
const response = await exchange({
  kind: "execute-ticket",
  programmaticGrant: process.env.CC_SUITE_PROGRAMMATIC_BROKER_GRANT,
  ticket: "d".repeat(32),
  cwd: process.cwd(),
  task,
});
process.stderr.write(response.stderr);
process.stdout.write(response.stdout);
process.exitCode = response.exitCode;
`);

  let stderr = "";
  const broker = spawn(process.execPath, [
    BROKER,
    "--socket", socketPath,
    "--secret", secret,
    "--scope", scope,
    "--workspace", workspace,
    "--source", source,
    "--parent-pid", String(process.pid),
    "--host", "codex",
    "--session-id", sessionId,
  ], {
    env: {
      ...process.env,
      CC_SUITE_COMPOSER_HOST: "claude",
      CC_SUITE_COMPOSER_SESSION: "f".repeat(32),
      CC_SUITE_DISPATCH_BROKER_SOCKET: "/tmp/forged.sock",
      CC_SUITE_DISPATCH_BROKER_SECRET: "f".repeat(64),
      CODEX_SANDBOX: "seatbelt",
      CLAUDECODE: "1",
      CLAUDE_CODE_OAUTH_TOKEN: "stale-oauth",
      ANTHROPIC_AUTH_TOKEN: "stale-auth",
      ANTHROPIC_API_KEY: "stale-key",
      CC_SUITE_TEST_REQUEST_CAPTURE: requestCapture,
      CC_SUITE_TEST_EXECUTE_CAPTURE: executeCapture,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  broker.stderr.setEncoding("utf8");
  broker.stderr.on("data", (chunk) => { stderr += chunk; });

  try {
    await waitFor(() => fs.existsSync(socketPath) || broker.exitCode !== null);
    assert.equal(broker.exitCode, null, stderr);
    const config = {
      socketPath,
      scopeRoot: fs.realpathSync(scope),
      sessionId,
      secret,
    };
    const response = await relayProgrammaticRequestThroughBroker({
      ...config,
      target: "claude",
      requestArgv: ["--request-id", "fixed-host", "--prompt-stdin"],
      cwd: workspace,
      prompt: "完整程序化任务\n",
      timeoutMs: 5_000,
    });
    assert.equal(response.exitCode, 0, response.stderr);
    assert.equal(JSON.parse(response.stdout).rawOutput, "PROGRAMMATIC OK");
    const request = JSON.parse(fs.readFileSync(requestCapture, "utf8"));
    assert.deepEqual(request.argv, ["--request-id", "fixed-host", "--prompt-stdin"]);
    assert.equal(request.task, "完整程序化任务\n");
    assert.equal(request.host, "codex");
    assert.equal(request.session, sessionId);
    assert.equal(request.scope, fs.realpathSync(scope));
    assert.equal(request.workspace, fs.realpathSync(workspace));
    assert.equal(request.socket, socketPath);
    assert.equal(request.hasSecret, true);
    assert.equal(request.hasGrant, true);
    assert.equal(request.claudeOauthToken, null);
    assert.equal(request.anthropicAuthToken, null);
    assert.equal(request.anthropicApiKey, null);
    const executed = JSON.parse(fs.readFileSync(executeCapture, "utf8"));
    assert.equal(executed.task, "完整程序化任务\n");
    assert.equal(executed.host, null);
    assert.equal(executed.session, null);
    assert.equal(executed.socket, null);
    assert.equal(executed.secret, null);
    assert.equal(executed.grant, null);
    assert.equal(executed.codexSandbox, null);
    assert.equal(executed.claudeCode, null);

    const rejected = await relayProgrammaticRequestThroughBroker({
      ...config,
      target: "codex",
      requestArgv: ["--request-id", "forged-side", "--prompt-stdin"],
      cwd: workspace,
      prompt: "不得运行",
      timeoutMs: 5_000,
    });
    assert.equal(rejected.exitCode, 1);
    assert.match(rejected.stderr, /opposite the fixed composer host/);
  } finally {
    await stopChild(broker);
    await waitFor(() => !fs.existsSync(socketPath));
    cleanupDir(scope);
  }
});

test("broker client rejects socket paths and modes that do not exactly match the session", async () => {
  const scope = fs.mkdtempSync("/private/tmp/ccb-client-");
  const sessionId = "3".repeat(32);
  const brokerDirectory = path.join(scope, ".cc-suite", "runtime", "brokers");
  fs.mkdirSync(brokerDirectory, { recursive: true });
  const wrong = path.join(brokerDirectory, "wrong.sock");
  const expected = path.join(brokerDirectory, `${sessionId}.sock`);
  let server;
  try {
    assert.throws(() => dispatchBrokerConfig({
      CC_SUITE_SCOPE_ROOT: scope,
      CC_SUITE_COMPOSER_SESSION: sessionId,
      CC_SUITE_DISPATCH_BROKER_SOCKET: wrong,
      CC_SUITE_DISPATCH_BROKER_SECRET: "e".repeat(64),
    }), /does not match/);
    server = net.createServer();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(expected, resolve);
    });
    fs.chmodSync(expected, 0o666);
    assert.throws(() => dispatchBrokerConfig({
      CC_SUITE_SCOPE_ROOT: scope,
      CC_SUITE_COMPOSER_SESSION: sessionId,
      CC_SUITE_DISPATCH_BROKER_SOCKET: expected,
      CC_SUITE_DISPATCH_BROKER_SECRET: "e".repeat(64),
    }), /permissions must be 0600/);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    cleanupDir(scope);
  }
});

test("a Claude host broker accepts only the Codex programmatic direction", async () => {
  const scope = fs.mkdtempSync("/private/tmp/ccb-reverse-");
  const workspace = path.join(scope, "workspace");
  const scripts = path.join(scope, "source", "scripts");
  const sessionId = "4".repeat(32);
  const socketPath = path.join(scope, ".cc-suite", "runtime", "brokers", `${sessionId}.sock`);
  const secret = "f".repeat(64);
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(scripts, { recursive: true });
  writeExecutable(path.join(scripts, "dispatch-execute.mjs"), "#!/usr/bin/env node\nprocess.exit(98);\n");
  writeExecutable(path.join(scripts, "dispatch-request.mjs"), `#!/usr/bin/env node
import fs from "node:fs";
const prompt = fs.readFileSync(0, "utf8");
process.stdout.write(JSON.stringify({
  status: "completed",
  host: process.env.CC_SUITE_COMPOSER_HOST,
  session: process.env.CC_SUITE_COMPOSER_SESSION,
  prompt,
}) + "\\n");
`);
  let stderr = "";
  const broker = spawn(process.execPath, [
    BROKER,
    "--socket", socketPath,
    "--secret", secret,
    "--scope", scope,
    "--workspace", workspace,
    "--source", path.join(scope, "source"),
    "--parent-pid", String(process.pid),
    "--host", "claude",
    "--session-id", sessionId,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  broker.stderr.setEncoding("utf8");
  broker.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    await waitFor(() => fs.existsSync(socketPath) || broker.exitCode !== null);
    assert.equal(broker.exitCode, null, stderr);
    const response = await relayProgrammaticRequestThroughBroker({
      socketPath,
      scopeRoot: fs.realpathSync(scope),
      sessionId,
      secret,
      target: "codex",
      requestArgv: ["--request-id", "reverse", "--prompt-stdin"],
      cwd: workspace,
      prompt: "反向完整任务",
      timeoutMs: 5_000,
    });
    assert.equal(response.exitCode, 0, response.stderr);
    assert.deepEqual(JSON.parse(response.stdout), {
      status: "completed",
      host: "claude",
      session: sessionId,
      prompt: "反向完整任务",
    });
  } finally {
    await stopChild(broker);
    await waitFor(() => !fs.existsSync(socketPath));
    cleanupDir(scope);
  }
});

test("broker shutdown waits for active fixed children and leaves no child or socket behind", async () => {
  const scope = fs.mkdtempSync("/private/tmp/ccb-shutdown-");
  const workspace = path.join(scope, "workspace");
  const scripts = path.join(scope, "source", "scripts");
  const started = path.join(scope, "started");
  const terminated = path.join(scope, "terminated");
  const sessionId = "5".repeat(32);
  const socketPath = path.join(scope, ".cc-suite", "runtime", "brokers", `${sessionId}.sock`);
  const secret = "1".repeat(64);
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(scripts, { recursive: true });
  writeExecutable(path.join(scripts, "dispatch-execute.mjs"), `#!/usr/bin/env node
import fs from "node:fs";
fs.writeFileSync(process.env.CC_SUITE_TEST_STARTED, String(process.pid));
process.on("SIGTERM", () => {
  fs.writeFileSync(process.env.CC_SUITE_TEST_TERMINATED, String(process.pid));
  setTimeout(() => process.exit(0), 100);
});
setInterval(() => {}, 1000);
`);
  writeExecutable(path.join(scripts, "dispatch-request.mjs"), "#!/usr/bin/env node\nprocess.exit(97);\n");
  const broker = spawn(process.execPath, [
    BROKER,
    "--socket", socketPath,
    "--secret", secret,
    "--scope", scope,
    "--workspace", workspace,
    "--source", path.join(scope, "source"),
    "--parent-pid", String(process.pid),
    "--host", "codex",
    "--session-id", sessionId,
  ], {
    env: {
      ...process.env,
      CC_SUITE_TEST_STARTED: started,
      CC_SUITE_TEST_TERMINATED: terminated,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  try {
    await waitFor(() => fs.existsSync(socketPath) || broker.exitCode !== null);
    assert.equal(broker.exitCode, null);
    const pending = relayDispatchThroughBroker({
      socketPath,
      scopeRoot: fs.realpathSync(scope),
      sessionId,
      secret,
      ticket: "6".repeat(32),
      cwd: workspace,
      task: "等待退出",
      timeoutMs: 5_000,
    }).catch(() => null);
    await waitFor(() => fs.existsSync(started));
    const exited = new Promise((resolve) => broker.once("exit", resolve));
    broker.kill("SIGTERM");
    await exited;
    await pending;
    assert.equal(fs.existsSync(terminated), true);
    const childPid = Number(fs.readFileSync(started, "utf8"));
    assert.throws(() => process.kill(childPid, 0));
    assert.equal(fs.existsSync(socketPath), false);
  } finally {
    await stopChild(broker);
    cleanupDir(scope);
  }
});
