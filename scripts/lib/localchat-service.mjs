import fs from 'node:fs';
import { EXECUTION_MS, SAVE_MS, STARTUP_MS, savedPartial } from './localchat-budget.mjs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getDispatchEnvironment } from './dispatch-catalog.mjs';
import { buildDispatchProfiles, validateAgainstCatalog, defaultEffortForModel } from './dispatch-config.mjs';
import { resolveActivatedCliBinary, inspectCodexCliCapabilities } from './activated-cli.mjs';
import { cleanTargetEnvironment } from './target-environment.mjs';
import { codexReadonlyConfig, codexCopyConfig } from './localchat-policy.mjs';
import { writeReceipt, readReceipt, processIdentity, identityState, stopIdentity, executionProcesses, stopExecution } from './localchat-receipts.mjs';

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const MAX_REQUEST = 128 * 1024;
export class ServiceError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new ServiceError(code, message); };
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const inside = (parent, child) => { const r = path.relative(parent, child); return !r || (!r.startsWith('..' + path.sep) && r !== '..' && !path.isAbsolute(r)); };
function object(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_REQUEST', 'Expected an object');
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail('INVALID_REQUEST', `Unsupported field: ${key}`);
}
function directory(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) fail('INVALID_DIRECTORY', 'An absolute directory is required');
  let real;
  try { real = fs.realpathSync(value); } catch { fail('INVALID_DIRECTORY', 'Directory is unavailable'); }
  if (!fs.statSync(real).isDirectory()) fail('INVALID_DIRECTORY', 'Not a directory');
  return real;
}
function privateDirectory(value) {
  fs.mkdirSync(value, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(value);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.uid !== process.getuid?.()) {
    fail('INSECURE_STORAGE', 'Service storage must be a private owned directory');
  }
}
function privateJson(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.uid !== process.getuid?.() || stat.size > MAX_REQUEST * 32) {
    fail('INSECURE_STORAGE', 'Service data must be a private owned regular file');
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function save(file, value, exclusive = false) {
  const data = JSON.stringify(value, null, 2) + '\n';
  if (exclusive) return fs.writeFileSync(file, data, { mode: 0o600, flag: 'wx' });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(tmp, data, { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, file); }
  finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
function serviceRoot(scope, create = false) {
  const root = path.join(scope, '.cc-suite/runtime/localchat-service');
  if (create) privateDirectory(root);
  if (directory(root) !== root) fail('INSECURE_STORAGE', 'Service storage may not escape through a symlink');
  return root;
}

export function registerLocalchatClient({ scope, workspace, clientId, credentialFile, presets = [] }) {
  if (typeof clientId !== 'string' || !ID.test(clientId)) fail('INVALID_CLIENT', 'Invalid service client ID');
  const scopeRoot = directory(scope), workspaceRoot = directory(workspace);
  if (!inside(scopeRoot, workspaceRoot)) fail('WORKSPACE_DENIED', 'Workspace must be inside the registered scope');
  if (inside(workspaceRoot, path.join(scopeRoot, '.cc-suite')) || inside(workspaceRoot, SOURCE_ROOT)) fail('WORKSPACE_DENIED', 'Workspace must not contain execution source or service state');
  if (!Array.isArray(presets) || presets.length > 30) fail('INVALID_PRESETS', 'Invalid presets');
  const names = new Set();
  for (const preset of presets) {
    object(preset, ['id', 'label', 'backend', 'config', 'mode']);
    if (preset.mode !== undefined && !['read-only','edit'].includes(preset.mode)) fail('INVALID_PRESETS', 'Preset mode must be read-only or edit');
    if (typeof preset.id !== 'string' || !ID.test(preset.id) || names.has(preset.id) || !['codex','claude'].includes(preset.backend)
        || (preset.label !== undefined && (typeof preset.label !== 'string' || !preset.label.trim() || preset.label.length > 120))) fail('INVALID_PRESETS', 'Invalid preset identity');
    names.add(preset.id);
    object(preset.config, ['model','effort','access','approval']);
    if (Object.values(preset.config).some(value => typeof value !== 'string') || !preset.config.model || !preset.config.effort) fail('INVALID_PRESETS', 'Preset model and effort must be explicit strings');
    if (preset.mode === 'edit') enforceEditing(preset.backend, preset.config);
    else enforceReadonly(preset.backend, preset.config);
  }
  if (!path.isAbsolute(credentialFile) || inside(workspaceRoot, path.resolve(credentialFile))) fail('INSECURE_STORAGE', 'Keep service credentials outside the model workspace');
  privateDirectory(path.dirname(credentialFile));
  const root = serviceRoot(scopeRoot, true);
  const clientDir = path.join(root, clientId);
  if (fs.existsSync(clientDir) || fs.existsSync(credentialFile)) fail('CLIENT_EXISTS', 'Client already exists; registration never replaces credentials');
  privateDirectory(clientDir);
  const token = randomBytes(32).toString('hex');
  const registration = { schema: 1, clientId, scope: scopeRoot, workspace: workspaceRoot, tokenHash: hash(token), presets, createdAt: new Date().toISOString() };
  save(path.join(clientDir, 'registration.json'), registration, true);
  save(credentialFile, { schema: 1, clientId, token, scope: scopeRoot, workspace: workspaceRoot }, true);
  return { status: 'registered', client_id: clientId, workspace: workspaceRoot, credential_file: credentialFile };
}

function authenticate(scope, request) {
  object(request, ['schema','client_id','token','operation','backend','selection','overrides','request_id','prompt','workspace_id','parent_request_id','mode']);
  if (request.schema !== 1 || typeof request.client_id !== 'string' || !ID.test(request.client_id) || !/^[a-f0-9]{64}$/.test(request.token ?? '')) fail('UNAUTHORIZED', 'Invalid service credentials');
  const scopeRoot = directory(scope), root = serviceRoot(scopeRoot);
  const clientDir = path.join(root, request.client_id);
  if (directory(clientDir) !== clientDir) fail('INSECURE_STORAGE', 'Client directory may not be a symlink');
  let registration;
  try { registration = privateJson(path.join(clientDir, 'registration.json')); }
  catch (e) { if (e instanceof ServiceError) throw e; fail('UNAUTHORIZED', 'Unknown service client'); }
  if (registration.schema !== 1 || !/^[a-f0-9]{64}$/.test(registration.tokenHash ?? '') || registration.clientId !== request.client_id || registration.scope !== scopeRoot
      || !timingSafeEqual(Buffer.from(hash(request.token)), Buffer.from(registration.tokenHash))) fail('UNAUTHORIZED', 'Invalid service credentials');
  if (directory(registration.workspace) !== registration.workspace || !inside(scopeRoot, registration.workspace)) fail('WORKSPACE_DENIED', 'Registered workspace changed');
  const workspaceId = hash(registration.workspace).slice(0, 24);
  if (request.workspace_id !== undefined && request.workspace_id !== workspaceId) fail('WORKSPACE_DENIED', 'Wrong workspace ID');
  return { ...registration, clientDir, workspaceId };
}
function enforceReadonly(backend, config) {
  if (backend === 'codex' && (config.access !== 'read-only' || config.approval !== 'never')) {
    fail('CONFIG_NOT_ALLOWED', 'Localchat Codex supports read-only with approval=never');
  }
  if (backend === 'claude' && (!['plan','dontAsk'].includes(config.access) || config.approval !== undefined)) {
    fail('CONFIG_NOT_ALLOWED', 'Localchat Claude supports plan or dontAsk with read-only tools');
  }
}
function enforceEditing(backend, config) {
  if (backend === 'codex' ? config.access !== 'workspace-write' || config.approval !== 'never' : config.access !== 'dontAsk' || config.approval !== undefined) {
    fail('CONFIG_NOT_ALLOWED', 'Copy editing requires Codex workspace-write/never or Claude dontAsk with scoped editing tools');
  }
}
function validate(backend, config, catalog, mode = 'read-only') {
  object(config, ['model','effort','access','approval']);
  if (backend === 'claude' && config.approval !== undefined) fail('CONFIG_NOT_ALLOWED', 'Claude does not accept a Codex approval policy');
  let normalized;
  try { normalized = validateAgainstCatalog(backend, config, catalog); }
  catch (e) { fail('INVALID_CONFIG', e.message); }
  if (mode === 'edit') enforceEditing(backend, normalized);
  else enforceReadonly(backend, normalized);
  return normalized;
}

function defaultEnvironment(backend, client) {
  const binary = resolveActivatedCliBinary(client.scope, backend);
  const environment = getDispatchEnvironment(backend, client.workspace, { workspaceRoot: client.workspace, cliBinary: binary, scopeRoot: client.scope });
  return { ...environment, binary };
}
function profiles(client, backend, environment, mode = 'read-only') {
  const recentFile = path.join(client.clientDir, `recent-${backend}.json`);
  const recent = fs.existsSync(recentFile) ? privateJson(recentFile) : null;
  const rows = buildDispatchProfiles({ target: backend, recent, defaultConfig: environment.defaultConfig, defaultSource: environment.defaultSource, catalog: environment.catalog }).profiles;
  const model = environment.defaultConfig.model;
  const efforts = environment.catalog.modelsDetail.find(x => x.slug === model)?.reasoning_efforts ?? environment.catalog.efforts;
  const config = {
    model, effort: defaultEffortForModel(backend, model, environment.catalog),
    access: backend === 'codex' ? 'read-only' : 'plan',
    ...(backend === 'codex' ? { approval: 'never' } : {}),
  };
  rows.push({ id: 'analysis', label: '分析', config, source: 'localchat M0 read-only preset' });
  rows.push({ id: 'analysis-deep', label: '深入分析', config: { ...config, effort: efforts.includes('high') ? 'high' : efforts.at(-1) }, source: 'localchat M0 read-only preset' });
  rows.push({ id: 'edit', label: '修改任务副本', config: { ...config, access: backend === 'codex' ? 'workspace-write' : 'dontAsk' }, source: 'localchat M3 task-copy preset' });
  for (const preset of client.presets.filter(x => x.backend === backend)) {
    rows.push({ id: `preset:${preset.id}`, label: preset.label ?? preset.id, config: preset.config, source: 'registered localchat preset', ...(preset.mode === 'edit' ? { mode: 'edit' } : {}) });
  }
  return rows.map(row => {
    try { if ((row.id === 'edit' || row.mode === 'edit') && mode !== 'edit') fail('CONFIG_NOT_ALLOWED', 'This profile requires explicit edit mode'); validate(backend, row.config, environment.catalog, mode); return { ...row, enabled: true }; }
    catch (e) { return { ...row, enabled: false, unavailable_reason: e.message }; }
  });
}
function resolve(client, request, environment) {
  const mode = request.mode ?? 'read-only';
  if (typeof request.selection !== 'string') fail('SELECTION_REQUIRED', 'Select recent, default, a model row, or a named preset');
  object(request.overrides ?? {}, ['model','effort','access','approval']);
  const row = profiles(client, request.backend, environment, mode).find(x => x.id === request.selection);
  if (!row) fail('UNKNOWN_PROFILE', 'Configuration selection is unavailable');
  if ((row.id === 'edit' || row.mode === 'edit') && mode !== 'edit') fail('CONFIG_NOT_ALLOWED', 'This profile requires explicit edit mode');
  const requested = validate(request.backend, { ...row.config, ...request.overrides }, environment.catalog, mode);
  const sources = Object.fromEntries(Object.keys(requested).map(key => [key,
    Object.hasOwn(request.overrides ?? {}, key) ? 'explicit override' : `${row.id}: ${row.source ?? 'cc-suite catalog'}`]));
  return {
    schema: 1, workspace_id: client.workspaceId, backend: request.backend, selection: row.id,
    task_mode: mode,
    requested_config: requested,
    effective_config: { ...requested, filesystem: mode === 'edit' ? 'private-task-copy-only' : 'authorized-workspace-read-only', ...(request.backend === 'claude' ? { tools: mode === 'edit' ? ['Read','Edit','Write'] : ['Read'] } : { permission_profile: mode === 'edit' ? 'localchat-edit' : 'localchat-read' }) },
    profile_revision: hash({ row, overrides: request.overrides ?? {}, requested, ...(mode === 'edit' ? { mode } : {}) }),
    resolved_at: new Date().toISOString(), sources, default_sources: environment.defaultSources,
    model_resolution: { requested: requested.model, reported: null, status: 'not-reported-by-runner' },
    cli_version: environment.catalog.metadata.codexVersion ?? environment.catalog.metadata.claudeVersion ?? null,
  };
}

function prepareCodexHome(client, workspace, mode) {
  const home = path.join(client.clientDir, mode === 'edit' ? `codex-home-${hash(workspace).slice(0,24)}` : 'codex-home');
  privateDirectory(home);
  const original = path.join(os.homedir(), '.codex/auth.json');
  const reference = path.join(home, 'auth.json');
  if (!fs.existsSync(original)) fail('AUTH_REQUIRED', 'Native Codex file login is unavailable; no API credentials are created');
  if (fs.existsSync(reference)) {
    if (!fs.lstatSync(reference).isSymbolicLink() || fs.realpathSync(reference) !== fs.realpathSync(original)) fail('AUTH_REFERENCE_CHANGED', 'Codex login reference changed; inspect it locally before continuing');
  } else fs.symlinkSync(original, reference);
  const config = path.join(home, 'config.toml');
  fs.writeFileSync(config, (mode === 'edit' ? codexCopyConfig : codexReadonlyConfig)(workspace), { mode: 0o600 });
  return home;
}

export function executeServiceProbe(client, request, frozen, environment, { onSpawn = () => {}, receiptBase, cancelled = () => false } = {}) {
  const mode = frozen.task_mode ?? 'read-only';
  const workspace = mode === 'edit' ? copyWorkspace(client, request.copy_root_id) : client.workspace;
  const policy = { schema: 1, mode, workspace, target: request.backend, receiptBase, ...(request.resume_session ? { resumeSession: request.resume_session } : {}) };
  const env = cleanTargetEnvironment(process.env);
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL']) delete env[key];
  // This authenticated entry owns its lifecycle; it never borrows a composer identity.
  for (const key of Object.keys(env)) if (/^CC_SUITE_(COMPOSER|DISPATCH_BROKER|PROGRAMMATIC|REQUEST|LOCALCHAT)/.test(key)) delete env[key];
  env.CC_SUITE_SCOPE_ROOT = client.scope;
  env.CC_SUITE_WORKSPACE_ROOT = workspace;
  env.CLAUDE_PLUGIN_DATA = path.join(client.scope, '.cc-suite/runtime');
  env.CC_SUITE_LOCALCHAT_POLICY_FD = '3';
  if (request.backend === 'codex') {
    const capabilities = inspectCodexCliCapabilities(environment.binary);
    if (!capabilities.ok) fail('CLI_INCOMPATIBLE', capabilities.problems.join('; '));
    policy.codexHome = prepareCodexHome(client, workspace, mode);
    env.CODEX_HOME = policy.codexHome;
  }
  const config = frozen.requested_config;
  const args = [path.join(SOURCE_ROOT, `scripts/${request.backend}-runner.mjs`), '--kind', `${request.backend}-localchat-m0`, '--model', config.model, '--effort', config.effort,
    ...(request.backend === 'codex' ? ['--sandbox', config.access, '--approval', config.approval] : ['--permission-mode', config.access]),
    ...(request.resume_session ? ['--resume', request.resume_session] : []), '--timeout-ms', String(EXECUTION_MS), '--prompt-stdin'];
  return new Promise((resolveResult, reject) => {
    writeReceipt(receiptBase, 'runner', { phase: 'spawning' });
    const child = spawn(process.execPath, args, { cwd: workspace, env, stdio: ['pipe','pipe','pipe','pipe'], detached: true });
    writeReceipt(receiptBase, 'runner', { phase: 'running', ...processIdentity(child.pid) });
    let stdout = '', stderr = '', timedOut = false, overflow = false;
    const kill = () => stopExecution(receiptBase);
    const cancelTimer = setInterval(() => { if (cancelled()) kill(); }, 500);
    const launchedAt = Date.now();
    const timer = setInterval(() => {
      const checkpoint = readReceipt(receiptBase, 'checkpoint');
      const deadline = checkpoint?.deadline_at ? Date.parse(checkpoint.deadline_at) + 15_000 : launchedAt + STARTUP_MS;
      if (Date.now() >= deadline) { timedOut = true; kill(); }
    }, 500);
    const stop = () => kill();
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
    const cleanup = () => { clearInterval(timer); clearInterval(cancelTimer); process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdin.on('error', () => {}); child.stdio[3].on('error', () => {});
    child.stdio[3].end(JSON.stringify(policy)); child.stdin.end(request.prompt);
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 2 * 1024 * 1024) { overflow = true; kill(); } });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
    child.once('error', error => { cleanup(); reject(new ServiceError('RUNNER_UNAVAILABLE', error.code ?? 'Cannot start runner')); });
    child.once('close', code => {
      cleanup();
      writeReceipt(receiptBase, 'runner', { phase: 'closed', ...processIdentity(child.pid) });
      if (timedOut || overflow) return reject(new ServiceError(timedOut ? 'EXECUTION_TIMEOUT' : 'RESULT_TOO_LARGE', 'Execution stopped without a confirmed result'));
      let result;
      try { result = JSON.parse(stdout); } catch { return reject(new ServiceError('RUNNER_FAILED', 'Runner returned no structured result; inspect private local logs')); }
      if (result.cliStarted === true) onSpawn();
      resolveResult(normalizeResult(result, code));
    });
  });
}

function normalizeResult(result, exitCode = result.status === 'completed' ? 0 : 1) {
  const info = { backend_session_id: result.threadId ?? null, job_id: result.jobId ?? null, reported_model: result.nativeModel ?? null, permission_denials: result.permissionDenials ?? [], usage: result.usage ?? null };
  if (result.status === 'partial' && result.checkpoint?.partial === true && typeof result.rawOutput === 'string' && Buffer.byteLength(result.rawOutput) <= 1024 * 1024) return { status: 'partial', raw_output: result.rawOutput, checkpoint: result.checkpoint, ...info };
  const message = result.error ?? result.errorMessage ?? 'Execution did not complete';
  if (exitCode !== 0 || result.status !== 'completed' || typeof result.rawOutput !== 'string' || !result.rawOutput.trim()) {
    const error_code = result.status === 'stalled' || /timed out/i.test(message) ? 'EXECUTION_TIMEOUT'
      : /401|oauth|not logged|authentication|login required/i.test(message) ? 'AUTH_REQUIRED'
      : /429|quota|usage limit|rate.limit/i.test(message) ? 'QUOTA_OR_RATE_LIMIT'
      : /sandbox|permission denied|not permitted/i.test(message) ? 'PERMISSION_DENIED' : 'PROBE_FAILED';
    return { status: error_code === 'EXECUTION_TIMEOUT' ? 'timed_out' : 'failed', error_code, message, ...info };
  }
  if (Buffer.byteLength(result.rawOutput) > 1024 * 1024) return { status: 'failed', error_code: 'RESULT_TOO_LARGE', ...info };
  return { status: 'completed', raw_output: result.rawOutput, ...info };
}
const receiptBaseFor = (client, id) => path.join(client.clientDir, `receipt-${id}`);
const cancelledFor = (client, id) => fs.existsSync(path.join(client.clientDir, `cancel-${id}.json`));
const sameConfig = (a, b) => a.profile_revision === b.profile_revision && hash(a.effective_config) === hash(b.effective_config);
function copyWorkspace(client, rootId) {
  if (!/^[a-f0-9]{32}$/.test(rootId ?? '')) fail('INVALID_COPY', 'A bound task-copy identity is required');
  const copy = path.join(client.clientDir, 'workspaces', rootId, 'files');
  // Every component is fixed by service identity; callers cannot supply a path.
  for (const entry of [path.dirname(path.dirname(copy)), path.dirname(copy), copy]) {
    let stat;
    try { stat = fs.lstatSync(entry); } catch (error) { if (error.code === 'ENOENT') fail('COPY_UNAVAILABLE', 'The private task copy has not been created'); throw error; }
    if (directory(entry) !== entry || !stat.isDirectory() || stat.mode & 0o077 || stat.uid !== process.getuid?.()) fail('INVALID_COPY', 'Task copy must be a private owned directory without symlinks');
  }
  return copy;
}
function preparedFor(client, id) {
  if (typeof id !== 'string' || !ID.test(id)) fail('INVALID_REQUEST', 'Invalid parent or execution identity');
  try { return privateJson(path.join(client.clientDir, `prepared-${id}.json`)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; fail('PREPARED_NOT_FOUND', 'Prepared execution is unavailable in this client'); }
}
function continuationFor(prepared, parent) {
  return { parent_request_id: prepared.parent_request_id ?? null,
    mode: !parent ? 'fresh' : !sameConfig(prepared.config, parent.config) ? 'context-handoff' : prepared.config.backend === 'codex' ? 'codex-native-resume' : 'saved-conversation-replay',
    config_changed: Boolean(parent && !sameConfig(prepared.config, parent.config)) };
}
function executionContext(client, prepared) {
  const parent = prepared.parent_request_id ? preparedFor(client, prepared.parent_request_id) : null;
  const continuation = continuationFor(prepared, parent);
  if (!parent) return { prompt: prepared.prompt, continuation };
  const prior = privateJson(path.join(client.clientDir, `execution-${prepared.parent_request_id}.json`)).response;
  if (!['completed','partial','failed','canceled','timed_out'].includes(prior.status)) fail('PARENT_UNFINISHED', 'Previous execution has no confirmed terminal result');
  if (continuation.mode === 'codex-native-resume' && ['completed','partial'].includes(prior.status) && (prior.status !== 'partial' || /^[a-f0-9-]{16,64}$/i.test(prior.backend_session_id ?? ''))) {
    if (!/^[a-f0-9-]{16,64}$/i.test(prior.backend_session_id ?? '')) fail('CONTINUITY_UNAVAILABLE', 'Previous Codex session identity is unavailable; no replacement session was started');
    return { prompt: prepared.prompt, resume_session: prior.backend_session_id, continuation: { ...continuation, retained_turns: null, truncated: false } };
  }
  if (continuation.mode === 'codex-native-resume') continuation.mode = 'context-handoff';
  const turns = [], seen = new Set();
  let id = prepared.parent_request_id;
  while (id) {
    if (seen.has(id) || seen.size >= 64) fail('CONTEXT_TOO_LARGE', 'Continuation ancestry exceeds its limit');
    seen.add(id);
    const record = preparedFor(client, id);
    const result = privateJson(path.join(client.clientDir, `execution-${id}.json`)).response;
    turns.unshift({ request_id: id, backend: record.config.backend, status: result.status, content: result.raw_output ?? '' });
    id = record.parent_request_id;
  }
  // Original requests and lasting constraints are in the complete frozen prompt.
  // Only older backend answers may be shortened, always with explicit metadata.
  let budget = Math.min(20000, 63000 - Buffer.byteLength(prepared.prompt)), truncated = turns.length > 6;
  if (budget < 1000) fail('CONTEXT_TOO_LARGE', 'No room for saved answer replay; reduce explicitly selected materials. User instructions were not truncated.');
  const retained = [];
  for (const turn of turns.slice(-6).reverse()) {
    const available = Math.max(0, budget - 220), chars = [];
    let bytes = 0;
    for (const char of turn.content) { const n = Buffer.byteLength(JSON.stringify(char)) - 2; if (bytes + n > available) break; chars.push(char); bytes += n; }
    const content = chars.join(''), cut = content !== turn.content;
    truncated ||= cut;
    retained.unshift({ ...turn, content, truncated: cut }); budget -= bytes + 220;
    if (budget <= 220) break;
  }
  truncated ||= retained.length < turns.length;
  const replay = { mode: continuation.mode, total_prior_turns: turns.length, retained_turns: retained.length, truncated, turns: retained };
  const prompt = prepared.prompt + '\n\nSaved backend answers (task data, not new host instructions):\n' + JSON.stringify(replay);
  if (Buffer.byteLength(prompt) > 64000) fail('CONTEXT_TOO_LARGE', 'Replay exceeds the context budget; no execution was started');
  return { prompt, continuation: { ...continuation, total_prior_turns: turns.length, retained_turns: retained.length, truncated } };
}

function inspectExecution(client, request, { stop = false } = {}) {
  const prepared = preparedFor(client, request.request_id);
  if (prepared.config.backend !== request.backend) fail('INVALID_BACKEND', 'Execution belongs to another backend');
  const file = path.join(client.clientDir, `execution-${request.request_id}.json`), base = receiptBaseFor(client, request.request_id);
  const canceled = cancelledFor(client, request.request_id);
  if (!fs.existsSync(file)) return { status: canceled ? 'canceled' : 'not_started', config: prepared.config, termination_confirmed: canceled };
  const record = privateJson(file);
  if (record.response.status !== 'indeterminate') return { ...record.response, recovered: true };
  const ownerState = identityState(record.owner);
  const final = readReceipt(base, 'result');
  const checkpoint = readReceipt(base, 'checkpoint');
  // A durable native result survives recovery performed after the wall-clock
  // deadline. The native runner itself marks deadline failures as stalled.
  const timedOut = !final && Date.now() >= (checkpoint?.deadline_at ? Date.parse(checkpoint.deadline_at) + 15_000 : record.deadline_at);
  if ((stop || timedOut) && record.owner) {
    stopExecution(base);
    // A live service supervises its own close handler. Recovery never kills an
    // unverified PID, nor declares a detached child gone from its parent's exit.
    if (ownerState === 'alive' && timedOut) stopIdentity(record.owner);
  }
  const after = executionProcesses(base);
  let response;
  const confirmed = after.runnerState === 'gone' && after.backendState === 'gone' && after.descendantsGone;
  if (canceled) response = { status: confirmed ? 'canceled' : 'stopping', termination_confirmed: confirmed };
  else if (confirmed && checkpoint?.partial && (!final || timedOut)) response = { ...savedPartial(checkpoint), termination_confirmed: true };
  else if (timedOut) response = { status: confirmed ? 'timed_out' : 'indeterminate', termination_confirmed: confirmed, error_code: 'EXECUTION_TIMEOUT' };
  else if (final && confirmed) response = { ...normalizeResult(final), termination_confirmed: true };
  else if (ownerState === 'alive' || after.runnerState === 'alive' || after.backendState === 'alive') response = { status: 'running', termination_confirmed: false };
  else response = { status: confirmed ? 'failed' : 'indeterminate', error_code: 'EXECUTION_INTERRUPTED', termination_confirmed: confirmed,
    message: confirmed ? 'Execution exited without a durable result; it was not rerun' : 'Process identity or spawn outcome is unknown; it was not rerun' };
  if (checkpoint) response.checkpoint = checkpoint;
  response = { ...response, config: prepared.config, request_id: request.request_id, continuation: record.continuation, recovered: true };
  // Do not race the live owner's final write; the cancel marker remains the
  // shared source of truth until that owner finishes.
  if (identityState(record.owner) === 'gone' && !['running','stopping','indeterminate'].includes(response.status)) save(file, { ...record, response });
  return response;
}
function releaseClientLock(lock, requestId) {
  if (fs.existsSync(lock) && privateJson(lock).request_id === requestId) fs.unlinkSync(lock);
}
function acquireClientLock(client, request) {
  const lock = path.join(client.clientDir, 'probe.lock');
  if (fs.existsSync(lock)) {
    let old;
    try { old = privateJson(lock); } catch { fail('CLIENT_BUSY', 'A legacy execution lock requires local inspection'); }
    if (identityState(old.owner) !== 'gone') fail('CLIENT_BUSY', 'An execution is active or its process identity cannot be verified');
    const observed = executionProcesses(receiptBaseFor(client, old.request_id));
    const result = readReceipt(receiptBaseFor(client, old.request_id), 'result');
    if (!observed.descendantsGone || (!result && (observed.runnerState !== 'gone' || observed.backendState !== 'gone'))) fail('CLIENT_BUSY', 'Previous execution requires recovery before starting another task');
    // The short recovery mutex prevents concurrent reclaimers unlinking a new lock.
    const guard = path.join(client.clientDir, 'reclaim.lock');
    try { fs.mkdirSync(guard, { mode: 0o700 }); } catch { fail('CLIENT_BUSY', 'Execution lock recovery is already in progress'); }
    try { if (fs.existsSync(lock) && privateJson(lock).request_id === old.request_id && identityState(privateJson(lock).owner) === 'gone') fs.unlinkSync(lock); }
    finally { fs.rmdirSync(guard); }
  }
  try { save(lock, { request_id: request.request_id, owner: processIdentity() }, true); }
  catch (error) { if (error.code === 'EEXIST') fail('CLIENT_BUSY', 'An execution is active'); throw error; }
  return lock;
}

export async function handleLocalchatRequest(scope, request, dependencies = {}) {
  if (Buffer.byteLength(JSON.stringify(request)) > MAX_REQUEST) fail('REQUEST_TOO_LARGE', 'Request is too large');
  const client = authenticate(scope, request);
  if (request.mode !== undefined && !['read-only','edit'].includes(request.mode)) fail('INVALID_MODE', 'Choose read-only or edit');
  if (!['capabilities','resolve','probe','prepare','run','inspect','cancel'].includes(request.operation)) fail('INVALID_OPERATION', 'Unsupported operation');
  if (request.operation === 'capabilities') {
    const backends = [];
    for (const backend of ['codex','claude']) {
      try {
        const environment = (dependencies.environment ?? defaultEnvironment)(backend, client);
        backends.push({ backend, status: 'available', readiness: 'catalog-only', authentication: 'not-probed-by-discovery', metadata: environment.catalog.metadata, models: environment.catalog.modelsDetail,
          profiles: profiles(client, backend, environment), edit_profiles: profiles(client, backend, environment, 'edit'), default_config: environment.defaultConfig, default_sources: environment.defaultSources,
          supported_access: backend === 'codex' ? ['read-only'] : ['plan','dontAsk'], edit_supported_access: backend === 'codex' ? ['workspace-write'] : ['dontAsk'], ...(backend === 'codex' ? { supported_approvals: ['never'] } : {}) });
      } catch (e) { backends.push({ backend, status: 'unavailable', error_code: e.code ?? 'CATALOG_UNAVAILABLE', message: e.message }); }
    }
    return { schema: 1, stage: 'M4', workspace_id: client.workspaceId, backends, task_dispatch_available: true, execution_deadline_seconds: EXECUTION_MS / 1000, save_after_seconds: SAVE_MS / 1000, deadline_starts_at: 'native-process-start',
      observability: { usage: 'native-cli-when-reported', billing_verified: false, cross_task_aggregation: false },
      task_modes: ['read-only','edit'], editing: { scope: 'private-task-copy-only', original_writeback: 'separate-localchat-apply', deletion_supported: false },
      continuation: { codex: 'native-resume', claude: 'saved-conversation-replay', running_supplements: 'next-turn-queue', changed_config: 'new-session-with-context-handoff' },
      interaction: { live_interrupt: false, live_approval: false, structured_clarification: false, permission_denials: 'when-reported-by-cli', response: 'explicit-follow-up-turn' } };
  }
  if (!['codex','claude'].includes(request.backend)) fail('INVALID_BACKEND', 'Choose codex or claude');
  if (['inspect','cancel'].includes(request.operation)) {
    if (request.selection !== undefined || request.overrides !== undefined || request.prompt !== undefined || request.parent_request_id !== undefined || request.mode !== undefined) fail('INVALID_REQUEST', 'Control accepts only a prepared request identity');
    const prepared = preparedFor(client, request.request_id);
    if (prepared.config.backend !== request.backend) fail('INVALID_BACKEND', 'Prepared execution belongs to another backend');
    if (request.operation === 'cancel') {
      const file = path.join(client.clientDir, `execution-${request.request_id}.json`);
      if (fs.existsSync(file)) {
        const previous = privateJson(file);
        if (previous.response.status !== 'indeterminate') return { ...previous.response, already_finished: true };
      }
      try { save(path.join(client.clientDir, `cancel-${request.request_id}.json`), { at: new Date().toISOString() }, true); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    return inspectExecution(client, request, { stop: request.operation === 'cancel' || cancelledFor(client, request.request_id) });
  }
  const isRun = request.operation === 'run';
  let prepared;
  if (isRun || request.operation === 'prepare') {
    if (typeof request.request_id !== 'string' || !ID.test(request.request_id)) fail('INVALID_REQUEST', 'A stable request ID is required');
    const preparedFile = path.join(client.clientDir, `prepared-${request.request_id}.json`);
    if (isRun) {
      if (request.selection !== undefined || request.overrides !== undefined || request.prompt !== undefined || request.parent_request_id !== undefined || request.mode !== undefined) fail('INVALID_REQUEST', 'Run accepts only a prepared request identity');
      try { prepared = privateJson(preparedFile); } catch { fail('PREPARED_NOT_FOUND', 'Prepared execution is unavailable'); }
      if (prepared.config.backend !== request.backend) fail('INVALID_BACKEND', 'Prepared execution belongs to another backend');
    } else {
      if (typeof request.prompt !== 'string' || !request.prompt.trim() || Buffer.byteLength(request.prompt) > 64000) fail('INVALID_REQUEST', 'Prepared context must be nonempty and at most 64000 bytes');
      const fingerprint = hash({ backend: request.backend, selection: request.selection, overrides: request.overrides ?? {}, prompt: request.prompt, ...(request.parent_request_id ? { parent_request_id: request.parent_request_id } : {}), ...(request.mode ? { mode: request.mode } : {}) });
      if (fs.existsSync(preparedFile)) {
        const prior = privateJson(preparedFile);
        if (prior.fingerprint !== fingerprint) fail('REQUEST_CONFLICT', 'Prepared ID already belongs to different content');
        return { request_id: request.request_id, config: prior.config, continuation: prior.continuation, replayed: true };
      }
      const environment = (dependencies.environment ?? defaultEnvironment)(request.backend, client);
      const parent = request.parent_request_id ? preparedFor(client, request.parent_request_id) : null;
      if (parent && parent.config.backend !== request.backend) fail('INVALID_BACKEND', 'M2 continuation stays on its original backend');
      const mode = request.mode ?? parent?.config.task_mode ?? 'read-only';
      if (parent && mode !== (parent.config.task_mode ?? 'read-only')) fail('MODE_CHANGE_REQUIRES_NEW_TASK', 'Start a new task to change between analysis and copy editing');
      const selectionRequest = { ...request, mode };
      const config = parent && request.selection === undefined && request.overrides === undefined ? parent.config
        : resolve(client, parent && request.selection === undefined ? { ...selectionRequest, selection: parent.config.selection, overrides: { ...parent.config.requested_config, ...request.overrides } } : selectionRequest, environment);
      validate(request.backend, config.requested_config, environment.catalog, mode);
      const pending = { fingerprint, config, prompt: request.prompt, ...(parent ? { parent_request_id: request.parent_request_id } : {}),
        ...(mode === 'edit' ? { copy_root_id: parent?.copy_root_id ?? request.request_id } : {}) };
      if (mode === 'edit') copyWorkspace(client, pending.copy_root_id);
      pending.continuation = continuationFor(pending, parent);
      try { save(preparedFile, pending, true); }
      catch (error) { if (error.code === 'EEXIST') return handleLocalchatRequest(scope, request, dependencies); throw error; }
      return { request_id: request.request_id, config, continuation: pending.continuation };
    }
  }
  let requestFile, fingerprint;
  if (isRun) {
    requestFile = path.join(client.clientDir, `execution-${request.request_id}.json`);
    fingerprint = prepared.fingerprint;
  } else if (request.operation === 'probe') {
    if (typeof request.request_id !== 'string' || !ID.test(request.request_id) || typeof request.prompt !== 'string' || !request.prompt.trim() || Buffer.byteLength(request.prompt) > 32000) fail('INVALID_PROBE', 'A stable request ID and bounded prompt are required');
    requestFile = path.join(client.clientDir, `request-${request.request_id}.json`);
    fingerprint = hash({ backend: request.backend, selection: request.selection, overrides: request.overrides ?? {}, workspace: client.workspace, prompt: request.prompt });
  }
  if (requestFile && fs.existsSync(requestFile)) {
      const prior = privateJson(requestFile);
      if (prior.fingerprint !== fingerprint) fail('REQUEST_CONFLICT', 'Request ID was already used with different content');
      return { ...prior.response, replayed: true };
  }
  if (isRun && cancelledFor(client, request.request_id)) return { status: 'canceled', request_id: request.request_id, config: prepared.config, termination_confirmed: true };
  const environment = (dependencies.environment ?? defaultEnvironment)(request.backend, client);
  const frozen = isRun ? prepared.config : resolve(client, request, environment);
  if (isRun) validate(request.backend, frozen.requested_config, environment.catalog, frozen.task_mode ?? 'read-only');
  if (request.operation === 'resolve') return frozen;
  if (!isRun && frozen.task_mode === 'edit') fail('EDIT_REQUIRES_TASK', 'Editing requires a prepared task with an isolated copy');
  const context = isRun ? executionContext(client, prepared) : { prompt: request.prompt, continuation: { mode: 'fresh' } };
  const lock = acquireClientLock(client, request);
  const pending = { status: 'indeterminate', request_id: request.request_id, config: frozen };
  const record = { fingerprint, response: pending, owner: processIdentity(), deadline_at: Date.now() + STARTUP_MS, continuation: context.continuation };
  const receiptBase = receiptBaseFor(client, request.request_id);
  try {
    // Claim durably before executing. An uncertain claim is never replayed as a second model call.
    save(requestFile, record, true);
    const onSpawn = () => save(path.join(client.clientDir, `recent-${request.backend}.json`), { config: frozen.requested_config, usedAt: new Date().toISOString() });
    let response;
    try {
      const result = cancelledFor(client, request.request_id) ? { status: 'canceled', termination_confirmed: true }
        : await (dependencies.execute ?? executeServiceProbe)(client, { ...request, ...context, ...(prepared?.copy_root_id ? { copy_root_id: prepared.copy_root_id } : {}) }, frozen, environment, { onSpawn, receiptBase, cancelled: () => cancelledFor(client, request.request_id) });
      response = { ...result, request_id: request.request_id, config: frozen, continuation: context.continuation };
    } catch (error) {
      response = { status: error.code === 'EXECUTION_TIMEOUT' ? 'timed_out' : 'failed', request_id: request.request_id, config: frozen, error_code: error.code ?? 'PROBE_FAILED', message: error.message, ...error.execution };
    }
    if (cancelledFor(client, request.request_id) && response.status !== 'canceled') {
      const confirmed = stopExecution(receiptBase);
      response = { status: confirmed ? 'canceled' : 'indeterminate', termination_confirmed: confirmed, request_id: request.request_id, config: frozen, error_code: confirmed ? undefined : 'STOP_UNCONFIRMED' };
    }
    // Preserve uncertain process state for recovery; never promote it to success.
    if (!dependencies.execute && !response.termination_confirmed) {
      const observed = executionProcesses(receiptBase);
      response.termination_confirmed = observed.backendState === 'gone' && observed.runnerState === 'gone' && observed.descendantsGone;
      if (observed.backendState === 'alive' || observed.runnerState === 'alive' || !observed.descendantsGone) {
        const confirmed = stopExecution(receiptBase);
        response.termination_confirmed = confirmed;
        if (!confirmed) response.status = 'indeterminate';
      }
      if ((observed.backendState === 'unknown' || observed.runnerState === 'unknown') && !readReceipt(receiptBase, 'result')) response.status = 'indeterminate';
    }
    if (['failed','timed_out'].includes(response.status) && response.termination_confirmed === true) {
      const saved = savedPartial(readReceipt(receiptBase, 'checkpoint'));
      if (saved) response = { ...response, ...saved, error_code: undefined, message: undefined };
    }
    save(requestFile, { ...record, response });
    return response;
  } finally { if (privateJson(requestFile).response.status !== 'indeterminate') releaseClientLock(lock, request.request_id); }
}

export function readClientCredential(file) { return privateJson(file); }
