import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { getConfig, updateState } from "./state.mjs";
import { readRecentDispatchRecord, withRecentDispatch } from "./dispatch-config.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

export const PENDING_TTL_MS = 30 * 60 * 1000;
export const TICKET_TTL_MS = 15 * 60 * 1000;
const TOKEN_PATTERN = /^[a-f0-9]{32}$/;

function assertRealDirectory(directory, label) {
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stat) {
    fs.mkdirSync(directory, { mode: 0o700 });
    return;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`cc-suite: refusing ${label} because it is not a real directory: ${directory}`);
  }
  if ((stat.mode & 0o077) !== 0) {
    try { fs.chmodSync(directory, 0o700); } catch {}
  }
}

export function configureProjectStateRoot(cwd) {
  const root = fs.realpathSync.native(resolveWorkspaceRoot(cwd));
  const base = path.join(root, ".cc-suite");
  const marker = path.join(base, "project.json");
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(marker, "utf8")); } catch {}
  if (parsed?.managedBy !== "cc-suite") {
    throw new Error(`cc-suite project marker is missing at ${marker}`);
  }
  assertRealDirectory(base, "project state root");
  const runtime = path.join(base, "runtime");
  assertRealDirectory(runtime, "runtime state root");
  process.env.CLAUDE_PLUGIN_DATA = runtime;
  return root;
}

function sessionKey(host, sessionId) {
  if (!/^(codex|claude)$/.test(host)) throw new Error(`unsupported host: ${host}`);
  if (typeof sessionId !== "string" || !sessionId.trim()) throw new Error("hook session_id is required");
  return `${host}-${createHash("sha256").update(sessionId).digest("hex").slice(0, 24)}`;
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
export function ticketForSubmittedPrompt(cwd, { host, sessionId, prompt }, now = Date.now()) {
  if (isControlPrompt(prompt)) return { status: "control" };
  const projectRoot = configureProjectStateRoot(cwd);
  const key = sessionKey(host, sessionId);
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
    const token = randomBytes(16).toString("hex");
    const ticket = {
      schema: 1,
      token,
      host,
      target: pending.target,
      sessionId,
      projectRoot,
      selectedCwd: pending.cwd,
      config: pending.config,
      selectedProfile: pending.selectedProfile,
      selectedAt: pending.createdAt,
      createdAt: nowIso(now),
      createdAtMs: now,
      expiresAt: nowIso(now + TICKET_TTL_MS),
      expiresAtMs: now + TICKET_TTL_MS,
    };
    state.config.dispatchTickets = {
      ...pruneTickets(state.config.dispatchTickets, now),
      [token]: ticket,
    };
    result = { status: "ready", ticket };
  });
  return result;
}

export function claimDispatchTicket(cwd, token, now = Date.now()) {
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) {
    throw new Error("invalid dispatch ticket");
  }
  const projectRoot = configureProjectStateRoot(cwd);
  let claimed = null;
  updateState(projectRoot, (state) => {
    const tickets = { ...(state.config.dispatchTickets ?? {}) };
    const ticket = tickets[token];
    delete tickets[token];
    state.config.dispatchTickets = pruneTickets(tickets, now);
    if (!ticket) return;
    if (ticket.projectRoot !== projectRoot || Number(ticket.expiresAtMs) <= now) return;
    claimed = ticket;
  });
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
