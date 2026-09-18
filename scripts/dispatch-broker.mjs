#!/usr/bin/env node
import { cleanTargetEnvironment } from './lib/target-environment.mjs';
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { terminateProcessTree } from "./lib/process.mjs";

const TOKEN_PATTERN = /^[a-f0-9]{32}$/;
const SESSION_PATTERN = /^[a-f0-9]{32}$/;
const SECRET_PATTERN = /^[a-f0-9]{64}$/;
const GRANT_PATTERN = /^[a-f0-9]{64}$/;
const HOSTS = new Set(["claude", "codex"]);
const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_PROGRAMMATIC_ARGV_BYTES = 64 * 1024;
const SHUTDOWN_GRACE_MS = 5_000;
const SHUTDOWN_KILL_WAIT_MS = 1_000;

function fail(message) {
  process.stderr.write(`cc-suite dispatch broker: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const values = {};
  const allowed = new Map([
    ["--socket", "socket"],
    ["--secret", "secret"],
    ["--scope", "scope"],
    ["--workspace", "workspace"],
    ["--source", "source"],
    ["--parent-pid", "parentPid"],
    ["--host", "host"],
    ["--session-id", "sessionId"],
  ]);
  for (let index = 0; index < argv.length;) {
    const key = argv[index++];
    const field = allowed.get(key);
    if (!field || index >= argv.length || values[field] !== undefined) {
      fail("invalid arguments");
    }
    const value = argv[index++];
    if (!value) fail(`missing ${field}`);
    values[field] = value;
  }
  const parentPid = Number(values.parentPid);
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0) fail("invalid parent pid");
  if (!SECRET_PATTERN.test(values.secret ?? "")) fail("invalid broker secret");
  if (!SESSION_PATTERN.test(values.sessionId ?? "")) fail("invalid composer session id");
  if (!HOSTS.has(values.host)) fail("invalid composer host");
  for (const key of ["socket", "scope", "workspace", "source"]) {
    if (typeof values[key] !== "string" || !values[key]) fail(`missing ${key}`);
  }
  return { ...values, parentPid };
}

function realDirectory(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) fail(`${label} is invalid`);
  let resolved;
  try { resolved = fs.realpathSync.native(value); }
  catch (error) { fail(`${label} is not readable: ${error.message}`); }
  if (!fs.statSync(resolved).isDirectory()) fail(`${label} is not a directory`);
  return resolved;
}

function fixedFile(root, relative, label) {
  const candidate = path.join(root, ...relative);
  let resolved;
  try { resolved = fs.realpathSync.native(candidate); }
  catch (error) { fail(`${label} is missing: ${error.message}`); }
  if (!isWithin(root, resolved) || !fs.statSync(resolved).isFile()) fail(`${label} is invalid`);
  return resolved;
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function sameSecret(received, expected, pattern = SECRET_PATTERN) {
  if (typeof received !== "string" || !pattern.test(received)) return false;
  return timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}

function cleanInheritedIdentity() {
  return cleanTargetEnvironment();
}

function executorEnvironment(scopeRoot, workspaceRoot) {
  return {
    ...cleanInheritedIdentity(),
    CC_SUITE_COMPOSER_BYPASS: "1",
    CC_SUITE_DISPATCH_BROKER_BYPASS: "1",
    CC_SUITE_SCOPE_ROOT: scopeRoot,
    CC_SUITE_WORKSPACE_ROOT: workspaceRoot,
    CLAUDE_PLUGIN_DATA: path.join(scopeRoot, ".cc-suite", "runtime"),
  };
}

function programmaticEnvironment(scopeRoot, workspaceRoot, args, grant) {
  return {
    ...cleanInheritedIdentity(),
    CC_SUITE_COMPOSER_BYPASS: "1",
    CC_SUITE_COMPOSER_HOST: args.host,
    CC_SUITE_COMPOSER_SESSION: args.sessionId,
    CC_SUITE_DISPATCH_BROKER_SOCKET: socketPath,
    CC_SUITE_DISPATCH_BROKER_SECRET: args.secret,
    CC_SUITE_PROGRAMMATIC_BROKER_GRANT: grant,
    CC_SUITE_SCOPE_ROOT: scopeRoot,
    CC_SUITE_WORKSPACE_ROOT: workspaceRoot,
    CLAUDE_PLUGIN_DATA: path.join(scopeRoot, ".cc-suite", "runtime"),
  };
}

function canonicalRequestCwd(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error("dispatch working directory is invalid");
  }
  let cwd;
  try { cwd = fs.realpathSync.native(value); }
  catch { throw new Error("dispatch working directory is not readable"); }
  if (!fs.statSync(cwd).isDirectory()) throw new Error("dispatch working directory is not a directory");
  if (!isWithin(workspaceRoot, cwd)) {
    throw new Error("dispatch working directory is outside the active workspace");
  }
  return cwd;
}

function validateProgrammaticArgv(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw new Error("programmatic dispatch arguments are invalid");
  }
  let bytes = 0;
  for (const argument of value) {
    if (typeof argument !== "string" || argument.includes("\0")) {
      throw new Error("programmatic dispatch arguments are invalid");
    }
    bytes += Buffer.byteLength(argument);
  }
  if (bytes > MAX_PROGRAMMATIC_ARGV_BYTES) {
    throw new Error("programmatic dispatch arguments exceeded the size limit");
  }
  if (!value.includes("--prompt-stdin")) {
    throw new Error("programmatic dispatch requires --prompt-stdin");
  }
  return value;
}

const args = parseArgs(process.argv.slice(2));
const scopeRoot = realDirectory(args.scope, "scope");
const workspaceRoot = realDirectory(args.workspace, "workspace");
const sourceRoot = realDirectory(args.source, "source");
if (!isWithin(scopeRoot, workspaceRoot)) fail("workspace is outside scope");

const brokerDirectory = path.join(scopeRoot, ".cc-suite", "runtime", "brokers");
fs.mkdirSync(brokerDirectory, { recursive: true, mode: 0o700 });
const canonicalBrokerDirectory = realDirectory(brokerDirectory, "broker directory");
if (!isWithin(scopeRoot, canonicalBrokerDirectory)) fail("broker directory is outside scope");
fs.chmodSync(canonicalBrokerDirectory, 0o700);
const socketPath = path.join(canonicalBrokerDirectory, `${args.sessionId}.sock`);
if (path.resolve(args.socket) !== socketPath) {
  fail("socket does not match the configured scope and composer session");
}
if (fs.existsSync(socketPath)) fail("broker socket already exists");

const executor = fixedFile(sourceRoot, ["scripts", "dispatch-execute.mjs"], "dispatch executor");
const programmaticDispatcher = fixedFile(
  sourceRoot,
  ["scripts", "dispatch-request.mjs"],
  "programmatic dispatcher",
);
const target = args.host === "codex" ? "claude" : "codex";
const activeChildren = new Set();
const activeSockets = new Set();
const programmaticGrants = new Map();
let shuttingDown = false;
let parentWatch = null;

function send(socket, response) {
  if (socket.destroyed) return;
  socket.end(`${JSON.stringify(response)}\n`);
}

function reject(socket, message) {
  send(socket, { exitCode: 1, stdout: "", stderr: `${message}\n` });
}

function captureChild(socket, child, { onClose } = {}) {
  activeChildren.add(child);
  const stdout = [];
  const stderr = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let overflowed = false;
  let settled = false;

  function capture(output, chunk, kind) {
    if (overflowed) return;
    if (kind === "stdout") stdoutBytes += chunk.length;
    else stderrBytes += chunk.length;
    if (stdoutBytes > MAX_OUTPUT_BYTES || stderrBytes > MAX_OUTPUT_BYTES) {
      overflowed = true;
      try { terminateProcessTree(child.pid, { signal: "SIGTERM" }); } catch {}
      return;
    }
    output.push(chunk);
  }

  function finish(response) {
    if (settled) return;
    settled = true;
    activeChildren.delete(child);
    try { onClose?.(); } catch {}
    if (response) send(socket, response);
  }

  child.stdout.on("data", (chunk) => capture(stdout, chunk, "stdout"));
  child.stderr.on("data", (chunk) => capture(stderr, chunk, "stderr"));
  child.once("error", (error) => {
    finish({
      exitCode: 1,
      stdout: "",
      stderr: `could not start fixed dispatch process: ${error.message}\n`,
    });
  });
  child.once("close", (code, signal) => {
    if (overflowed) {
      finish({ exitCode: 1, stdout: "", stderr: "dispatch process output exceeded the size limit\n" });
      return;
    }
    finish({
      exitCode: Number.isInteger(code) ? code : 1,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: [
        Buffer.concat(stderr).toString("utf8"),
        signal ? `dispatch process ended by ${signal}\n` : "",
      ].join(""),
    });
  });
  return child;
}

function executeTicket(socket, request) {
  if (!TOKEN_PATTERN.test(request?.ticket ?? "")) {
    reject(socket, "invalid dispatch ticket");
    return;
  }
  if (typeof request?.task !== "string" || !request.task.trim()) {
    reject(socket, "dispatch task is empty");
    return;
  }
  let cwd;
  try { cwd = canonicalRequestCwd(request.cwd); }
  catch (error) { reject(socket, error.message); return; }

  if (request.programmaticGrant !== undefined) {
    const grant = programmaticGrants.get(request.programmaticGrant);
    if (!grant || !grant.authorized || grant.consumed) {
      reject(socket, "programmatic dispatch grant is invalid or already used");
      return;
    }
    grant.consumed = true;
  }

  const child = spawn(process.execPath, [
    executor,
    "--ticket", request.ticket,
    "--prompt-stdin",
  ], {
    cwd,
    env: executorEnvironment(scopeRoot, workspaceRoot),
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  captureChild(socket, child);
  child.stdin.on("error", () => {});
  child.stdin.end(request.task);
}

function authorizeProgrammatic(socket, request) {
  if (!GRANT_PATTERN.test(request?.programmaticGrant ?? "")) {
    reject(socket, "programmatic dispatch grant is invalid");
    return;
  }
  const grant = programmaticGrants.get(request.programmaticGrant);
  if (!grant || grant.authorized || grant.consumed) {
    reject(socket, "programmatic dispatch grant is invalid or already used");
    return;
  }
  grant.authorized = true;
  send(socket, { exitCode: 0, stdout: "", stderr: "" });
}

function executeProgrammaticRequest(socket, request) {
  if (request?.target !== target) {
    reject(socket, "programmatic dispatch target must be opposite the fixed composer host");
    return;
  }
  if (typeof request?.prompt !== "string" || !request.prompt.trim()) {
    reject(socket, "programmatic dispatch prompt is empty");
    return;
  }
  let cwd;
  let requestArgv;
  try {
    cwd = canonicalRequestCwd(request.cwd);
    requestArgv = validateProgrammaticArgv(request.requestArgv);
  } catch (error) {
    reject(socket, error.message);
    return;
  }

  const grant = randomBytes(32).toString("hex");
  const child = spawn(process.execPath, [programmaticDispatcher, ...requestArgv], {
    cwd,
    env: programmaticEnvironment(scopeRoot, workspaceRoot, args, grant),
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  programmaticGrants.set(grant, { child, authorized: false, consumed: false });
  captureChild(socket, child, { onClose: () => programmaticGrants.delete(grant) });
  child.stdin.on("error", () => {});
  child.stdin.end(request.prompt);
}

function handleRequest(socket, request) {
  if (shuttingDown) {
    reject(socket, "dispatch broker is shutting down");
    return;
  }
  if (!sameSecret(request?.secret, args.secret)) {
    reject(socket, "dispatch broker authentication failed");
    return;
  }
  if (request?.kind === "execute-ticket") {
    executeTicket(socket, request);
    return;
  }
  if (request?.kind === "programmatic-request") {
    executeProgrammaticRequest(socket, request);
    return;
  }
  if (request?.kind === "authorize-programmatic") {
    authorizeProgrammatic(socket, request);
    return;
  }
  reject(socket, "unsupported dispatch broker request");
}

const server = net.createServer({ allowHalfOpen: true }, (socket) => {
  activeSockets.add(socket);
  socket.setEncoding("utf8");
  let requestText = "";
  let requestBytes = 0;
  let handled = false;
  socket.once("close", () => activeSockets.delete(socket));
  socket.on("data", (chunk) => {
    if (handled) return;
    requestText += chunk;
    requestBytes += Buffer.byteLength(chunk);
    if (requestBytes > MAX_REQUEST_BYTES) {
      handled = true;
      reject(socket, "dispatch broker request exceeded the size limit");
      return;
    }
    const newline = requestText.indexOf("\n");
    if (newline === -1) return;
    handled = true;
    try { handleRequest(socket, JSON.parse(requestText.slice(0, newline))); }
    catch (error) { reject(socket, error.message); }
  });
  socket.once("error", () => {});
});
server.maxConnections = 8;

function removeSocket() {
  try {
    const stat = fs.lstatSync(socketPath);
    if (stat.isSocket() && (typeof process.getuid !== "function" || stat.uid === process.getuid())) {
      fs.unlinkSync(socketPath);
    }
  } catch {}
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForActiveChildren(milliseconds) {
  const children = [...activeChildren];
  if (!children.length) return true;
  const exited = Promise.all(children.map((child) => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null || !activeChildren.has(child)) resolve();
    else child.once("close", resolve);
  }))).then(() => true);
  return Promise.race([exited, delay(milliseconds).then(() => false)]);
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (parentWatch) clearInterval(parentWatch);
  try { server.close(); } catch {}
  for (const child of activeChildren) {
    try { terminateProcessTree(child.pid, { signal: "SIGTERM" }); } catch {}
  }
  if (!(await waitForActiveChildren(SHUTDOWN_GRACE_MS))) {
    for (const child of activeChildren) {
      try { terminateProcessTree(child.pid, { signal: "SIGKILL" }); } catch {}
    }
    await waitForActiveChildren(SHUTDOWN_KILL_WAIT_MS);
    if (activeChildren.size) exitCode = 1;
  }
  for (const socket of activeSockets) socket.destroy();
  removeSocket();
  process.exit(exitCode);
}

process.on("SIGINT", () => { void shutdown(0); });
process.on("SIGTERM", () => { void shutdown(0); });
process.on("SIGHUP", () => { void shutdown(0); });
process.once("exit", removeSocket);
server.once("error", (error) => {
  process.stderr.write(`cc-suite dispatch broker: socket failed: ${error.message}\n`);
  void shutdown(1);
});
process.on("uncaughtException", (error) => {
  process.stderr.write(`cc-suite dispatch broker: unexpected failure: ${error.message}\n`);
  void shutdown(1);
});
process.on("unhandledRejection", (error) => {
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(`cc-suite dispatch broker: unexpected rejection: ${detail}\n`);
  void shutdown(1);
});
parentWatch = setInterval(() => {
  try { process.kill(args.parentPid, 0); }
  catch { void shutdown(0); }
}, 1_000);

server.listen(socketPath, () => {
  fs.chmodSync(socketPath, 0o600);
});
