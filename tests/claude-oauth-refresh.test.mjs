import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  CLAUDE_OAUTH_MIN_VALIDITY_MS,
  ensureClaudeOAuthFresh,
  withoutClaudeEnvironmentAuth,
} from "../scripts/lib/claude-oauth-refresh.mjs";

const NOW = Date.parse("2026-08-26T12:00:00.000Z");

test("OAuth preflight requires the 60-minute task window plus refresh headroom", () => {
  assert.equal(CLAUDE_OAUTH_MIN_VALIDITY_MS, 4_500_000);
});

function executable(file, source) {
  fs.writeFileSync(file, source, { mode: 0o700 });
  fs.chmodSync(file, 0o700);
}

function fixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-suite-oauth-preflight-"));
  const credentialFile = path.join(root, "credential.json");
  const securityBinary = path.join(root, "security");
  const credential = {
    claudeAiOauth: {
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      expiresAt: NOW + 8 * 60 * 60 * 1000,
      refreshTokenExpiresAt: NOW + 30 * 24 * 60 * 60 * 1000,
      scopes: ["user:inference", "user:profile"],
      ...overrides,
    },
  };
  fs.writeFileSync(credentialFile, JSON.stringify(credential));
  executable(securityBinary, `#!/bin/sh\nexec /bin/cat "$FAKE_CLAUDE_CREDENTIALS"\n`);
  return {
    root,
    credentialFile,
    securityBinary,
    env: { ...process.env, FAKE_CLAUDE_CREDENTIALS: credentialFile },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function preflight(item) {
  return ensureClaudeOAuthFresh({
    scopeRoot: item.root,
    platform: "darwin",
    securityBinary: item.securityBinary,
    env: item.env,
    now: () => NOW,
  });
}

test("a sufficiently fresh Claude access token is reported without mutation", () => {
  const item = fixture({ expiresAt: NOW + CLAUDE_OAUTH_MIN_VALIDITY_MS + 1 });
  try {
    const before = fs.readFileSync(item.credentialFile, "utf8");
    const result = preflight(item);
    assert.equal(result.status, "ready");
    assert.equal(result.refreshNeeded, false);
    assert.equal(result.refreshOwner, "claude-cli");
    assert.equal(fs.readFileSync(item.credentialFile, "utf8"), before);
    assert.doesNotMatch(JSON.stringify(result), /access-secret|refresh-secret/);
  } finally {
    item.cleanup();
  }
});

test("an expired access token is left for the current Claude CLI to refresh", () => {
  const item = fixture({ expiresAt: NOW - 1 });
  try {
    const before = fs.readFileSync(item.credentialFile, "utf8");
    const first = preflight(item);
    const second = preflight(item);
    assert.equal(first.status, "ready");
    assert.equal(first.refreshNeeded, true);
    assert.equal(first.refreshOwner, "claude-cli");
    assert.deepEqual(second, first);
    assert.equal(fs.readFileSync(item.credentialFile, "utf8"), before);
  } finally {
    item.cleanup();
  }
});

test("a near-expiry access token without native refresh material fails closed", () => {
  const item = fixture({
    expiresAt: NOW + 1,
    refreshToken: "",
    scopes: [],
  });
  try {
    assert.throws(() => preflight(item), /无法由 Claude CLI 自动刷新/);
  } finally {
    item.cleanup();
  }
});

test("an absolutely expired refresh token fails closed without changing credentials", () => {
  const item = fixture({ expiresAt: NOW - 1, refreshTokenExpiresAt: NOW - 1 });
  try {
    const before = fs.readFileSync(item.credentialFile, "utf8");
    assert.throws(() => preflight(item), /绝对有效期/);
    assert.equal(fs.readFileSync(item.credentialFile, "utf8"), before);
  } finally {
    item.cleanup();
  }
});

test("stale environment credentials neither bypass Keychain preflight nor survive target sanitization", () => {
  const item = fixture();
  try {
    Object.assign(item.env, {
      CLAUDE_CODE_OAUTH_TOKEN: "stale-oauth",
      ANTHROPIC_AUTH_TOKEN: "stale-auth",
      ANTHROPIC_API_KEY: "stale-key",
      KEEP_ME: "yes",
    });
    assert.equal(preflight(item).source, "keychain");
    const clean = withoutClaudeEnvironmentAuth(item.env);
    assert.equal(clean.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(clean.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(clean.ANTHROPIC_API_KEY, undefined);
    assert.equal(clean.KEEP_ME, "yes");
  } finally {
    item.cleanup();
  }
});
