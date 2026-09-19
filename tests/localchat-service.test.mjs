import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerLocalchatClient, handleLocalchatRequest, readClientCredential } from '../scripts/lib/localchat-service.mjs';
import { codexReadonlyConfig, claudeReadonlySettings, localchatPrompt } from '../scripts/lib/localchat-policy.mjs';
import { cleanTargetEnvironment } from '../scripts/lib/target-environment.mjs';
import { writeReceipt, processIdentity, identityState, stopExecution } from '../scripts/lib/localchat-receipts.mjs';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

function fixture(t) {
  const scope = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-localchat-')));
  t.after(() => fs.rmSync(scope, { recursive: true, force: true }));
  const workspace = path.join(scope, 'project/sub');
  fs.mkdirSync(workspace, { recursive: true });
  const credentialFile = path.join(scope, 'private/client.json');
  const setup = { scope, workspace, clientId: 'chat-one', credentialFile };
  registerLocalchatClient(setup);
  const { token } = readClientCredential(credentialFile);
  const request = { schema: 1, client_id: 'chat-one', token, operation: 'resolve', backend: 'codex', selection: 'analysis' };
  return { ...setup, request, clientDir: path.join(scope, '.cc-suite/runtime/localchat-service/chat-one') };
}
function environment(backend) {
  const model = backend === 'codex' ? 'codex-example' : 'claude-example';
  return { defaultConfig: { model, effort: 'medium', access: backend === 'codex' ? 'workspace-write' : 'default', ...(backend === 'codex' ? { approval: 'on-request' } : {}) },
    defaultSources: { model: 'fixture', effort: 'fixture', access: 'fixture' }, defaultSource: 'fixture',
    catalog: { models: [model], modelsDetail: [{ slug: model, reasoning_efforts: ['low','medium','high'], default_reasoning_effort: 'medium' }], efforts: ['low','medium','high'], access: backend === 'codex' ? ['read-only','workspace-write'] : ['default','plan','dontAsk'], approvals: ['never','on-request'], metadata: { source: 'fixture', capabilityScope: backend } } };
}
const dependencies = { environment };

test('registration is private, scoped and never overwrites a client', t => {
  const f = fixture(t);
  assert.equal(fs.statSync(f.credentialFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(f.clientDir).mode & 0o777, 0o700);
  assert.throws(() => registerLocalchatClient(f), { code: 'CLIENT_EXISTS' });
  assert.throws(() => registerLocalchatClient({ ...f, clientId: 'elsewhere', workspace: os.tmpdir() }), { code: 'WORKSPACE_DENIED' });
  assert.throws(() => registerLocalchatClient({ ...f, clientId: 'whole-scope', workspace: f.scope }), { code: 'WORKSPACE_DENIED' });
  assert.throws(() => registerLocalchatClient({ ...f, clientId: 'second', credentialFile: path.join(f.workspace,'secret.json') }), { code: 'INSECURE_STORAGE' });
});
test('capabilities show both backends and disabled native defaults without starting a task', async t => {
  const f = fixture(t);
  const result = await handleLocalchatRequest(f.scope, { ...f.request, operation: 'capabilities' }, dependencies);
  assert.equal(result.task_dispatch_available, true);
  assert.equal(result.backends.length, 2);
  for (const backend of result.backends) {
    assert.equal(backend.profiles.find(x => x.id === 'default').enabled, false);
    assert.equal(backend.profiles.find(x => x.id === 'analysis').enabled, true);
  }
  assert.equal(fs.existsSync(path.join(f.clientDir, 'recent-codex.json')), false);
  assert.equal(JSON.stringify(result).includes(f.request.token), false);
});
test('two configurations resolve to different frozen values and exact workspace identity', async t => {
  const f = fixture(t);
  const a = await handleLocalchatRequest(f.scope, f.request, dependencies);
  const b = await handleLocalchatRequest(f.scope, { ...f.request, selection: 'analysis-deep' }, dependencies);
  assert.equal(a.requested_config.effort, 'medium'); assert.equal(b.requested_config.effort, 'high');
  assert.notEqual(a.profile_revision, b.profile_revision);
  assert.equal(a.requested_config.access, 'read-only'); assert.equal(a.requested_config.approval, 'never');
  assert.match(a.sources.access, /analysis:/);
  assert.equal(a.model_resolution.reported, null);
  const custom = await handleLocalchatRequest(f.scope, {...f.request, overrides:{effort:'low'}}, dependencies);
  assert.equal(custom.sources.effort, 'explicit override');
  assert.equal(fs.existsSync(path.join(f.clientDir,'recent-codex.json')), false);
});
test('registered named presets are discoverable and their identity is validated', async t => {
  const f = fixture(t);
  const preset = {id:'reading',label:'阅读',backend:'claude',config:{model:'claude-example',effort:'low',access:'dontAsk'}};
  const registration = {...f,clientId:'custom',credentialFile:path.join(f.scope,'private/custom.json'),presets:[preset]};
  for (const bad of [{...preset,id:undefined},{...preset,label:[]},{...preset,config:{...preset.config,effort:4}}]) {
    assert.throws(()=>registerLocalchatClient({...registration,presets:[bad]}),{code:'INVALID_PRESETS'});
  }
  registerLocalchatClient(registration);
  const credential=readClientCredential(registration.credentialFile);
  const request={...f.request,client_id:'custom',token:credential.token,backend:'claude',selection:'preset:reading'};
  const resolved=await handleLocalchatRequest(f.scope,request,dependencies);
  assert.equal(resolved.requested_config.effort,'low');
  assert.match(resolved.sources.effort,/registered localchat preset/);
  await assert.rejects(handleLocalchatRequest(f.scope,{...request,overrides:{approval:'never'}},dependencies),{code:'CONFIG_NOT_ALLOWED'});
});
test('service delegation names Chat and target environment discards inherited host identity', () => {
  for(const backend of ['codex','claude']) {
    const prompt=localchatPrompt(backend,'中文任务');
    assert.match(prompt,/^This request already reached you by delegation from Chat through localchat\./);
    assert.ok(prompt.endsWith('中文任务'));
    assert.match(prompt,/not a router/);
  }
  const env=cleanTargetEnvironment({PATH:'/usr/bin',CC_SUITE_COMPOSER_HOST:'codex',CODEX_SANDBOX:'seatbelt',CLAUDECODE:'1',ANTHROPIC_API_KEY:'secret'});
  assert.deepEqual(env,{PATH:'/usr/bin'});
});
for (const [label, change, code] of [
  ['wrong token', { token: '0'.repeat(64) }, 'UNAUTHORIZED'],
  ['wrong workspace', { workspace_id: 'other' }, 'WORKSPACE_DENIED'],
  ['path injection', { cwd: '/tmp' }, 'INVALID_REQUEST'],
  ['unsupported operation', { operation: 'exec' }, 'INVALID_OPERATION'],
  ['unsupported backend', { backend: 'other' }, 'INVALID_BACKEND'],
  ['missing selection', { selection: undefined }, 'SELECTION_REQUIRED'],
  ['unknown profile', { selection: 'missing' }, 'UNKNOWN_PROFILE'],
  ['unsupported effort', { overrides: { effort: 'ultra' } }, 'INVALID_CONFIG'],
  ['unknown model', { overrides: { model: 'unlisted' } }, 'INVALID_CONFIG'],
  ['write mode', { overrides: { access: 'workspace-write' } }, 'CONFIG_NOT_ALLOWED'],
  ['approval change', { overrides: { approval: 'on-request' } }, 'CONFIG_NOT_ALLOWED'],
  ['arbitrary override', { overrides: { command: 'echo' } }, 'INVALID_REQUEST'],
]) test(`rejects ${label} before execution`, async t => {
  const f = fixture(t);
  await assert.rejects(handleLocalchatRequest(f.scope, { ...f.request, ...change }, dependencies), { code });
});
test('client files with broad permissions are rejected', async t => {
  const f = fixture(t);
  fs.chmodSync(path.join(f.clientDir,'registration.json'), 0o644);
  await assert.rejects(handleLocalchatRequest(f.scope, f.request, dependencies), { code: 'INSECURE_STORAGE' });
});
test('workspace replacement with a symlink is rejected', async t => {
  const f = fixture(t);
  fs.renameSync(f.workspace, `${f.workspace}-old`);
  fs.symlinkSync(os.tmpdir(), f.workspace);
  await assert.rejects(handleLocalchatRequest(f.scope, f.request, dependencies), { code: 'WORKSPACE_DENIED' });
});
test('probe replays a result after catalog changes and rejects conflicting request bytes', async t => {
  const f = fixture(t); let runs = 0;
  const request = { ...f.request, operation: 'probe', request_id: 'fixed-request', prompt: 'sample' };
  const result = await handleLocalchatRequest(f.scope, request, { environment, execute: async (_c,_r,_f,_e,{onSpawn}) => { runs++; onSpawn(); return { status: 'completed', raw_output: 'ok' }; } });
  assert.equal(result.status, 'completed');
  const recent = JSON.parse(fs.readFileSync(path.join(f.clientDir,'recent-codex.json')));
  assert.equal(recent.config.effort, 'medium');
  const replay = await handleLocalchatRequest(f.scope, request, { environment: () => { throw new Error('catalog gone'); } });
  assert.equal(replay.replayed, true); assert.equal(replay.raw_output,'ok'); assert.equal(runs,1);
  await assert.rejects(handleLocalchatRequest(f.scope, { ...request, prompt: 'changed' }, dependencies), { code: 'REQUEST_CONFLICT' });
});
test('concurrent probe cannot start a second model and an active claim is replayed honestly', async t => {
  const f = fixture(t); let finish;
  const request = { ...f.request, operation: 'probe', request_id: 'first', prompt: 'sample' };
  const first = handleLocalchatRequest(f.scope, request, { environment, execute: () => new Promise(r => { finish=r; }) });
  const replay = await handleLocalchatRequest(f.scope, request, dependencies);
  assert.equal(replay.status, 'indeterminate');
  await assert.rejects(handleLocalchatRequest(f.scope, { ...request, request_id:'second' }, dependencies), { code: 'CLIENT_BUSY' });
  finish({status:'completed',raw_output:'ok'}); await first;
});
test('missing probe ID and oversized input fail before execution', async t => {
  const f=fixture(t);
  await assert.rejects(handleLocalchatRequest(f.scope,{...f.request,operation:'probe',prompt:'sample'},dependencies),{code:'INVALID_PROBE'});
  await assert.rejects(handleLocalchatRequest(f.scope,{...f.request,operation:'probe',request_id:'size',prompt:'a'.repeat(33000)},dependencies),{code:'INVALID_PROBE'});
});
test('readonly policies omit the legacy sandbox override and disable unrelated tool surfaces', () => {
  const text=codexReadonlyConfig('/test/authorized');
  assert.match(text,/default_permissions = "localchat-read"/);
  assert.doesNotMatch(text,/sandbox_mode|:root.*read/);
  assert.match(text,/hooks = false/);
  assert.equal(claudeReadonlySettings('/test/authorized').sandbox.filesystem.allowRead[0],'/test/authorized');
  assert.deepEqual(claudeReadonlySettings('/test/authorized').sandbox.filesystem.allowWrite,[]);
});


test('prepared tasks freeze configurations and prompt bytes across later preset changes', async t => {
  const f=fixture(t);
  const request={...f.request,operation:'prepare',request_id:'task-one',prompt:'完整的上下文\n第二行'};
  const prepared=await handleLocalchatRequest(f.scope,request,dependencies);
  assert.equal(prepared.config.requested_config.effort,'medium');
  assert.equal(fs.existsSync(path.join(f.clientDir,'recent-codex.json')),false);
  const changed=backend=>{const e=environment(backend);e.defaultConfig.model='replacement';e.catalog.models.push('replacement');return e;};
  let count=0;
  const run={schema:1,client_id:f.request.client_id,token:f.request.token,operation:'run',backend:'codex',request_id:'task-one'};
  const result=await handleLocalchatRequest(f.scope,run,{environment:changed,execute:async(_client,request,config)=>{
    count++;assert.equal(config.requested_config.model,'codex-example');assert.equal(request.prompt,'完整的上下文\n第二行');return {status:'completed',raw_output:'完成'};
  }});
  assert.equal(result.status,'completed');
  assert.equal((await handleLocalchatRequest(f.scope,run,{environment:()=>{throw Error('gone')}})).replayed,true);
  assert.equal(count,1);
  await assert.rejects(handleLocalchatRequest(f.scope,{...request,prompt:'different'},dependencies),{code:'REQUEST_CONFLICT'});
  await assert.rejects(handleLocalchatRequest(f.scope,{...run,overrides:{model:'replacement'}},dependencies),{code:'INVALID_REQUEST'});
  await assert.rejects(handleLocalchatRequest(f.scope,{...run,backend:'claude'},dependencies),{code:'INVALID_BACKEND'});
});
test('invalidated frozen model fails without fallback or launching a CLI', async t=>{
  const f=fixture(t);await handleLocalchatRequest(f.scope,{...f.request,operation:'prepare',request_id:'stale',prompt:'task'},dependencies);
  const absent=backend=>{const e=environment(backend);e.catalog.models=['new-model'];return e;};
  await assert.rejects(handleLocalchatRequest(f.scope,{schema:1,client_id:f.request.client_id,token:f.request.token,operation:'run',backend:'codex',request_id:'stale'},{environment:absent,execute:()=>assert.fail('must not start')}),{code:'INVALID_CONFIG'});
});

test('large escaped results remain replayable from private storage',async t=>{
  const f=fixture(t),request={...f.request,operation:'probe',request_id:'large',prompt:'sample'},output='"'.repeat(600000);
  await handleLocalchatRequest(f.scope,request,{environment,execute:async()=>({status:'completed',raw_output:output})});
  assert.equal((await handleLocalchatRequest(f.scope,request,dependencies)).raw_output,output);
});

function operation(f, name, id, rest = {}) {
  return { schema: 1, client_id: f.request.client_id, token: f.request.token, backend: rest.backend ?? 'codex', operation: name, request_id: id, ...rest };
}
const nativeSession = '12345678-1234-1234-1234-123456789abc';
test('M2 Codex resumes only an owned successful parent with unchanged frozen configuration', async t => {
  const f = fixture(t); let seen;
  const execute = async (_c, r) => { seen = r; return { status: 'completed', raw_output: '第一轮', backend_session_id: nativeSession }; };
  await handleLocalchatRequest(f.scope, operation(f, 'prepare', 'one', { selection: 'analysis', prompt: '原始要求' }), dependencies);
  await handleLocalchatRequest(f.scope, operation(f, 'run', 'one'), { environment, execute });
  const next = await handleLocalchatRequest(f.scope, operation(f, 'prepare', 'two', { parent_request_id: 'one', prompt: '原始要求和新增要求' }), dependencies);
  assert.equal(next.continuation.mode, 'codex-native-resume');
  await handleLocalchatRequest(f.scope, operation(f, 'run', 'two'), { environment, execute });
  assert.equal(seen.resume_session, nativeSession); assert.equal(seen.prompt, '原始要求和新增要求');
  await assert.rejects(handleLocalchatRequest(f.scope, operation(f, 'prepare', 'foreign', { parent_request_id: 'missing', prompt: 'task' }), dependencies), { code: 'PREPARED_NOT_FOUND' });
  await assert.rejects(handleLocalchatRequest(f.scope, { ...operation(f, 'run', 'two'), resume_session: nativeSession }, dependencies), { code: 'INVALID_REQUEST' });
  const changed = await handleLocalchatRequest(f.scope, operation(f, 'prepare', 'three', { parent_request_id: 'two', selection: 'analysis-deep', prompt: '全部用户要求' }), dependencies);
  assert.equal(changed.continuation.mode, 'context-handoff');
  await handleLocalchatRequest(f.scope, operation(f, 'run', 'three'), { environment, execute });
  assert.equal(seen.resume_session, undefined); assert.match(seen.prompt, /第一轮/);
});
test('M2 Claude replay is bounded and explicitly reports shortened backend answers', async t => {
  const f = fixture(t); let seen;
  const execute = async (_c, r) => { seen = r; return { status: 'completed', raw_output: '文'.repeat(30000), backend_session_id: nativeSession }; };
  await handleLocalchatRequest(f.scope, operation(f, 'prepare', 'one', { backend: 'claude', selection: 'analysis', prompt: '第一条原话' }), dependencies);
  await handleLocalchatRequest(f.scope, operation(f, 'run', 'one', { backend: 'claude' }), { environment, execute });
  await handleLocalchatRequest(f.scope, operation(f, 'prepare', 'two', { backend: 'claude', parent_request_id: 'one', prompt: '第一条原话和第二条原话\n永久约束' }), dependencies);
  const result = await handleLocalchatRequest(f.scope, operation(f, 'run', 'two', { backend: 'claude' }), { environment, execute });
  assert.equal(result.continuation.mode, 'saved-conversation-replay'); assert.equal(result.continuation.truncated, true); assert.equal(result.continuation.retained_turns, 1);
  assert(seen.prompt.startsWith('第一条原话和第二条原话\n永久约束')); assert(Buffer.byteLength(seen.prompt) <= 64000); assert.equal(seen.resume_session, undefined);
});
test('M2 recovery imports runner completion after owner loss and never invokes inference', async t => {
  const f = fixture(t);
  await handleLocalchatRequest(f.scope, operation(f, 'prepare', 'saved', { selection: 'analysis', prompt: 'task' }), dependencies);
  const prepared = JSON.parse(fs.readFileSync(path.join(f.clientDir, 'prepared-saved.json')));
  const file = path.join(f.clientDir, 'execution-saved.json'), base = path.join(f.clientDir, 'receipt-saved');
  fs.writeFileSync(file, JSON.stringify({ fingerprint: prepared.fingerprint, owner: { pid: 2147483647, pidStartedAt: 'old' }, deadline_at: Date.now() - 10000, response: { status: 'indeterminate' } }), { mode: 0o600 });
  writeReceipt(base, 'backend', { phase: 'closed' }); writeReceipt(base, 'runner', { phase: 'closed' });
  writeReceipt(base, 'result', { status: 'completed', rawOutput: 'durable result', threadId: nativeSession, jobId: 'owned-job' });
  const result = await handleLocalchatRequest(f.scope, operation(f, 'inspect', 'saved'), { execute: () => assert.fail('must not dispatch') });
  assert.equal(result.status, 'completed'); assert.equal(result.raw_output, 'durable result'); assert.equal(result.backend_session_id, nativeSession);
  assert.equal((await handleLocalchatRequest(f.scope, operation(f, 'run', 'saved'), dependencies)).replayed, true);
});
test('M2 unknown crash boundaries stay indeterminate; canceled identities can never be run', async t => {
  const f = fixture(t);
  await handleLocalchatRequest(f.scope, operation(f, 'prepare', 'unknown', { selection: 'analysis', prompt: 'task' }), dependencies);
  fs.writeFileSync(path.join(f.clientDir, 'execution-unknown.json'), JSON.stringify({ owner: { pid: 2147483647 }, deadline_at: Date.now() + 10000, response: { status: 'indeterminate' } }), { mode: 0o600 });
  const unknown = await handleLocalchatRequest(f.scope, operation(f, 'inspect', 'unknown'), dependencies);
  assert.equal(unknown.status, 'indeterminate'); assert.equal(unknown.termination_confirmed, false);
  await handleLocalchatRequest(f.scope, operation(f, 'prepare', 'queued', { selection: 'analysis', prompt: 'task' }), dependencies);
  const neverStarted = await handleLocalchatRequest(f.scope, operation(f, 'cancel', 'queued'), dependencies);
  assert.equal(neverStarted.status, 'canceled'); assert.equal(neverStarted.termination_confirmed, true);
  const canceled = await handleLocalchatRequest(f.scope, operation(f, 'run', 'queued'), { environment, execute: () => assert.fail('must not dispatch') });
  assert.equal(canceled.status, 'canceled'); assert.equal(canceled.termination_confirmed, true);
});

test('M2 expired execution without a result becomes timed_out only after confirmed process exit', async t => {
  const f = fixture(t);
  await handleLocalchatRequest(f.scope, operation(f, 'prepare', 'expired', { selection: 'analysis', prompt: 'task' }), dependencies);
  const file = path.join(f.clientDir, 'execution-expired.json'), base = path.join(f.clientDir, 'receipt-expired');
  fs.writeFileSync(file, JSON.stringify({ owner: { pid: 2147483647 }, deadline_at: Date.now() - 1000, response: { status: 'indeterminate' } }), { mode: 0o600 });
  writeReceipt(base, 'runner', { phase: 'closed' }); writeReceipt(base, 'backend', { phase: 'closed' });
  const result = await handleLocalchatRequest(f.scope, operation(f, 'inspect', 'expired'), dependencies);
  assert.equal(result.status, 'timed_out'); assert.equal(result.termination_confirmed, true); assert.equal(result.raw_output, undefined);
});
test('M2 stopping kills detached CLI descendants and refuses unverified PID identities', async t => {
  const f = fixture(t), base = path.join(f.clientDir, 'receipt-process');
  const child = spawn(process.execPath, ['-e', `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'}); console.log(child.pid); setInterval(()=>{},1000);`], { detached: true, stdio: ['ignore','pipe','ignore'] });
  t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} });
  const descendant = await new Promise(resolve => child.stdout.once('data', chunk => resolve(Number(chunk.toString().trim())))); await delay(100);
  const backend = processIdentity(child.pid), member = processIdentity(descendant);
  assert(backend.pidStartedAt, 'Process inspection must be available for lifecycle acceptance');
  writeReceipt(base, 'backend', { phase: 'running', ...backend }); writeReceipt(base, 'runner', { phase: 'closed' });
  assert.equal(stopExecution(base), true); assert.equal(identityState(backend), 'gone'); assert.equal(identityState(member), 'gone');
  writeReceipt(base, 'backend', { phase: 'running', pid: process.pid, pidStartedAt: null });
  assert.equal(stopExecution(base), false); assert.equal(identityState(processIdentity()), 'alive');
});
