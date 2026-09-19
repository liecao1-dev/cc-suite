import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { cleanupDir, makeTempDir } from "./helpers.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const runner = path.join(PLUGIN_ROOT, "scripts", "codex-runner.mjs");

function writeActivation(scope, codexBinary) {
  fs.mkdirSync(path.join(scope, ".cc-suite"), { recursive: true });
  fs.writeFileSync(path.join(scope, ".cc-suite", "composer-activation.json"), JSON.stringify({
    schema: 1,
    managedBy: "cc-suite",
    scopeRoot: fs.realpathSync.native(scope),
    binaries: { codex: codexBinary },
  }));
}

function writeFakeCodex(file) {
  fs.writeFileSync(file, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("codex-cli fixture\\n");
} else if (args.join(" ") === "exec --help") {
  process.stdout.write("Usage: codex exec [OPTIONS] [PROMPT]\\n-m, --model <MODEL>\\n-s, --sandbox <MODE>\\n--skip-git-repo-check\\n--json\\n-c, --config <key=value>\\n-o, --output-last-message <FILE>\\n");
} else if (args.join(" ") === "exec resume --help") {
  process.stdout.write("Usage: codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]\\n-m, --model <MODEL>\\n--skip-git-repo-check\\n--json\\n-c, --config <key=value>\\n-o, --output-last-message <FILE>\\n");
} else {
  let prompt = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => { prompt += chunk; });
  process.stdin.on("end", () => {
    fs.writeFileSync(process.env.CAPTURE_ARGV, JSON.stringify(args));
  if (process.env.FAKE_BUDGET) {
    process.stdout.write(JSON.stringify({type:'item.completed',thread_id:'12345678-1234-1234-1234-123456789abc',item:{id:'one',type:'agent_message',text:'Completed first section. Remaining: second section.'}}) + "\\n");
    fs.writeFileSync('saved.txt','durable first section');
    process.on('SIGINT',()=>{ if(process.env.FAKE_BUDGET !== 'ignore') process.exit(130); });
    setInterval(()=>{},1000);
    return;
  }
    const outputIndex = args.indexOf("-o");
    fs.writeFileSync(args[outputIndex + 1], "finished\\n");
    fs.writeFileSync(process.env.CAPTURE_PROMPT, prompt);
    process.stdout.write(JSON.stringify({type:"thread.started",thread_id:"12345678-1234-1234-1234-123456789abc"}) + "\\n");
    process.stdout.write(JSON.stringify({type:"turn.completed",usage:{input_tokens:120,cached_input_tokens:100,output_tokens:8,reasoning_output_tokens:0}}) + "\\n");
  });
}


`, "utf8");
  fs.chmodSync(file, 0o755);
}

test("codex runner reads an arbitrary prompt from stdin without shell interpretation", () => {
  const workspace = makeTempDir();
  try {
    const nested = path.join(workspace, "nested", "working-directory");
    const bin = path.join(workspace, "bin");
    const decoyBin = path.join(workspace, "decoy-bin");
    const capture = path.join(workspace, "captured-prompt.txt");
    const captureArgv = path.join(workspace, "captured-argv.json");
    fs.mkdirSync(bin);
    fs.mkdirSync(nested, { recursive: true });
    fs.mkdirSync(decoyBin);
    const codexBinary = path.join(bin, "codex");
    writeFakeCodex(codexBinary);
    fs.writeFileSync(path.join(decoyBin, "codex"), "#!/usr/bin/env bash\nexit 97\n", { mode: 0o755 });
    writeActivation(workspace, codexBinary);

    // Larger than the common macOS/Linux single-process argv budget.  The
    // runner must stream this through closed non-TTY stdin instead of placing
    // it in one command-line argument.
    const prompt = `literal $(touch should-not-run) \`whoami\` \\\"quotes\\\"\n${"x".repeat(3 * 1024 * 1024)}\nsecond line\n`;
    const result = spawnSync(process.execPath, [
      runner,
      "--kind", "dispatch",
      "--model", "test-model",
      "--effort", "medium",
      "--sandbox", "read-only",
      "--timeout-ms", "5000",
      "--prompt-stdin",
    ], {
      cwd: nested,
      input: prompt,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${decoyBin}:${process.env.PATH ?? ""}`,
        CAPTURE_PROMPT: capture,
        CAPTURE_ARGV: captureArgv,
        CLAUDE_PLUGIN_DATA: path.join(workspace, "state"),
        CC_SUITE_SCOPE_ROOT: workspace,
        CC_SUITE_WORKSPACE_ROOT: workspace,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "completed");
    assert.equal(output.threadId, "12345678-1234-1234-1234-123456789abc");
    assert.equal(output.rawOutput, "finished\n");
    assert.equal(output.usage, undefined, 'Ordinary composer result shape remains unchanged');
    const captured = fs.readFileSync(capture, "utf8");
    assert.match(captured, /^This request already reached you by delegation from Claude Code\./);
    assert.ok(captured.endsWith(prompt));
    assert.equal(captured.match(/This request already reached you/g)?.length, 1);
    assert.equal(fs.existsSync(path.join(workspace, "should-not-run")), false);
    const stateKeys = fs.readdirSync(path.join(workspace, ".cc-suite", "runtime", "state"));
    assert.equal(stateKeys.length, 1);
    assert.match(stateKeys[0], new RegExp(`^${path.basename(workspace)}-`));
    const argv = JSON.parse(fs.readFileSync(captureArgv, "utf8"));
    assert.equal(argv[0], "exec");
    assert.equal(argv[argv.indexOf("--model") + 1], "test-model");
    assert.equal(argv[argv.indexOf("--sandbox") + 1], "read-only");
    assert.ok(argv.includes("--json"));
    assert.ok(argv.includes("--skip-git-repo-check"));
    assert.equal(argv.at(-1), "-");
  } finally {
    cleanupDir(workspace);
  }
});

test("codex runner resumes the native thread without reapplying a sandbox", () => {
  const workspace = makeTempDir("codex-runner-resume-");
  try {
    const bin = path.join(workspace, "bin");
    fs.mkdirSync(bin);
    const codexBinary = path.join(bin, "codex");
    writeFakeCodex(codexBinary);
    writeActivation(workspace, codexBinary);
    const captureArgv = path.join(workspace, "captured-argv.json");
    const result = spawnSync(process.execPath, [
      runner,
      "--kind", "dispatch",
      "--model", "test-model",
      "--effort", "high",
      "--sandbox", "workspace-write",
      "--approval", "on-request",
      "--resume", "87654321-4321-4321-4321-cba987654321",
      "--timeout-ms", "5000",
      "--prompt-stdin",
    ], {
      cwd: workspace,
      input: "继续",
      encoding: "utf8",
      env: {
        ...process.env,
        CAPTURE_ARGV: captureArgv,
        CAPTURE_PROMPT: path.join(workspace, "prompt.txt"),
        CLAUDE_PLUGIN_DATA: path.join(workspace, "state"),
        CC_SUITE_SCOPE_ROOT: workspace,
        CC_SUITE_WORKSPACE_ROOT: workspace,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const argv = JSON.parse(fs.readFileSync(captureArgv, "utf8"));
    assert.deepEqual(argv.slice(0, 3), [
      "exec", "resume", "87654321-4321-4321-4321-cba987654321",
    ]);
    assert.equal(argv.includes("--sandbox"), false);
    assert.equal(argv[argv.indexOf("--model") + 1], "test-model");
    assert.equal(argv.at(-1), "-");
  } finally {
    cleanupDir(workspace);
  }
});

test("codex runner rejects simultaneous argv and stdin prompts", () => {
  const result = spawnSync(process.execPath, [
    runner,
    "--prompt-stdin",
    "--", "inline",
  ], { input: "stdin", encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /either --prompt-stdin or -- <prompt>/);
});

test('Localchat Codex resume requires the matching service policy session and keeps strict read-only configuration', () => {
  const scope = makeTempDir('codex-localchat-m2-');
  try {
    const workspace = path.join(scope, 'workspace'), bin = path.join(scope, 'bin'), home = path.join(scope, 'private-home');
    for (const directory of [workspace, bin, home]) fs.mkdirSync(directory);
    const canonical = fs.realpathSync(workspace), codexBinary = path.join(bin, 'codex'), policyFile = path.join(scope, 'policy.json');
    writeFakeCodex(codexBinary); writeActivation(scope, codexBinary);
    const session = '87654321-4321-4321-4321-cba987654321';
    for (const allowed of [false, true]) {
      fs.writeFileSync(policyFile, JSON.stringify({ schema: 1, target: 'codex', mode: 'read-only', workspace: canonical, codexHome: fs.realpathSync(home), ...(allowed ? { resumeSession: session } : {}) }));
      const fd = fs.openSync(policyFile, 'r');
      let result;
      try {
        result = spawnSync(process.execPath, [runner, '--model','test-model','--effort','medium','--sandbox','read-only','--approval','never','--resume',session,'--timeout-ms','5000','--prompt-stdin'], {
          cwd: workspace, input: '继续只读任务', encoding: 'utf8', stdio: ['pipe','pipe','pipe',fd],
          env: { ...process.env, CODEX_HOME: home, CC_SUITE_LOCALCHAT_POLICY_FD: '3', CC_SUITE_SCOPE_ROOT: fs.realpathSync(scope), CC_SUITE_WORKSPACE_ROOT: canonical,
            CAPTURE_ARGV: path.join(scope,'argv.json'), CAPTURE_PROMPT: path.join(scope,'prompt.txt') },
        });
      } finally { fs.closeSync(fd); }
      if (!allowed) { assert.notEqual(result.status, 0); assert.equal(fs.existsSync(path.join(scope,'argv.json')), false); continue; }
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).usage.source, 'codex.turn.completed');
      assert.equal(JSON.parse(result.stdout).usage.input_tokens, 120);
      assert.equal(JSON.parse(result.stdout).usage.cached_input_tokens, 100);
      assert.equal(JSON.parse(result.stdout).usage.reported_cost_usd, null);
      const argv = JSON.parse(fs.readFileSync(path.join(scope, 'argv.json')));
      assert.deepEqual(argv.slice(0,4), ['--strict-config','exec','resume',session]); assert(!argv.includes('--sandbox'));
      assert(argv.includes('approval_policy="never"'));
    }
  } finally { cleanupDir(scope); }
});

for (const behavior of ['interrupt','ignore']) test('Localchat codex persists progress across ' + behavior + ' at the save deadline', () => {
  const scope=makeTempDir('codex-budget-');
  try {
    const workspace=path.join(scope,'workspace'),bin=path.join(scope,'bin'),home=path.join(scope,'home'),receipts=path.join(scope,'receipts');
    for(const dir of [workspace,bin,home,receipts]) fs.mkdirSync(dir,{mode:0o700});
    const canonical=fs.realpathSync(workspace),binary=path.join(bin,'codex');
    writeFakeCodex(binary); writeActivation(scope,binary);
    const receiptBase=path.join(fs.realpathSync(receipts),'receipt-test'), policy=path.join(scope,'policy.json');
    fs.writeFileSync(policy,JSON.stringify({schema:1,target:'codex',mode:'read-only',workspace:canonical,codexHome:fs.realpathSync(home),receiptBase}));
    const fd=fs.openSync(policy,'r'); let result;
    try { result=spawnSync(process.execPath,[runner,'--model','test-model','--effort','medium','--sandbox','read-only','--approval','never','--timeout-ms','2400','--prompt-stdin'],{
      cwd:workspace,input:'Save incremental progress',encoding:'utf8',timeout:15000,stdio:['pipe','pipe','pipe',fd],
      env:{...process.env,CODEX_HOME:home,CC_SUITE_SCOPE_ROOT:fs.realpathSync(scope),CC_SUITE_WORKSPACE_ROOT:canonical,CC_SUITE_LOCALCHAT_POLICY_FD:'3',FAKE_BUDGET:behavior,
        CAPTURE_ARGV:path.join(scope,'argv.json'),CAPTURE_PROMPT:path.join(scope,'prompt.txt'),CAPTURE_CALL:path.join(scope,'call.json')}
    }); } finally {fs.closeSync(fd);}
    assert.equal(result.error,undefined); assert.equal(result.status,1,result.stderr);
    const output=JSON.parse(result.stdout); assert.equal(output.status,'partial'); assert.match(output.rawOutput,/Completed first section/);
    assert.equal(output.checkpoint.phase,behavior==='ignore'?'hard_deadline':'wrapping_up');
    assert.equal(fs.readFileSync(path.join(workspace,'saved.txt'),'utf8'),'durable first section');
    const checkpoint=JSON.parse(fs.readFileSync(receiptBase+'.checkpoint.json','utf8'));
    assert.match(checkpoint.raw_output,/Remaining: second section/);
    assert.equal(JSON.parse(fs.readFileSync(receiptBase+'.backend.json','utf8')).phase,'closed');
  } finally {cleanupDir(scope);}
});
