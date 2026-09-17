import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const TOKEN_PATTERN = /^[a-f0-9]{32}$/;
const SESSION_PATTERN = /^[a-f0-9]{32}$/;
const SECRET_PATTERN = /^[a-f0-9]{64}$/;
const GRANT_PATTERN = /^[a-f0-9]{64}$/;
const TARGETS = new Set(["claude", "codex"]);
const MAX_RESPONSE_BYTES = 80 * 1024 * 1024;
// Outlive the 60-minute runner and its 30-second terminalization allowance.
export const BROKER_TIMEOUT_MS = 61 * 60 * 1000;

function canonicalDirectory(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`${label} is invalid`);
  }
  let resolved;
  try { resolved = fs.realpathSync.native(value); }
  catch (error) { throw new Error(`${label} is not readable: ${error.message}`); }
  if (!fs.statSync(resolved).isDirectory()) throw new Error(`${label} is not a directory`);
  return resolved;
}

function expectedBrokerSocket(scopeRoot, sessionId) {
  return path.join(
    scopeRoot,
    ".cc-suite",
    "runtime",
    "brokers",
    `${sessionId}.sock`,
  );
}

export function validateBrokerEndpoint({ socketPath, scopeRoot, sessionId }) {
  if (!SESSION_PATTERN.test(sessionId ?? "")) {
    throw new Error("dispatch broker session is invalid");
  }
  const canonicalScope = canonicalDirectory(scopeRoot, "dispatch broker scope");
  const expected = expectedBrokerSocket(canonicalScope, sessionId);
  if (typeof socketPath !== "string" || !path.isAbsolute(socketPath)) {
    throw new Error("dispatch broker socket is invalid");
  }
  if (path.resolve(socketPath) !== expected) {
    throw new Error("dispatch broker socket does not match the active scope and session");
  }
  let stat;
  try { stat = fs.lstatSync(expected); }
  catch (error) { throw new Error(`dispatch broker socket is unavailable: ${error.message}`); }
  if (!stat.isSocket()) throw new Error("dispatch broker path is not a Unix socket");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error("dispatch broker socket is owned by another user");
  }
  if ((stat.mode & 0o777) !== 0o600) {
    throw new Error("dispatch broker socket permissions must be 0600");
  }
  return { socketPath: expected, scopeRoot: canonicalScope, sessionId };
}

export function dispatchBrokerConfig(env = process.env) {
  const socketPath = env.CC_SUITE_DISPATCH_BROKER_SOCKET;
  const secret = env.CC_SUITE_DISPATCH_BROKER_SECRET;
  const scopeRoot = env.CC_SUITE_SCOPE_ROOT;
  const sessionId = env.CC_SUITE_COMPOSER_SESSION;
  const programmaticGrant = env.CC_SUITE_PROGRAMMATIC_BROKER_GRANT;
  const present = [socketPath, secret, programmaticGrant]
    .some((value) => value !== undefined && value !== "");
  if (!present) return null;
  if (typeof secret !== "string" || !SECRET_PATTERN.test(secret)) {
    throw new Error("dispatch broker secret is invalid");
  }
  if (programmaticGrant !== undefined && !GRANT_PATTERN.test(programmaticGrant)) {
    throw new Error("programmatic broker grant is invalid");
  }
  return {
    ...validateBrokerEndpoint({ socketPath, scopeRoot, sessionId }),
    secret,
    ...(programmaticGrant ? { programmaticGrant } : {}),
  };
}

function exchangeBrokerMessage({
  socketPath,
  scopeRoot,
  sessionId,
  secret,
  request,
  timeoutMs = BROKER_TIMEOUT_MS,
}) {
  if (typeof secret !== "string" || !SECRET_PATTERN.test(secret)) {
    throw new Error("dispatch broker secret is invalid");
  }
  const endpoint = validateBrokerEndpoint({ socketPath, scopeRoot, sessionId });
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: endpoint.socketPath });
    const chunks = [];
    let bytes = 0;
    let settled = false;

    function finish(error, value) {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    }

    socket.setTimeout(timeoutMs, () => finish(new Error("dispatch broker timed out")));
    socket.once("connect", () => {
      socket.end(`${JSON.stringify({ ...request, secret })}\n`);
    });
    socket.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_RESPONSE_BYTES) {
        finish(new Error("dispatch broker response exceeded the size limit"));
        return;
      }
      chunks.push(chunk);
    });
    socket.once("error", (error) => finish(error));
    socket.once("end", () => {
      if (settled) return;
      try {
        const response = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (
          !Number.isInteger(response?.exitCode)
          || typeof response?.stdout !== "string"
          || typeof response?.stderr !== "string"
        ) {
          throw new Error("dispatch broker returned an invalid response");
        }
        finish(null, response);
      } catch (error) {
        finish(error);
      }
    });
  });
}

export function authorizeProgrammaticBrokerLaunch(config) {
  if (!GRANT_PATTERN.test(config?.programmaticGrant ?? "")) {
    throw new Error("programmatic broker grant is missing or invalid");
  }
  return exchangeBrokerMessage({
    ...config,
    request: {
      kind: "authorize-programmatic",
      programmaticGrant: config.programmaticGrant,
    },
    timeoutMs: 5_000,
  }).then((response) => {
    if (response.exitCode !== 0) {
      throw new Error(response.stderr.trim() || "programmatic broker launch was not authorized");
    }
    return response;
  });
}

export function relayDispatchThroughBroker({
  socketPath,
  scopeRoot,
  sessionId,
  secret,
  programmaticGrant,
  ticket,
  cwd,
  task,
  timeoutMs = BROKER_TIMEOUT_MS,
}) {
  if (!TOKEN_PATTERN.test(ticket)) throw new Error("invalid dispatch ticket");
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) {
    throw new Error("dispatch broker cwd is invalid");
  }
  if (typeof task !== "string" || !task.trim()) throw new Error("dispatch task is empty");
  if (programmaticGrant !== undefined && !GRANT_PATTERN.test(programmaticGrant)) {
    throw new Error("programmatic broker grant is invalid");
  }
  return exchangeBrokerMessage({
    socketPath,
    scopeRoot,
    sessionId,
    secret,
    timeoutMs,
    request: {
      kind: "execute-ticket",
      ticket,
      cwd,
      task,
      ...(programmaticGrant ? { programmaticGrant } : {}),
    },
  });
}

export function relayProgrammaticRequestThroughBroker({
  socketPath,
  scopeRoot,
  sessionId,
  secret,
  target,
  requestArgv,
  cwd,
  prompt,
  timeoutMs = BROKER_TIMEOUT_MS,
}) {
  if (!TARGETS.has(target)) throw new Error("invalid programmatic dispatch target");
  if (!Array.isArray(requestArgv) || requestArgv.some((value) => typeof value !== "string")) {
    throw new Error("programmatic dispatch arguments are invalid");
  }
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) {
    throw new Error("programmatic dispatch cwd is invalid");
  }
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new Error("programmatic dispatch prompt is empty");
  }
  return exchangeBrokerMessage({
    socketPath,
    scopeRoot,
    sessionId,
    secret,
    timeoutMs,
    request: {
      kind: "programmatic-request",
      target,
      requestArgv,
      cwd,
      prompt,
    },
  });
}
