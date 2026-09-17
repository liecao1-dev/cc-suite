import process from "node:process";
import { spawnSync } from "node:child_process";

const KEYCHAIN_SERVICE = "Claude Code-credentials";
const DEFAULT_SECURITY_BINARY = "/usr/bin/security";
export const CLAUDE_ENVIRONMENT_AUTH_KEYS = Object.freeze([
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
]);

// Keep enough headroom to reject a login that cannot be refreshed before a
// selected 60-minute task starts. The current Claude CLI remains the sole
// owner of refresh-token exchange and Keychain writeback.
export const CLAUDE_OAUTH_MIN_VALIDITY_MS = 75 * 60 * 1000;

function command(commandName, args, options = {}) {
  return spawnSync(commandName, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: options.env,
  });
}

function readKeychainCredentials({ securityBinary, env }) {
  const result = command(securityBinary, [
    "find-generic-password",
    "-w",
    "-s",
    KEYCHAIN_SERVICE,
  ], { env });
  if (result.error || result.status !== 0 || result.signal) {
    throw new Error("无法读取现有 Claude Code 钥匙串凭据");
  }
  let payload;
  try {
    payload = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error("Claude Code 钥匙串凭据格式无效");
  }
  const oauth = payload?.claudeAiOauth;
  if (!oauth || typeof oauth !== "object") {
    throw new Error("Claude Code 钥匙串中没有订阅 OAuth 凭据");
  }
  return oauth;
}

function timestamp(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function validScopes(oauth) {
  if (!Array.isArray(oauth?.scopes)) return [];
  return oauth.scopes.filter((scope) => (
    typeof scope === "string" && /^[A-Za-z0-9:_-]+$/.test(scope)
  ));
}

/**
 * Delegated Claude calls deliberately use the same subscription login as the
 * native CLI. A long-lived host can retain an obsolete environment token after
 * Keychain has been refreshed; never let that snapshot override the current
 * Keychain credential in a newly spawned target process.
 */
export function withoutClaudeEnvironmentAuth(env = process.env) {
  const clean = { ...env };
  for (const key of CLAUDE_ENVIRONMENT_AUTH_KEYS) delete clean[key];
  return clean;
}

/**
 * Inspect the login that the current Claude CLI will use without rotating it.
 *
 * Claude subscription refresh tokens rotate. Exchanging one from this helper
 * can invalidate the in-memory copy held by an already-running Claude session,
 * while that session can likewise invalidate a copy read here. A cc-suite-only
 * lock cannot coordinate with those native processes, so the composer must not
 * exchange or write shared credentials. The delegated Claude process performs
 * its own native refresh when the task is actually started.
 */
export function ensureClaudeOAuthFresh(options) {
  const now = options.now ?? Date.now;
  const baseEnv = { ...(options.env ?? process.env) };
  const platform = options.platform ?? process.platform;
  const minValidityMs = options.minValidityMs ?? CLAUDE_OAUTH_MIN_VALIDITY_MS;
  const securityBinary = options.securityBinary ?? DEFAULT_SECURITY_BINARY;

  if (platform !== "darwin") {
    return { status: "skipped", source: "non-macos", refreshOwner: "claude-cli" };
  }

  const oauth = readKeychainCredentials({ securityBinary, env: baseEnv });
  const expiresAt = timestamp(oauth.expiresAt);
  const refreshTokenExpiresAt = timestamp(oauth.refreshTokenExpiresAt);
  const accessReady = typeof oauth.accessToken === "string" && Boolean(oauth.accessToken);
  const refreshReady = (
    typeof oauth.refreshToken === "string"
    && Boolean(oauth.refreshToken)
    && validScopes(oauth).length > 0
  );

  if (!accessReady) {
    throw new Error("现有 Claude 登录缺少 access token，需要重新授权一次");
  }
  const refreshNeeded = expiresAt <= now() + minValidityMs;
  if (refreshNeeded && !refreshReady) {
    throw new Error("现有 Claude 登录无法由 Claude CLI 自动刷新，需要重新授权一次");
  }
  if (refreshNeeded && refreshTokenExpiresAt && refreshTokenExpiresAt <= now()) {
    throw new Error("Claude refresh token 已到绝对有效期，需要重新授权一次");
  }

  return {
    status: "ready",
    source: "keychain",
    expiresAt,
    refreshTokenExpiresAt: refreshTokenExpiresAt || null,
    refreshNeeded,
    refreshOwner: "claude-cli",
  };
}
