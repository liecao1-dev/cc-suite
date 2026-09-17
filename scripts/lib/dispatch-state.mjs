import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { getConfig, updateState } from "./state.mjs";
import { readRecentDispatchRecord, withRecentDispatch } from "./dispatch-config.mjs";
import { resolveScopedWorkspace } from "./scoped-dispatch.mjs";

export const PENDING_TTL_MS = 30 * 60 * 1000;
export const TICKET_TTL_MS = 30 * 60 * 1000;
export const EXACT_RESPONSE_TTL_MS = 30 * 60 * 1000;
export const DISPATCH_TIMEOUT_MS = 60 * 60 * 1000;
// dispatch-execute gives a runner 60 minutes and its synchronous wrapper a
// further 30 seconds to stop and persist the terminal result. Once that whole
// window has elapsed, an unfinalized claim is a tombstone, never retryable
// work.
export const PROGRAMMATIC_CLAIM_STALL_MS = DISPATCH_TIMEOUT_MS + 30 * 1000;
export const PROGRAMMATIC_TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_PROGRAMMATIC_ACTIVE_REQUESTS = 128;
export const MAX_PROGRAMMATIC_TERMINAL_REQUESTS = 128;
const TOKEN_PATTERN = /^[a-f0-9]{32}$/;
const THREAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_CONVERSATION_BINDINGS = 50;
const MAX_CONVERSATION_TURNS = 24;
const MAX_TURN_TEXT_CHARS = 60_000;
const MAX_EXACT_RESPONSES = 20;
const PROGRAMMATIC_KEY_PATTERN = /^[a-f0-9]{64}$/;
const MAX_PROGRAMMATIC_ID_CHARS = 256;
const MAX_PROGRAMMATIC_ERROR_CHARS = 4_000;
const PROGRAMMATIC_ACTIVE_STATUSES = new Set(["prepared", "claimed"]);
const PROGRAMMATIC_TERMINAL_STATUSES = new Set(["completed", "failed", "stalled"]);

export function configureProjectStateRoot(cwd) {
  return resolveScopedWorkspace(cwd).workspaceRoot;
}

function sessionKey(host, sessionId) {
  if (!/^(codex|claude)$/.test(host)) throw new Error(`unsupported host: ${host}`);
  if (typeof sessionId !== "string" || !sessionId.trim()) throw new Error("hook session_id is required");
  return `${host}-${createHash("sha256").update(sessionId).digest("hex").slice(0, 24)}`;
}

function conversationKey(host, target, hostSessionId) {
  if (!/^(codex|claude)$/.test(target) || target === host) {
    throw new Error(`unsupported dispatch conversation: ${host} -> ${target}`);
  }
  return `${host}-${target}-${createHash("sha256").update(hostSessionId).digest("hex").slice(0, 24)}`;
}

function sameDispatchConfig(left, right) {
  return ["model", "effort", "access", "approval"]
    .every((field) => left?.[field] === right?.[field]);
}

function boundedConversationText(value) {
  const text = String(value ?? "");
  if (text.length <= MAX_TURN_TEXT_CHARS) return text;
  const half = Math.floor((MAX_TURN_TEXT_CHARS - 40) / 2);
  return `${text.slice(0, half)}\n...[conversation text truncated]...\n${text.slice(-half)}`;
}

function normalizeConversationTurns(turns) {
  return (Array.isArray(turns) ? turns : [])
    .filter((turn) => turn && typeof turn.prompt === "string" && typeof turn.output === "string")
    .map((turn) => ({
      prompt: boundedConversationText(turn.prompt),
      output: boundedConversationText(turn.output),
    }))
    .slice(-MAX_CONVERSATION_TURNS);
}

function nowIso(now) {
  return new Date(now).toISOString();
}

function isControlPrompt(prompt) {
  const text = String(prompt ?? "").trim();
  if (!text) return true;
  return /^\/[A-Za-z][A-Za-z0-9_-]*(?:\s|$)/.test(text)
    || /^\$[A-Za-z][A-Za-z0-9_-]*(?:\s|$)/.test(text);
}

function pruneTickets(tickets, now) {
  const kept = Object.entries(tickets ?? {})
    .filter(([, ticket]) => Number(ticket?.expiresAtMs) > now)
    .sort((a, b) => Number(b[1]?.createdAtMs ?? 0) - Number(a[1]?.createdAtMs ?? 0))
    .slice(0, 20);
  return Object.fromEntries(kept);
}

function requireProgrammaticId(value, label) {
  if (
    typeof value !== "string"
    || !value
    || value.length > MAX_PROGRAMMATIC_ID_CHARS
    || value.includes("\u0000")
  ) {
    throw new Error(`${label} must be a non-empty string of at most ${MAX_PROGRAMMATIC_ID_CHARS} characters`);
  }
  return value;
}

function programmaticRequestKey(projectRoot, requestId) {
  return createHash("sha256")
    .update(projectRoot)
    .update("\u0000")
    .update(requestId)
    .digest("hex");
}

function typedProgrammaticConversationKey(host, target, conversationId) {
  return createHash("sha256")
    .update(host)
    .update("\u0000")
    .update(target)
    .update("\u0000")
    .update(conversationId)
    .digest("hex");
}

function requestTimestamp(request, ...fields) {
  for (const field of fields) {
    const value = Number(request?.[field]);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

function stalledProgrammaticRequest(request, now) {
  const seconds = Math.round(PROGRAMMATIC_CLAIM_STALL_MS / 1000);
  const terminal = {
    status: "stalled",
    error: `Programmatic dispatch exceeded its ${seconds}s claimed execution window; it will not be run again`,
  };
  return {
    ...request,
    status: "stalled",
    terminal,
    completedAt: nowIso(now),
    completedAtMs: now,
    updatedAt: nowIso(now),
    updatedAtMs: now,
  };
}

/** Keep every active request, terminalize overdue claims, and retain only a
 * bounded recent terminal history. Active capacity is enforced separately so
 * this registry remains bounded without ever deleting prepared/claimed work. */
function normalizeProgrammaticRequests(requests, now) {
  const active = [];
  const terminal = [];
  for (const [key, original] of Object.entries(requests ?? {})) {
    if (!original || original.requestKey !== key) continue;
    let request = original;
    if (request.status === "claimed") {
      const claimedAtMs = requestTimestamp(
        request,
        "claimedAtMs",
        "updatedAtMs",
        "createdAtMs",
      );
      if (
        claimedAtMs !== null
        && now - claimedAtMs >= PROGRAMMATIC_CLAIM_STALL_MS
      ) {
        request = stalledProgrammaticRequest(request, now);
      }
    }
    if (PROGRAMMATIC_ACTIVE_STATUSES.has(request.status)) {
      active.push([key, request]);
      continue;
    }
    if (!PROGRAMMATIC_TERMINAL_STATUSES.has(request.status)) continue;
    const terminalAtMs = requestTimestamp(
      request,
      "completedAtMs",
      "updatedAtMs",
      "createdAtMs",
    );
    if (
      terminalAtMs !== null
      && now - terminalAtMs <= PROGRAMMATIC_TERMINAL_RETENTION_MS
    ) {
      terminal.push([key, request]);
    }
  }
  terminal.sort((left, right) => (
    requestTimestamp(right[1], "completedAtMs", "updatedAtMs", "createdAtMs")
    - requestTimestamp(left[1], "completedAtMs", "updatedAtMs", "createdAtMs")
  ));
  return Object.fromEntries([
    ...active,
    ...terminal.slice(0, MAX_PROGRAMMATIC_TERMINAL_REQUESTS),
  ]);
}

function typedConversationKeyForRequest(request) {
  if (PROGRAMMATIC_KEY_PATTERN.test(request?.typedConversationKey ?? "")) {
    return request.typedConversationKey;
  }
  // Compatibility with the first programmatic state schema, which stored the
  // hash of the raw conversation id but did not include host/target in it.
  if (
    /^(codex|claude)$/.test(request?.host ?? "")
    && /^(codex|claude)$/.test(request?.target ?? "")
    && PROGRAMMATIC_KEY_PATTERN.test(request?.conversationKey ?? "")
  ) {
    return typedProgrammaticConversationKey(
      request.host,
      request.target,
      request.conversationKey,
    );
  }
  return null;
}

function programmaticFingerprint({
  host,
  target,
  projectRoot,
  selectedCwd,
  conversationId,
  delivery,
  toolPolicy,
  config,
  prompt,
}) {
  const promptHash = createHash("sha256").update(prompt).digest("hex");
  return createHash("sha256").update(JSON.stringify({
    schema: 1,
    host,
    target,
    projectRoot,
    selectedCwd,
    conversationId,
    delivery,
    toolPolicy,
    config: {
      model: config?.model ?? null,
      effort: config?.effort ?? null,
      access: config?.access ?? null,
      approval: config?.approval ?? null,
    },
    promptHash,
  })).digest("hex");
}

function dispatchTicket(state, payload, now) {
  const token = randomBytes(16).toString("hex");
  const bindingKey = conversationKey(payload.host, payload.target, payload.hostSessionId);
  const binding = state.config.dispatchConversations?.[bindingKey];
  const resumeThreadId = (
    binding?.host === payload.host
    && binding?.target === payload.target
    && binding?.hostSessionId === payload.hostSessionId
    && sameDispatchConfig(binding?.config, payload.config)
    && THREAD_ID_PATTERN.test(binding?.threadId ?? "")
  ) ? binding.threadId : null;
  const conversationTurns = resumeThreadId
    ? normalizeConversationTurns(binding?.turns)
    : [];
  const delivery = payload.delivery ?? "host-relay";
  const toolPolicy = payload.toolPolicy ?? "standard";
  return {
    schema: 1,
    token,
    host: payload.host,
    target: payload.target,
    sessionId: payload.sessionId,
    hostSessionId: payload.hostSessionId,
    hostTurnId: typeof payload.hostTurnId === "string" ? payload.hostTurnId : null,
    projectRoot: payload.projectRoot,
    selectedCwd: payload.selectedCwd,
    config: payload.config,
    selectedProfile: payload.selectedProfile ?? null,
    selectedAt: payload.selectedAt ?? nowIso(now),
    delivery,
    toolPolicy,
    resumeThreadId,
    conversationTurns,
    ...(payload.programmaticRequestKey
      ? {
        programmaticRequestKey: payload.programmaticRequestKey,
        promptHash: payload.promptHash,
        exactRelay: delivery === "host-relay",
      }
      : {}),
    createdAt: nowIso(now),
    createdAtMs: now,
    expiresAt: nowIso(now + TICKET_TTL_MS),
    expiresAtMs: now + TICKET_TTL_MS,
  };
}

function pruneExactResponses(responses, now) {
  return Object.fromEntries(
    Object.entries(responses ?? {})
      .filter(([, response]) => (
        response
        && response.host === "codex"
        && response.target === "claude"
        && typeof response.hostSessionId === "string"
        && typeof response.rawOutput === "string"
        && Number(response.expiresAtMs) > now
      ))
      .sort((left, right) => Number(right[1]?.createdAtMs ?? 0) - Number(left[1]?.createdAtMs ?? 0))
      .slice(0, MAX_EXACT_RESPONSES),
  );
}

function pruneConversationBindings(bindings) {
  return Object.fromEntries(
    Object.entries(bindings ?? {})
      .filter(([, binding]) => (
        binding
        && /^(codex|claude)$/.test(binding.host)
        && /^(codex|claude)$/.test(binding.target)
        && binding.host !== binding.target
        && THREAD_ID_PATTERN.test(binding.threadId ?? "")
      ))
      .map(([key, binding]) => [key, {
        ...binding,
        turns: normalizeConversationTurns(binding.turns),
      }])
      .sort((left, right) => Number(right[1]?.usedAtMs ?? 0) - Number(left[1]?.usedAtMs ?? 0))
      .slice(0, MAX_CONVERSATION_BINDINGS),
  );
}

export function clearPendingDispatch(cwd, { host, sessionId }) {
  const projectRoot = configureProjectStateRoot(cwd);
  const key = sessionKey(host, sessionId);
  updateState(projectRoot, (state) => {
    const pending = { ...(state.config.pendingDispatch ?? {}) };
    delete pending[key];
    state.config.pendingDispatch = pending;
  });
}

export function savePendingDispatch(cwd, payload, now = Date.now()) {
  const projectRoot = configureProjectStateRoot(cwd);
  const key = sessionKey(payload.host, payload.sessionId);
  const pending = {
    schema: 1,
    host: payload.host,
    target: payload.target,
    sessionId: payload.sessionId,
    projectRoot,
    cwd: fs.realpathSync.native(path.resolve(cwd)),
    config: payload.config,
    catalogVersion: payload.catalogVersion ?? null,
    selectedProfile: payload.selectedProfile ?? null,
    createdAt: nowIso(now),
    createdAtMs: now,
    expiresAt: nowIso(now + PENDING_TTL_MS),
    expiresAtMs: now + PENDING_TTL_MS,
  };
  updateState(projectRoot, (state) => {
    state.config.pendingDispatch = {
      ...(state.config.pendingDispatch ?? {}),
      [key]: pending,
    };
  });
  return pending;
}

/** Convert a pending selection into a one-shot execution ticket only for an
 * ordinary task prompt. Control commands and other skill invocations leave it
 * untouched. */
export function ticketForSubmittedPrompt(
  cwd,
  { host, sessionId, hostSessionId = sessionId, hostTurnId = null, prompt },
  now = Date.now(),
) {
  if (isControlPrompt(prompt)) return { status: "control" };
  const projectRoot = configureProjectStateRoot(cwd);
  const key = sessionKey(host, sessionId);
  // User-level hooks run for every prompt in the configured scope. Keep the
  // overwhelmingly common unarmed path read-only and return before taking a
  // state lock or creating the centralized runtime directory.
  if (!getConfig(projectRoot).pendingDispatch?.[key]) return { status: "none" };
  let result = { status: "none" };
  updateState(projectRoot, (state) => {
    const pendingMap = { ...(state.config.pendingDispatch ?? {}) };
    const pending = pendingMap[key];
    if (!pending) return;
    delete pendingMap[key];
    state.config.pendingDispatch = pendingMap;
    if (
      pending.host !== host
      || pending.sessionId !== sessionId
      || pending.projectRoot !== projectRoot
      || Number(pending.expiresAtMs) <= now
    ) {
      result = { status: "expired" };
      return;
    }
    const ticket = dispatchTicket(state, {
      host,
      target: pending.target,
      sessionId,
      hostSessionId,
      hostTurnId,
      projectRoot,
      selectedCwd: pending.cwd,
      config: pending.config,
      selectedProfile: pending.selectedProfile,
      selectedAt: pending.createdAt,
    }, now);
    state.config.dispatchTickets = {
      ...pruneTickets(state.config.dispatchTickets, now),
      [ticket.token]: ticket,
    };
    result = { status: "ready", ticket };
  });
  return result;
}

/** Create or recover the hidden one-shot ticket for an explicitly identified
 * programmatic request. The caller supplies the prompt only so its exact bytes
 * can be bound to the idempotency key; prompt text is never persisted here. */
export function prepareProgrammaticDispatch(cwd, payload, now = Date.now()) {
  if (!/^(codex|claude)$/.test(payload?.host)) {
    throw new Error(`unsupported host: ${payload?.host}`);
  }
  if (!/^(codex|claude)$/.test(payload?.target) || payload.target === payload.host) {
    throw new Error(`unsupported dispatch target: ${payload?.target}`);
  }
  const requestId = requireProgrammaticId(payload.requestId, "programmatic request id");
  const conversationId = requireProgrammaticId(
    payload.conversationId,
    "programmatic conversation id",
  );
  const sessionId = requireProgrammaticId(payload.sessionId, "composer session id");
  const delivery = payload.delivery ?? "workflow";
  const toolPolicy = payload.toolPolicy ?? "standard";
  if (!["workflow", "host-relay"].includes(delivery)) {
    throw new Error(`unsupported programmatic delivery: ${delivery}`);
  }
  if (!["standard", "none"].includes(toolPolicy)) {
    throw new Error(`unsupported programmatic tool policy: ${toolPolicy}`);
  }
  if (typeof payload.prompt !== "string" || !payload.prompt.trim()) {
    throw new Error("programmatic dispatch prompt is empty");
  }
  if (!payload.config || typeof payload.config !== "object" || Array.isArray(payload.config)) {
    throw new Error("programmatic dispatch config must be an object");
  }

  const scoped = resolveScopedWorkspace(cwd);
  const projectRoot = scoped.workspaceRoot;
  const selectedCwd = scoped.selectedCwd;
  const key = programmaticRequestKey(projectRoot, requestId);
  const conversationIdentityHash = createHash("sha256").update(conversationId).digest("hex");
  const typedConversationKey = typedProgrammaticConversationKey(
    payload.host,
    payload.target,
    conversationIdentityHash,
  );
  const hostSessionId = delivery === "host-relay"
    ? conversationId
    : `programmatic:${conversationId}`;
  const fingerprint = programmaticFingerprint({
    host: payload.host,
    target: payload.target,
    projectRoot,
    selectedCwd,
    conversationId,
    delivery,
    toolPolicy,
    config: payload.config,
    prompt: payload.prompt,
  });
  const promptHash = createHash("sha256").update(payload.prompt).digest("hex");
  let result;

  updateState(projectRoot, (state) => {
    const requests = normalizeProgrammaticRequests(
      state.config.programmaticDispatches,
      now,
    );
    state.config.programmaticDispatches = requests;
    state.config.dispatchTickets = pruneTickets(state.config.dispatchTickets, now);
    const existing = requests[key];
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        result = { status: "conflict", requestKey: key };
        return;
      }
      if (PROGRAMMATIC_TERMINAL_STATUSES.has(existing.status)) {
        result = { status: "terminal", requestKey: key, request: existing };
        return;
      }
      if (existing.status === "claimed") {
        result = { status: "claimed", requestKey: key, request: existing };
        return;
      }

      const tickets = state.config.dispatchTickets;
      const reusable = tickets[existing.ticketToken];
      if (
        existing.status === "prepared"
        && reusable?.programmaticRequestKey === key
        && Number(reusable.expiresAtMs) > now
      ) {
        state.config.dispatchTickets = tickets;
        result = { status: "ready", requestKey: key, ticket: reusable, reused: true };
        return;
      }

      const replacement = dispatchTicket(state, {
        host: payload.host,
        target: payload.target,
        sessionId,
        hostSessionId,
        hostTurnId: null,
        projectRoot,
        selectedCwd,
        config: payload.config,
        selectedProfile: "programmatic",
        programmaticRequestKey: key,
        promptHash,
        delivery,
        toolPolicy,
      }, now);
      state.config.dispatchTickets = {
        ...tickets,
        [replacement.token]: replacement,
      };
      requests[key] = {
        ...existing,
        status: "prepared",
        typedConversationKey,
        ticketToken: replacement.token,
        updatedAt: nowIso(now),
        updatedAtMs: now,
      };
      state.config.programmaticDispatches = requests;
      result = { status: "ready", requestKey: key, ticket: replacement, reused: true };
      return;
    }

    const activeConversationRequest = Object.values(requests).find((request) => (
      PROGRAMMATIC_ACTIVE_STATUSES.has(request?.status)
      && typedConversationKeyForRequest(request) === typedConversationKey
    ));
    if (activeConversationRequest) {
      result = {
        status: "busy",
        reason: "conversation-active",
        requestKey: key,
        activeRequestKey: activeConversationRequest.requestKey,
        activeStatus: activeConversationRequest.status,
      };
      return;
    }

    const activeCount = Object.values(requests)
      .filter((request) => PROGRAMMATIC_ACTIVE_STATUSES.has(request?.status))
      .length;
    if (activeCount >= MAX_PROGRAMMATIC_ACTIVE_REQUESTS) {
      result = {
        status: "busy",
        reason: "registry-capacity",
        requestKey: key,
        activeCount,
      };
      return;
    }

    const ticket = dispatchTicket(state, {
      host: payload.host,
      target: payload.target,
      sessionId,
      hostSessionId,
      hostTurnId: null,
      projectRoot,
      selectedCwd,
      config: payload.config,
      selectedProfile: "programmatic",
      programmaticRequestKey: key,
      promptHash,
      delivery,
      toolPolicy,
    }, now);
    const request = {
      schema: 2,
      requestKey: key,
      fingerprint,
      status: "prepared",
      host: payload.host,
      target: payload.target,
      projectRoot,
      selectedCwd,
      conversationKey: conversationIdentityHash,
      typedConversationKey,
      delivery,
      toolPolicy,
      config: payload.config,
      ticketToken: ticket.token,
      createdAt: nowIso(now),
      createdAtMs: now,
      updatedAt: nowIso(now),
      updatedAtMs: now,
    };
    state.config.dispatchTickets = {
      ...pruneTickets(state.config.dispatchTickets, now),
      [ticket.token]: ticket,
    };
    state.config.programmaticDispatches = { ...requests, [key]: request };
    result = { status: "ready", requestKey: key, ticket, reused: false };
  });
  return result;
}

export function readProgrammaticDispatch(cwd, requestKey, now = Date.now()) {
  if (typeof requestKey !== "string" || !PROGRAMMATIC_KEY_PATTERN.test(requestKey)) {
    throw new Error("invalid programmatic request key");
  }
  const projectRoot = configureProjectStateRoot(cwd);
  const snapshot = getConfig(projectRoot).programmaticDispatches?.[requestKey] ?? null;
  if (snapshot?.status !== "claimed") return snapshot;
  const claimedAtMs = requestTimestamp(
    snapshot,
    "claimedAtMs",
    "updatedAtMs",
    "createdAtMs",
  );
  if (
    claimedAtMs === null
    || now - claimedAtMs < PROGRAMMATIC_CLAIM_STALL_MS
  ) {
    return snapshot;
  }
  let current = null;
  updateState(projectRoot, (state) => {
    const requests = normalizeProgrammaticRequests(
      state.config.programmaticDispatches,
      now,
    );
    state.config.programmaticDispatches = requests;
    current = requests[requestKey] ?? null;
  });
  return current;
}

function programmaticTerminalMetadata(payload) {
  const status = ["completed", "failed", "stalled"].includes(payload?.status)
    ? payload.status
    : "failed";
  const clean = { status };
  for (const field of [
    "jobId",
    "threadId",
    "target",
    "selectedProfile",
    "contextMode",
    "delivery",
    "toolPolicy",
  ]) {
    if (typeof payload?.[field] === "string") clean[field] = payload[field];
  }
  if (payload?.config && typeof payload.config === "object" && !Array.isArray(payload.config)) {
    clean.config = {
      model: payload.config.model,
      effort: payload.config.effort,
      access: payload.config.access,
      ...(payload.config.approval ? { approval: payload.config.approval } : {}),
    };
  }
  for (const field of ["contextResumed", "contextSaved", "exactRelayArmed"]) {
    if (typeof payload?.[field] === "boolean") clean[field] = payload[field];
  }
  for (const field of ["error", "contextPersistenceError", "requestStateError"]) {
    if (typeof payload?.[field] === "string") {
      clean[field] = payload[field].slice(0, MAX_PROGRAMMATIC_ERROR_CHARS);
    }
  }
  return clean;
}

/** Persist only small terminal metadata. The runner's existing job artifact
 * remains the source of the potentially large raw model output. */
export function finishProgrammaticDispatch(cwd, requestKey, payload, now = Date.now()) {
  if (typeof requestKey !== "string" || !PROGRAMMATIC_KEY_PATTERN.test(requestKey)) {
    throw new Error("invalid programmatic request key");
  }
  const projectRoot = configureProjectStateRoot(cwd);
  const terminal = programmaticTerminalMetadata(payload);
  let finished = null;
  updateState(projectRoot, (state) => {
    let requests = normalizeProgrammaticRequests(
      state.config.programmaticDispatches,
      now,
    );
    state.config.programmaticDispatches = requests;
    const request = requests[requestKey];
    if (!request || request.requestKey !== requestKey) return;
    if (["completed", "failed", "stalled"].includes(request.status)) {
      finished = request;
      return;
    }
    if (request.status !== "claimed") return;
    finished = {
      ...request,
      status: terminal.status,
      terminal,
      completedAt: nowIso(now),
      completedAtMs: now,
      updatedAt: nowIso(now),
      updatedAtMs: now,
    };
    requests[requestKey] = finished;
    requests = normalizeProgrammaticRequests(requests, now);
    state.config.programmaticDispatches = requests;
    finished = requests[requestKey] ?? finished;
  });
  if (!finished) throw new Error("programmatic dispatch request is missing or was not claimed");
  return finished;
}

export const CLAUDE_RELAY_ATTRIBUTION = "回答来自Claude。";

/** Preserve Claude's raw answer byte-for-byte, then place the fixed attribution
 * on the next line. Reuse an existing trailing newline so the relay never adds
 * an unintended blank line after Claude's output. */
export function attributedClaudeResponse(rawOutput) {
  if (typeof rawOutput !== "string") {
    throw new Error("Claude raw output is required for attributed response relay");
  }
  const separator = rawOutput === "" || rawOutput.endsWith("\n") ? "" : "\n";
  return `${rawOutput}${separator}${CLAUDE_RELAY_ATTRIBUTION}`;
}

/** Arm a one-shot byte-for-byte relay guard for a completed Codex → Claude
 * dispatch. Claude's raw answer stays in the scope-owned centralized state
 * and expires if the host turn is abandoned before Codex reaches Stop. */
export function recordExactClaudeResponse(cwd, payload, now = Date.now()) {
  if (payload.host !== "codex" || payload.target !== "claude") {
    throw new Error("exact response relay only supports codex -> claude");
  }
  if (typeof payload.hostSessionId !== "string" || !payload.hostSessionId) {
    throw new Error("host session id is required for exact response relay");
  }
  if (typeof payload.rawOutput !== "string") {
    throw new Error("Claude raw output is required for exact response relay");
  }
  const projectRoot = configureProjectStateRoot(cwd);
  const key = sessionKey(payload.host, payload.hostSessionId);
  const response = {
    schema: 1,
    host: payload.host,
    target: payload.target,
    hostSessionId: payload.hostSessionId,
    hostTurnId: typeof payload.hostTurnId === "string" ? payload.hostTurnId : null,
    jobId: typeof payload.jobId === "string" ? payload.jobId : null,
    rawOutput: payload.rawOutput,
    createdAt: nowIso(now),
    createdAtMs: now,
    expiresAt: nowIso(now + EXACT_RESPONSE_TTL_MS),
    expiresAtMs: now + EXACT_RESPONSE_TTL_MS,
    mismatchCount: 0,
  };
  updateState(projectRoot, (state) => {
    state.config.exactClaudeResponses = pruneExactResponses({
      ...(state.config.exactClaudeResponses ?? {}),
      [key]: response,
    }, now);
  });
  return response;
}

/** Compare Codex's proposed final answer with Claude's unmodified result plus
 * the fixed attribution line. A match consumes the guard; a mismatch leaves it
 * armed so a Stop-hook continuation can try again. */
export function verifyExactClaudeResponse(cwd, payload, now = Date.now()) {
  if (typeof payload.sessionId !== "string" || !payload.sessionId) {
    return { status: "none" };
  }
  const projectRoot = configureProjectStateRoot(cwd);
  const key = sessionKey("codex", payload.sessionId);
  if (!getConfig(projectRoot).exactClaudeResponses?.[key]) return { status: "none" };
  let result = { status: "none" };
  updateState(projectRoot, (state) => {
    const responses = pruneExactResponses(state.config.exactClaudeResponses, now);
    const expected = responses[key];
    if (!expected) {
      state.config.exactClaudeResponses = responses;
      return;
    }
    const requiredResponse = attributedClaudeResponse(expected.rawOutput);
    if (payload.lastAssistantMessage === requiredResponse) {
      delete responses[key];
      state.config.exactClaudeResponses = responses;
      result = { status: "matched", jobId: expected.jobId };
      return;
    }
    responses[key] = {
      ...expected,
      mismatchCount: Number(expected.mismatchCount ?? 0) + 1,
    };
    state.config.exactClaudeResponses = responses;
    result = {
      status: "mismatch",
      expected: requiredResponse,
      jobId: expected.jobId,
      mismatchCount: responses[key].mismatchCount,
    };
  });
  return result;
}

export function recordDispatchConversation(cwd, payload, now = Date.now()) {
  if (!/^(codex|claude)$/.test(payload.host) || !/^(codex|claude)$/.test(payload.target)) {
    throw new Error("dispatch conversation host and target are required");
  }
  if (payload.host === payload.target) throw new Error("dispatch conversation cannot target its host");
  if (typeof payload.hostSessionId !== "string" || !payload.hostSessionId) {
    throw new Error("host session id is required for dispatch conversation");
  }
  if (!THREAD_ID_PATTERN.test(payload.threadId ?? "")) {
    throw new Error("target thread id is invalid");
  }
  if (typeof payload.prompt !== "string" || typeof payload.rawOutput !== "string") {
    throw new Error("dispatch conversation prompt and output are required");
  }
  const projectRoot = configureProjectStateRoot(cwd);
  const key = conversationKey(payload.host, payload.target, payload.hostSessionId);
  updateState(projectRoot, (state) => {
    const previous = state.config.dispatchConversations?.[key];
    const previousTurns = (
      previous
      && previous.host === payload.host
      && previous.target === payload.target
      && previous.hostSessionId === payload.hostSessionId
      && sameDispatchConfig(previous.config, payload.config)
    ) ? normalizeConversationTurns(previous.turns) : [];
    const turns = normalizeConversationTurns([
      ...previousTurns,
      { prompt: payload.prompt, output: payload.rawOutput },
    ]);
    const bindings = {
      ...(state.config.dispatchConversations ?? {}),
      [key]: {
        schema: 2,
        host: payload.host,
        target: payload.target,
        hostSessionId: payload.hostSessionId,
        threadId: payload.threadId,
        config: payload.config,
        turns,
        usedAt: nowIso(now),
        usedAtMs: now,
      },
    };
    state.config.dispatchConversations = pruneConversationBindings(bindings);
  });
}

export function claimDispatchTicket(cwd, token, now = Date.now(), prompt = null) {
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) {
    throw new Error("invalid dispatch ticket");
  }
  const projectRoot = configureProjectStateRoot(cwd);
  let claimed = null;
  let claimError = null;
  updateState(projectRoot, (state) => {
    state.config.programmaticDispatches = normalizeProgrammaticRequests(
      state.config.programmaticDispatches,
      now,
    );
    const tickets = { ...(state.config.dispatchTickets ?? {}) };
    const ticket = tickets[token];
    if (!ticket) return;
    if (ticket.projectRoot !== projectRoot || Number(ticket.expiresAtMs) <= now) {
      delete tickets[token];
      state.config.dispatchTickets = pruneTickets(tickets, now);
      return;
    }
    if (ticket.programmaticRequestKey) {
      const actualPromptHash = typeof prompt === "string"
        ? createHash("sha256").update(prompt).digest("hex")
        : null;
      if (!/^[a-f0-9]{64}$/.test(ticket.promptHash ?? "") || actualPromptHash !== ticket.promptHash) {
        state.config.dispatchTickets = pruneTickets(tickets, now);
        claimError = "dispatch ticket task does not match its programmatic request";
        return;
      }
      const requests = { ...(state.config.programmaticDispatches ?? {}) };
      const request = requests[ticket.programmaticRequestKey];
      if (
        !request
        || request.requestKey !== ticket.programmaticRequestKey
        || request.ticketToken !== token
        || request.status !== "prepared"
      ) {
        delete tickets[token];
        state.config.dispatchTickets = pruneTickets(tickets, now);
        return;
      }
      requests[ticket.programmaticRequestKey] = {
        ...request,
        status: "claimed",
        claimedAt: nowIso(now),
        claimedAtMs: now,
        updatedAt: nowIso(now),
        updatedAtMs: now,
      };
      state.config.programmaticDispatches = requests;
    }
    delete tickets[token];
    state.config.dispatchTickets = pruneTickets(tickets, now);
    claimed = ticket;
  });
  if (claimError) throw new Error(claimError);
  if (!claimed) throw new Error("dispatch ticket is missing, expired, or already used");
  return claimed;
}

export function recentDispatchRecord(cwd, target) {
  const projectRoot = configureProjectStateRoot(cwd);
  return readRecentDispatchRecord(getConfig(projectRoot), target);
}

export function recordRecentDispatch(cwd, target, config, usedAt = new Date().toISOString()) {
  const projectRoot = configureProjectStateRoot(cwd);
  updateState(projectRoot, (state) => {
    const next = withRecentDispatch(state.config, target, config, usedAt);
    state.config.recentDispatch = next.recentDispatch;
  });
}
