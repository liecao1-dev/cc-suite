import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { installProjectDispatch } from "../scripts/lib/project-dispatch.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const PROXY = path.join(ROOT, "scripts", "composer-proxy.py");

function probe(host, chunks) {
  const result = spawnSync("python3", [PROXY, "--probe-input"], {
    cwd: ROOT,
    input: JSON.stringify({ host, chunks }),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function probeCwd(host, cwd, argv) {
  const result = spawnSync("python3", [PROXY, "--probe-cwd"], {
    cwd: ROOT,
    input: JSON.stringify({ host, cwd, argv }),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).workspace;
}

function probeMode(mode, payload) {
  const result = spawnSync("python3", [PROXY, mode], {
    cwd: ROOT,
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("selecting exact $claude consumes Enter before Codex can submit it", () => {
  assert.deepEqual(probe("codex", ["$claude", "\r"]), {
    forwarded: ["$claude", ""],
    triggers: 1,
    buffer: "",
  });
});

test("Codex plugin-qualified $cc-suite:claude remains a local selector", () => {
  assert.deepEqual(probe("codex", ["$cc-suite:claude", "\r"]), {
    forwarded: ["$cc-suite:claude", ""],
    triggers: 1,
    buffer: "",
  });
});

test("plugin-qualified selector follows the source manifest instead of a Codex version", () => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cc-suite-plugin-name-"));
  try {
    fs.mkdirSync(path.join(sourceRoot, ".codex-plugin"));
    fs.writeFileSync(
      path.join(sourceRoot, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "renamed-suite" }),
    );
    assert.equal(probeMode("--probe-input", {
      host: "codex",
      sourceRoot,
      chunks: ["$renamed-suite:claude", "\r"],
    }).triggers, 1);
    assert.equal(probeMode("--probe-input", {
      host: "codex",
      sourceRoot,
      chunks: ["$cc-suite:claude", "\r"],
    }).triggers, 0);
  } finally {
    fs.rmSync(sourceRoot, { recursive: true, force: true });
  }
});

test("selecting exact /codex with Tab opens configuration before Claude submits it", () => {
  assert.deepEqual(probe("claude", ["/codex", "\t"]), {
    forwarded: ["/codex", ""],
    triggers: 1,
    buffer: "",
  });
});

test("workflow sync and combined task text are never mistaken for the exact selector", () => {
  assert.equal(probe("codex", ["$claude-workflow-sync", "\r"]).triggers, 0);
  assert.equal(probe("codex", ["$claude do work", "\r"]).triggers, 0);
  assert.equal(probe("codex", ["$cc-suite:claude do work", "\r"]).triggers, 0);
  assert.equal(probe("codex", ["$cc-suite:claude-workflow-sync", "\r"]).triggers, 0);
  assert.equal(probe("codex", ["$other:claude", "\r"]).triggers, 0);
});

test("moving to another completion row does not open the dispatcher picker", () => {
  assert.equal(probe("codex", ["$claude", "\u001b[B", "\r"]).triggers, 0);
  assert.equal(probe("codex", ["$claude", "\u001b[B", "\u001b[A", "\r"]).triggers, 1);
  assert.equal(probe("codex", ["$claude", "\u001b[A", "\r"]).triggers, 0);
  assert.equal(probe("codex", ["$claude", "\u001b[A", "\u001b[B", "\r"]).triggers, 1);
  assert.equal(probe("codex", ["$cc-suite:claude", "\u001b[B", "\r"]).triggers, 0);
  assert.equal(
    probe("codex", ["$cc-suite:claude", "\u001b[B", "\u001b[A", "\r"]).triggers,
    1,
  );
  assert.equal(probe("claude", ["/codex", "\u001b[B", "\r"]).triggers, 0);
});

test("basic composer editing still resolves the exact pre-send selector", () => {
  assert.equal(probe("codex", ["$claudx", "\u007f", "e", "\r"]).triggers, 1);
  assert.equal(probe("claude", ["/codx", "\u007f", "ex", "\r"]).triggers, 1);
  assert.equal(probe("claude", ["/codex", "\u001b[B", "\u001b[A", "\r"]).triggers, 1);
});

test("ordinary task submission passes through untouched", () => {
  const result = probe("codex", ["请检查这个项目", "\r"]);
  assert.equal(result.triggers, 0);
  assert.equal(result.forwarded.join(""), "请检查这个项目\r");
  assert.equal(result.buffer, "");
});

test("selected Claude tuple becomes a visible prefix inside the Codex composer", () => {
  const state = probeMode("--probe-prefix", {
    host: "codex",
    result: {
      target: "claude",
      config: { model: "claude-opus-4-6", effort: "low", access: "default" },
      description: "claude-opus-4-6 · low · permission=default",
    },
    chunks: ["今天天气怎么样", "\r"],
  });
  const prefix = "[Claude · claude-opus-4-6 · low · permission=default] ";
  assert.equal(state.prefix, prefix);
  assert.equal(state.initial, prefix);
  assert.deepEqual(state.forwarded, [
    "今天天气怎么样",
    "\u0015今天天气怎么样\r",
  ]);
  assert.deepEqual(state.writePlans[1], ["\u0015今天天气怎么样", "\r"]);
  assert.deepEqual(state.submissions, ["今天天气怎么样"]);
  assert.equal(state.armed, false);
  assert.equal(state.visible, false);
});

test("selected Codex tuple becomes the same protected prefix inside Claude Code", () => {
  const state = probeMode("--probe-prefix", {
    host: "claude",
    result: {
      target: "codex",
      description: "gpt-5.6-sol · high · workspace-write · on-request",
    },
    chunks: ["事实上，请检查这个项目", "\r"],
  });
  assert.equal(
    state.initial,
    "[Codex · gpt-5.6-sol · high · workspace-write · on-request] ",
  );
  assert.equal(state.forwarded[1], "\u0015事实上，请检查这个项目\r");
  assert.deepEqual(state.submissions, ["事实上，请检查这个项目"]);
});

test("composer prefix is protected while Unicode task editing remains exact", () => {
  const state = probeMode("--probe-prefix", {
    host: "codex",
    result: {
      target: "claude",
      description: "claude-opus-4-6 · low · permission=default",
    },
    chunks: ["\u007f", "\u001b[D", "事实", "\u007f", "\r"],
  });
  assert.equal(state.forwarded[0], "");
  assert.equal(state.forwarded[1], "");
  assert.equal(state.forwarded[2], "事实");
  assert.equal(state.forwarded[3], "\u007f");
  assert.equal(state.forwarded[4], "\u0015事\r");
  assert.deepEqual(state.submissions, ["事"]);
});

test("native control commands temporarily hide but do not consume the prefix", () => {
  const state = probeMode("--probe-prefix", {
    host: "codex",
    result: {
      target: "claude",
      description: "claude-opus-4-6 · low · permission=default",
    },
    chunks: ["/model", "\r", "事实上", "\r"],
  });
  const prefix = "[Claude · claude-opus-4-6 · low · permission=default] ";
  assert.equal(state.forwarded[0], "\u0015/model");
  assert.equal(state.forwarded[1], "\u0015/model\r");
  assert.deepEqual(state.writePlans[1], ["\u0015/model", "\r"]);
  assert.equal(state.forwarded[2], `${prefix}事实上`);
  assert.equal(state.forwarded[3], "\u0015事实上\r");
  assert.deepEqual(state.submissions, ["/model", "事实上"]);
  assert.equal(state.armed, false);
});

test("only an ordinary prompt consumes the visible pending selection", () => {
  assert.deepEqual(
    probeMode("--probe-control", {
      values: ["", "/model", "/review now", "$another-skill", "今天天气怎么样"],
    }),
    [true, true, true, true, false],
  );
});

test("non-Git workspaces use their active directory without project markers", () => {
  const scope = fs.mkdtempSync(path.join(os.tmpdir(), "cc-suite-proxy-root-"));
  try {
    fs.mkdirSync(path.join(scope, ".cc-suite"));
    fs.writeFileSync(
      path.join(scope, ".cc-suite", "project.json"),
      JSON.stringify({ schema: 1, managedBy: "cc-suite" }),
    );
    const workspace = path.join(scope, "documents", "research");
    fs.mkdirSync(workspace, { recursive: true });
    assert.equal(
      probeMode("--probe-project-root", { scope, cwd: workspace }).root,
      fs.realpathSync(workspace),
    );

    const project = path.join(scope, "managed-project");
    const child = path.join(project, "nested");
    fs.mkdirSync(path.join(project, ".cc-suite"), { recursive: true });
    fs.mkdirSync(child);
    fs.writeFileSync(
      path.join(project, ".cc-suite", "project.json"),
      JSON.stringify({ schema: 1, managedBy: "cc-suite" }),
    );
    assert.equal(
      probeMode("--probe-project-root", { scope, cwd: child }).root,
      fs.realpathSync(child),
    );
  } finally {
    fs.rmSync(scope, { recursive: true, force: true });
  }
});

test("a freshly installed selector is immediately recognized as ready", () => {
  const scope = fs.mkdtempSync(path.join(os.tmpdir(), "cc-suite-proxy-ready-"));
  const workspace = path.join(scope, "non-git-workspace");
  try {
    fs.mkdirSync(workspace);
    const result = installProjectDispatch({
      root: workspace,
      scopeRoot: scope,
      sourceRoot: ROOT,
      catalog: null,
    });
    assert.deepEqual(result.conflicts, []);
    assert.equal(probeMode("--probe-workspace-ready", {
      projectRoot: workspace,
      sourceRoot: ROOT,
    }).ready, true);

    fs.appendFileSync(path.join(workspace, ".claude", "skills", "codex", "SKILL.md"), "changed\n");
    assert.equal(probeMode("--probe-workspace-ready", {
      projectRoot: workspace,
      sourceRoot: ROOT,
    }).ready, false);
  } finally {
    fs.rmSync(scope, { recursive: true, force: true });
  }
});

test("in-scope interactive hosts receive only the centralized runtime as an extra writable directory", () => {
  const scope = fs.mkdtempSync(path.join(os.tmpdir(), "cc-suite-proxy-runtime-"));
  try {
    const runtime = path.join(scope, ".cc-suite", "runtime");
    fs.mkdirSync(runtime, { recursive: true });
    assert.deepEqual(probeMode("--probe-runtime-argv", {
      scope,
      host: "claude",
      argv: ["--model", "gpt-5.6-sol"],
    }).argv, ["--model", "gpt-5.6-sol", "--add-dir", fs.realpathSync(runtime)]);
    assert.deepEqual(probeMode("--probe-runtime-argv", {
      scope,
      host: "claude",
      argv: ["--", "literal prompt"],
    }).argv, ["--add-dir", fs.realpathSync(runtime), "--", "literal prompt"]);
    assert.deepEqual(probeMode("--probe-runtime-argv", {
      scope,
      host: "codex",
      argv: ["--add-dir", runtime],
    }).argv, ["--add-dir", runtime]);
    assert.deepEqual(probeMode("--probe-runtime-argv", {
      scope,
      host: "codex",
      argv: ["exec", "resume", "thread-id", "-"],
    }).argv, ["--add-dir", fs.realpathSync(runtime), "exec", "resume", "thread-id", "-"]);
  } finally {
    fs.rmSync(scope, { recursive: true, force: true });
  }
});

test("an expired access token with native refresh material is left for the real inference call", () => {
  const scope = fs.mkdtempSync(path.join(os.tmpdir(), "cc-suite-proxy-oauth-preflight-"));
  try {
    fs.mkdirSync(path.join(scope, ".cc-suite", "runtime"), { recursive: true });
    const credentialFile = path.join(scope, "credentials.json");
    fs.writeFileSync(credentialFile, JSON.stringify({
      claudeAiOauth: {
        accessToken: "access-before",
        refreshToken: "refresh-before",
        expiresAt: Date.now() - 1,
        refreshTokenExpiresAt: Date.now() + 86_400_000,
        scopes: ["user:inference"],
      },
    }));
    const statusScript = path.join(scope, "status.mjs");
    fs.writeFileSync(statusScript, [
      "import fs from 'node:fs';",
      "const oauth = JSON.parse(fs.readFileSync(process.env.FAKE_CLAUDE_CREDENTIALS, 'utf8')).claudeAiOauth;",
      "console.log(JSON.stringify({status:'ready', source:'keychain', refreshNeeded: oauth.expiresAt <= Date.now() + 4500000}));",
      "",
    ].join("\n"));
    const before = fs.readFileSync(credentialFile, "utf8");
    const completed = spawnSync("python3", [PROXY, "--probe-oauth-preflight"], {
      cwd: ROOT,
      input: JSON.stringify({
        scope,
        sourceRoot: ROOT,
        statusCommand: [process.execPath, statusScript],
      }),
      env: { ...process.env, FAKE_CLAUDE_CREDENTIALS: credentialFile },
      encoding: "utf8",
      timeout: 25_000,
    });
    assert.equal(completed.status, 0, completed.stderr);
    assert.deepEqual(JSON.parse(completed.stdout), {
      error: null,
      statusError: null,
      refreshNeeded: true,
    });
    assert.equal(fs.readFileSync(credentialFile, "utf8"), before);
  } finally {
    fs.rmSync(scope, { recursive: true, force: true });
  }
});

test("Claude to Codex selection never depends on Claude OAuth refresh state", () => {
  const scope = fs.mkdtempSync(path.join(os.tmpdir(), "cc-suite-proxy-target-auth-"));
  try {
    const failedStatus = [process.execPath, "--eval", "process.exit(1)"];
    assert.equal(probeMode("--probe-selection-auth", {
      host: "claude",
      scope,
      sourceRoot: ROOT,
      statusCommand: failedStatus,
    }).error, null);
    assert.match(probeMode("--probe-selection-auth", {
      host: "codex",
      scope,
      sourceRoot: ROOT,
      statusCommand: failedStatus,
    }).error, /登录预检查/);
  } finally {
    fs.rmSync(scope, { recursive: true, force: true });
  }
});

test("only in-scope noninteractive Claude print calls use the OAuth gate", () => {
  // Keep the Unix-socket pathname below macOS's sockaddr_un limit. The real
  // configured scope is short, while os.tmpdir() inside the app is not.
  const fixture = fs.mkdtempSync(path.join("/tmp", "ccp-"));
  const scope = path.join(fixture, "scope");
  const workspace = path.join(scope, "workflow");
  const outside = path.join(fixture, "outside");
  const marker = path.join(fixture, "oauth-checked");
  try {
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(path.join(scope, ".cc-suite", "runtime"), { recursive: true });
    fs.mkdirSync(outside);
    const fakeNode = path.join(fixture, "node");
    fs.writeFileSync(fakeNode, [
      "#!/bin/sh",
      'if [ "$1" = "$CC_SUITE_TEST_OAUTH_HELPER" ]; then',
      '  : > "$CC_SUITE_TEST_OAUTH_MARKER"',
      "  printf '%s\\n' '{\"status\":\"ready\",\"source\":\"test\",\"refreshNeeded\":true}'",
      "  exit 0",
      "fi",
      'exec "$CC_SUITE_TEST_REAL_NODE" "$@"',
      "",
    ].join("\n"), { mode: 0o755 });
    const fakeClaude = path.join(fixture, "claude-real");
    fs.writeFileSync(fakeClaude, [
      "#!/bin/sh",
      "printf 'cwd=%s\\n' \"$PWD\"",
      "for value in \"$@\"; do printf 'arg=%s\\n' \"$value\"; done",
      "/bin/cat",
      "",
    ].join("\n"), { mode: 0o755 });
    const baseArgs = [
      PROXY,
      "--host", "claude",
      "--scope", scope,
      "--source", ROOT,
      "--real-binary", fakeClaude,
      "--",
    ];
    const env = {
      ...process.env,
      PATH: `${fixture}${path.delimiter}${process.env.PATH}`,
      CC_SUITE_TEST_OAUTH_MARKER: marker,
      CC_SUITE_TEST_OAUTH_HELPER: path.join(ROOT, "scripts", "claude-oauth-refresh.mjs"),
      CC_SUITE_TEST_REAL_NODE: process.execPath,
    };

    const printCall = spawnSync("python3", [...baseArgs, "--print", "literal prompt"], {
      cwd: workspace,
      input: "stdin payload\n",
      env,
      encoding: "utf8",
    });
    assert.equal(printCall.status, 0, printCall.stderr);
    assert.equal(fs.existsSync(marker), true);
    assert.equal(printCall.stdout, [
      `cwd=${fs.realpathSync(workspace)}`,
      "arg=--print",
      "arg=literal prompt",
      "arg=--add-dir",
      `arg=${fs.realpathSync(path.join(scope, ".cc-suite", "runtime"))}`,
      "stdin payload",
      "",
    ].join("\n"));

    fs.rmSync(marker);
    const nonPrintCall = spawnSync("python3", [...baseArgs, "--version"], {
      cwd: workspace,
      env,
      encoding: "utf8",
    });
    assert.equal(nonPrintCall.status, 0, nonPrintCall.stderr);
    assert.equal(fs.existsSync(marker), false);

    const outsidePrintCall = spawnSync("python3", [...baseArgs, "-p", "outside"], {
      cwd: outside,
      env,
      encoding: "utf8",
    });
    assert.equal(outsidePrintCall.status, 0, outsidePrintCall.stderr);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("nested opposite-model inference enters the unified adapter in both directions", () => {
  const fixture = fs.mkdtempSync(path.join("/tmp", "ccn-"));
  const scope = path.join(fixture, "scope");
  const workspace = path.join(scope, "workspace");
  const child = path.join(workspace, "child");
  const source = path.join(fixture, "source");
  const capture = path.join(fixture, "capture.json");
  const realBinaryMarker = path.join(fixture, "real-binary-ran");
  try {
    fs.mkdirSync(child, { recursive: true });
    fs.mkdirSync(path.join(source, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(source, "scripts", "direct-inference-request.mjs"), [
      "import fs from 'node:fs';",
      "const argv = process.argv.slice(2);",
      "const stdin = fs.readFileSync(0, 'utf8');",
      "fs.writeFileSync(process.env.CC_SUITE_TEST_CAPTURE, JSON.stringify({",
      "  argv, stdin, cwd: process.cwd(), workspace: process.env.CC_SUITE_WORKSPACE_ROOT,",
      "}));",
      "process.stdout.write(JSON.stringify({status:'completed', rawOutput:`  raw:${argv[1]}:${stdin}  \\n\\n`}) + '\\n');",
      "",
    ].join("\n"));
    const fakeRealBinary = path.join(fixture, "real-target");
    fs.writeFileSync(fakeRealBinary, [
      "#!/bin/sh",
      ': > "$CC_SUITE_TEST_REAL_BINARY_MARKER"',
      "exit 99",
      "",
    ].join("\n"), { mode: 0o755 });

    for (const scenario of [
      {
        parent: "codex",
        target: "claude",
        cwd: child,
        argv: ["--print", "delegated Claude task"],
        stdin: "claude stdin",
      },
      {
        parent: "claude",
        target: "codex",
        cwd: workspace,
        argv: ["-p", "workflow-profile", "exec", "-C", "child", "-"],
        stdin: "codex stdin",
      },
      {
        // Ambient host identity is not trusted. An existing broker session is
        // always used, and the broker decides whether the target is permitted.
        parent: "claude",
        target: "claude",
        cwd: child,
        argv: ["--print", "broker decides"],
        stdin: "forged host stdin",
      },
    ]) {
      fs.rmSync(capture, { force: true });
      fs.rmSync(realBinaryMarker, { force: true });
      const completed = spawnSync("python3", [
        PROXY,
        "--host", scenario.target,
        "--scope", scope,
        "--source", source,
        "--real-binary", fakeRealBinary,
        "--",
        ...scenario.argv,
      ], {
        cwd: scenario.cwd,
        input: scenario.stdin,
        env: {
          ...process.env,
          CC_SUITE_COMPOSER_BYPASS: "",
          CC_SUITE_COMPOSER_HOST: scenario.parent,
          CC_SUITE_COMPOSER_SESSION: "1".repeat(32),
          CC_SUITE_WORKSPACE_ROOT: workspace,
          CC_SUITE_DISPATCH_BROKER_SOCKET: path.join(fixture, "broker.sock"),
          CC_SUITE_DISPATCH_BROKER_SECRET: "a".repeat(64),
          CC_SUITE_TEST_CAPTURE: capture,
          CC_SUITE_TEST_REAL_BINARY_MARKER: realBinaryMarker,
        },
        encoding: "utf8",
      });
      assert.equal(completed.status, 0, completed.stderr);
      assert.equal(completed.stdout, `  raw:${scenario.target}:${scenario.stdin}  \n\n`);
      assert.equal(fs.existsSync(realBinaryMarker), false);
      const observed = JSON.parse(fs.readFileSync(capture, "utf8"));
      assert.deepEqual(observed.argv.slice(0, 2), ["--target", scenario.target]);
      assert.match(observed.argv[3], /^[a-f0-9]{32}$/);
      assert.deepEqual(observed.argv.slice(4), ["--", ...scenario.argv]);
      assert.equal(observed.stdin, scenario.stdin);
      assert.equal(observed.cwd, fs.realpathSync(scenario.cwd));
      assert.equal(observed.workspace, fs.realpathSync(workspace));
    }
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("nested programmatic busy state is reported without hiding the reason", () => {
  const fixture = fs.mkdtempSync(path.join("/tmp", "ccbsy-"));
  const scope = path.join(fixture, "scope");
  const workspace = path.join(scope, "workspace");
  const source = path.join(fixture, "source");
  try {
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(path.join(source, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(source, "scripts", "direct-inference-request.mjs"), [
      "process.stdout.write(JSON.stringify({",
      "  status: 'busy', reason: 'conversation-active', activeStatus: 'claimed', requestId: 'same-turn',",
      "}) + '\\n');",
      "process.exitCode = 1;",
      "",
    ].join("\n"));
    const fakeRealBinary = path.join(fixture, "real-target");
    fs.writeFileSync(fakeRealBinary, "#!/bin/sh\nexit 99\n", { mode: 0o755 });

    const completed = spawnSync("python3", [
      PROXY,
      "--host", "claude",
      "--scope", scope,
      "--source", source,
      "--real-binary", fakeRealBinary,
      "--",
      "--print", "second request",
    ], {
      cwd: workspace,
      input: "complete prompt",
      env: {
        ...process.env,
        CC_SUITE_COMPOSER_BYPASS: "",
        CC_SUITE_COMPOSER_HOST: "codex",
        CC_SUITE_COMPOSER_SESSION: "1".repeat(32),
        CC_SUITE_WORKSPACE_ROOT: workspace,
        CC_SUITE_DISPATCH_BROKER_SOCKET: path.join(fixture, "broker.sock"),
        CC_SUITE_DISPATCH_BROKER_SECRET: "a".repeat(64),
      },
      encoding: "utf8",
    });
    assert.equal(completed.status, 1);
    assert.match(completed.stderr, /请求忙：conversation-active/);
    assert.match(completed.stderr, /当前状态 claimed/);
    assert.doesNotMatch(completed.stderr, /统一入口退出 1/);
    assert.doesNotMatch(completed.stderr, /必须复用同一个 CC_SUITE_REQUEST_ID/);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("programmatic retry guidance distinguishes unknown, in-progress, and terminal OAuth failures", () => {
  const fixture = fs.mkdtempSync(path.join("/tmp", "ccretry-"));
  const scope = path.join(fixture, "scope");
  const workspace = path.join(scope, "workspace");
  const source = path.join(fixture, "source");
  try {
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(path.join(source, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(source, "scripts", "direct-inference-request.mjs"), [
      "const response = process.env.CC_SUITE_TEST_RESPONSE;",
      "if (response === 'invalid') process.stdout.write('not json\\n');",
      "else process.stdout.write(response + '\\n');",
      "process.exitCode = 1;",
      "",
    ].join("\n"));
    const fakeRealBinary = path.join(fixture, "real-target");
    fs.writeFileSync(fakeRealBinary, "#!/bin/sh\nexit 99\n", { mode: 0o755 });
    const base = {
      cwd: workspace,
      input: "complete prompt",
      encoding: "utf8",
    };
    const args = [
      PROXY,
      "--host", "claude",
      "--scope", scope,
      "--source", source,
      "--real-binary", fakeRealBinary,
      "--", "--print", "delegated task",
    ];
    const env = {
      ...process.env,
      CC_SUITE_COMPOSER_BYPASS: "",
      CC_SUITE_COMPOSER_HOST: "codex",
      CC_SUITE_COMPOSER_SESSION: "1".repeat(32),
      CC_SUITE_WORKSPACE_ROOT: workspace,
      CC_SUITE_DISPATCH_BROKER_SOCKET: path.join(fixture, "broker.sock"),
      CC_SUITE_DISPATCH_BROKER_SECRET: "a".repeat(64),
      CC_SUITE_REQUEST_ID: "stable-request",
    };

    const inProgress = spawnSync("python3", args, {
      ...base,
      env: {
        ...env,
        CC_SUITE_TEST_RESPONSE: JSON.stringify({
          status: "in_progress",
          requestId: "stable-request",
        }),
      },
    });
    assert.equal(inProgress.status, 1);
    assert.match(inProgress.stderr, /必须复用同一个 CC_SUITE_REQUEST_ID/);
    assert.doesNotMatch(inProgress.stderr, /必须使用新的 CC_SUITE_REQUEST_ID/);

    const unknown = spawnSync("python3", args, {
      ...base,
      env: { ...env, CC_SUITE_TEST_RESPONSE: "invalid" },
    });
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /请求状态未知/);
    assert.match(unknown.stderr, /必须复用同一个 CC_SUITE_REQUEST_ID/);

    const oauthFailed = spawnSync("python3", args, {
      ...base,
      env: {
        ...env,
        CC_SUITE_TEST_RESPONSE: JSON.stringify({
          status: "failed",
          requestId: "stable-request",
          error: "401 OAuth access token has expired",
        }),
      },
    });
    assert.equal(oauthFailed.status, 1);
    assert.match(oauthFailed.stderr, /认证修复后必须使用新的 CC_SUITE_REQUEST_ID/);
    assert.doesNotMatch(oauthFailed.stderr, /必须复用同一个 CC_SUITE_REQUEST_ID/);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("Codex dispatch fails closed until the exact current hook hash is trusted", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "cc-suite-hook-trust-"));
  const project = path.join(fixture, "project");
  const codexHome = path.join(fixture, "codex-home");
  try {
    fs.mkdirSync(path.join(project, ".cc-suite", "bin"), { recursive: true });
    fs.mkdirSync(codexHome);
    const command = `'${path.join(fs.realpathSync(project), ".cc-suite", "bin", "cc-suite-dispatch-hook")}' --host codex --target claude`;
    fs.writeFileSync(path.join(codexHome, "hooks.json"), `${JSON.stringify({
      description: "scope-gated user hook",
      hooks: {
        UserPromptSubmit: [{
          hooks: [{
            type: "command",
            command,
            timeout: 300,
            additionalContextLimit: 0,
          }],
        }],
      },
    }, null, 2)}\n`);

    const payload = { scopeRoot: project, codexHome, argv: [] };
    const untrusted = probeMode("--probe-hook-trust", payload);
    assert.equal(untrusted.ready, false);
    assert.match(untrusted.error, /not trusted/);
    assert.match(untrusted.currentHash, /^sha256:[0-9a-f]{64}$/);

    fs.writeFileSync(path.join(codexHome, "config.toml"), [
      `[hooks.state.${JSON.stringify(untrusted.key)}]`,
      `trusted_hash = ${JSON.stringify(untrusted.currentHash)}`,
      "",
    ].join("\n"));
    assert.equal(probeMode("--probe-hook-trust", payload).ready, true);

    fs.writeFileSync(path.join(codexHome, "config.toml"), [
      `[hooks.state.${JSON.stringify(untrusted.key)}]`,
      'trusted_hash = "sha256:modified"',
      "",
    ].join("\n"));
    fs.writeFileSync(path.join(codexHome, "cli-zh.config.toml"), [
      `[hooks.state.${JSON.stringify(untrusted.key)}]`,
      `trusted_hash = ${JSON.stringify(untrusted.currentHash)}`,
      "",
    ].join("\n"));
    const profiled = { ...payload, argv: ["--profile", "cli-zh"] };
    assert.equal(probeMode("--probe-hook-trust", profiled).ready, true);

    fs.appendFileSync(path.join(codexHome, "cli-zh.config.toml"), "enabled = false\n");
    const disabled = probeMode("--probe-hook-trust", profiled);
    assert.equal(disabled.ready, false);
    assert.match(disabled.error, /disabled/);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("Codex -C and --cd select the effective workspace before scope checks", () => {
  assert.equal(probeCwd("codex", ROOT, ["-C", "tests"]), path.join(ROOT, "tests"));
  assert.equal(
    probeCwd("codex", path.dirname(ROOT), [`--cd=${ROOT}`]),
    ROOT,
  );
  assert.equal(
    probeCwd("codex", path.dirname(ROOT), [`-C${ROOT}`]),
    ROOT,
  );
});

test("Claude and prompt arguments do not invent a different workspace", () => {
  assert.equal(probeCwd("claude", ROOT, ["--add-dir", "/tmp"]), ROOT);
  assert.equal(probeCwd("codex", ROOT, ["--", "-C", "/tmp"]), ROOT);
});
