import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getDispatchEnvironment } from './dispatch-catalog.mjs';
import { buildDispatchProfiles, validateAgainstCatalog, defaultEffortForModel } from './dispatch-config.mjs';
import { resolveActivatedCliBinary, inspectCodexCliCapabilities } from './activated-cli.mjs';
import { cleanTargetEnvironment } from './target-environment.mjs';
import { codexReadonlyConfig } from './localchat-policy.mjs';
import { terminateProcessTree, waitForExit } from './process.mjs';

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
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.uid !== process.getuid?.() || stat.size > MAX_REQUEST * 8) {
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
    object(preset, ['id', 'label', 'backend', 'config']);
    if (typeof preset.id !== 'string' || !ID.test(preset.id) || names.has(preset.id) || !['codex','claude'].includes(preset.backend)
        || (preset.label !== undefined && (typeof preset.label !== 'string' || !preset.label.trim() || preset.label.length > 120))) fail('INVALID_PRESETS', 'Invalid preset identity');
    names.add(preset.id);
    object(preset.config, ['model','effort','access','approval']);
    if (Object.values(preset.config).some(value => typeof value !== 'string') || !preset.config.model || !preset.config.effort) fail('INVALID_PRESETS', 'Preset model and effort must be explicit strings');
    enforceReadonly(preset.backend, preset.config);
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
  object(request, ['schema','client_id','token','operation','backend','selection','overrides','request_id','prompt','workspace_id']);
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
    fail('CONFIG_NOT_ALLOWED', 'M0 Codex supports read-only with approval=never');
  }
  if (backend === 'claude' && (!['plan','dontAsk'].includes(config.access) || config.approval !== undefined)) {
    fail('CONFIG_NOT_ALLOWED', 'M0 Claude supports plan or dontAsk with read-only tools');
  }
}
function validate(backend, config, catalog) {
  object(config, ['model','effort','access','approval']);
  if (backend === 'claude' && config.approval !== undefined) fail('CONFIG_NOT_ALLOWED', 'Claude does not accept a Codex approval policy');
  let normalized;
  try { normalized = validateAgainstCatalog(backend, config, catalog); }
  catch (e) { fail('INVALID_CONFIG', e.message); }
  enforceReadonly(backend, normalized);
  return normalized;
}

function defaultEnvironment(backend, client) {
  const binary = resolveActivatedCliBinary(client.scope, backend);
  const environment = getDispatchEnvironment(backend, client.workspace, { workspaceRoot: client.workspace, cliBinary: binary, scopeRoot: client.scope });
  return { ...environment, binary };
}
function profiles(client, backend, environment) {
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
  for (const preset of client.presets.filter(x => x.backend === backend)) {
    rows.push({ id: `preset:${preset.id}`, label: preset.label ?? preset.id, config: preset.config, source: 'registered localchat preset' });
  }
  return rows.map(row => {
    try { validate(backend, row.config, environment.catalog); return { ...row, enabled: true }; }
    catch (e) { return { ...row, enabled: false, unavailable_reason: e.message }; }
  });
}
function resolve(client, request, environment) {
  if (typeof request.selection !== 'string') fail('SELECTION_REQUIRED', 'Select recent, default, a model row, or a named preset');
  object(request.overrides ?? {}, ['model','effort','access','approval']);
  const row = profiles(client, request.backend, environment).find(x => x.id === request.selection);
  if (!row) fail('UNKNOWN_PROFILE', 'Configuration selection is unavailable');
  const requested = validate(request.backend, { ...row.config, ...request.overrides }, environment.catalog);
  const sources = Object.fromEntries(Object.keys(requested).map(key => [key,
    Object.hasOwn(request.overrides ?? {}, key) ? 'explicit override' : `${row.id}: ${row.source ?? 'cc-suite catalog'}`]));
  return {
    schema: 1, workspace_id: client.workspaceId, backend: request.backend, selection: row.id,
    requested_config: requested,
    effective_config: { ...requested, filesystem: 'authorized-workspace-read-only', ...(request.backend === 'claude' ? { tools: ['Read'] } : { permission_profile: 'localchat-read' }) },
    profile_revision: hash({ row, overrides: request.overrides ?? {}, requested }),
    resolved_at: new Date().toISOString(), sources, default_sources: environment.defaultSources,
    model_resolution: { requested: requested.model, reported: null, status: 'not-reported-by-runner' },
    cli_version: environment.catalog.metadata.codexVersion ?? environment.catalog.metadata.claudeVersion ?? null,
  };
}

function prepareCodexHome(client) {
  const home = path.join(client.clientDir, 'codex-home');
  privateDirectory(home);
  const original = path.join(os.homedir(), '.codex/auth.json');
  const reference = path.join(home, 'auth.json');
  if (!fs.existsSync(original)) fail('AUTH_REQUIRED', 'Native Codex file login is unavailable; no API credentials are created');
  if (fs.existsSync(reference)) {
    if (!fs.lstatSync(reference).isSymbolicLink() || fs.realpathSync(reference) !== fs.realpathSync(original)) fail('AUTH_REFERENCE_CHANGED', 'Codex login reference changed; inspect it locally before continuing');
  } else fs.symlinkSync(original, reference);
  const config = path.join(home, 'config.toml');
  fs.writeFileSync(config, codexReadonlyConfig(client.workspace), { mode: 0o600 });
  return home;
}

export function executeServiceProbe(client, request, frozen, environment, { onSpawn = () => {} } = {}) {
  const policy = { schema: 1, mode: 'read-only', workspace: client.workspace, target: request.backend };
  const env = cleanTargetEnvironment(process.env);
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL']) delete env[key];
  // This authenticated entry owns its lifecycle; it never borrows a composer identity.
  for (const key of Object.keys(env)) if (/^CC_SUITE_(COMPOSER|DISPATCH_BROKER|PROGRAMMATIC|REQUEST|LOCALCHAT)/.test(key)) delete env[key];
  env.CC_SUITE_SCOPE_ROOT = client.scope;
  env.CC_SUITE_WORKSPACE_ROOT = client.workspace;
  env.CLAUDE_PLUGIN_DATA = path.join(client.scope, '.cc-suite/runtime');
  env.CC_SUITE_LOCALCHAT_POLICY_FD = '3';
  if (request.backend === 'codex') {
    const capabilities = inspectCodexCliCapabilities(environment.binary);
    if (!capabilities.ok) fail('CLI_INCOMPATIBLE', capabilities.problems.join('; '));
    policy.codexHome = prepareCodexHome(client);
    env.CODEX_HOME = policy.codexHome;
  }
  const config = frozen.requested_config;
  const args = [path.join(SOURCE_ROOT, `scripts/${request.backend}-runner.mjs`), '--kind', `${request.backend}-localchat-m0`, '--model', config.model, '--effort', config.effort,
    ...(request.backend === 'codex' ? ['--sandbox', config.access, '--approval', config.approval] : ['--permission-mode', config.access]),
    '--timeout-ms', '180000', '--prompt-stdin'];
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, args, { cwd: client.workspace, env, stdio: ['pipe','pipe','pipe','pipe'], detached: true });
    let stdout = '', stderr = '', timedOut = false, overflow = false;
    const kill = () => { try { terminateProcessTree(child.pid, { signal: 'SIGTERM' }); if (waitForExit([child.pid], 1000).size) terminateProcessTree(child.pid, { signal: 'SIGKILL' }); } catch {} };
    const timer = setTimeout(() => { timedOut = true; kill(); }, 195000);
    const stop = () => kill();
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
    const cleanup = () => { clearTimeout(timer); process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdin.on('error', () => {}); child.stdio[3].on('error', () => {});
    child.stdio[3].end(JSON.stringify(policy)); child.stdin.end(request.prompt);
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 2 * 1024 * 1024) { overflow = true; kill(); } });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
    child.once('error', error => { cleanup(); reject(new ServiceError('RUNNER_UNAVAILABLE', error.code ?? 'Cannot start runner')); });
    child.once('close', code => {
      cleanup();
      if (timedOut || overflow) return reject(new ServiceError(timedOut ? 'PROBE_TIMEOUT' : 'RESULT_TOO_LARGE', 'Probe stopped without a confirmed result'));
      let result;
      try { result = JSON.parse(stdout); } catch { return reject(new ServiceError('RUNNER_FAILED', 'Runner returned no structured result; inspect private local logs')); }
      if (result.cliStarted === true) onSpawn();
      if (code !== 0 || result.status !== 'completed' || typeof result.rawOutput !== 'string' || !result.rawOutput.trim()) {
        const message = result.error ?? result.errorMessage ?? 'Execution did not complete';
        const code = /401|oauth|not logged|authentication|login required/i.test(message) ? 'AUTH_REQUIRED'
          : /429|quota|usage limit|rate.limit/i.test(message) ? 'QUOTA_OR_RATE_LIMIT'
          : /sandbox|permission denied|not permitted/i.test(message) ? 'PERMISSION_DENIED' : 'PROBE_FAILED';
        return reject(new ServiceError(code, message));
      }
      resolveResult({ status: 'completed', raw_output: result.rawOutput, backend_session_id: result.threadId ?? null, job_id: result.jobId ?? null });
    });
  });
}

export async function handleLocalchatRequest(scope, request, dependencies = {}) {
  if (Buffer.byteLength(JSON.stringify(request)) > MAX_REQUEST) fail('REQUEST_TOO_LARGE', 'Request is too large');
  const client = authenticate(scope, request);
  if (!['capabilities','resolve','probe'].includes(request.operation)) fail('INVALID_OPERATION', 'Unsupported M0 operation');
  if (request.operation === 'capabilities') {
    const backends = [];
    for (const backend of ['codex','claude']) {
      try {
        const environment = (dependencies.environment ?? defaultEnvironment)(backend, client);
        backends.push({ backend, status: 'available', readiness: 'catalog-only', authentication: 'not-probed-by-discovery', metadata: environment.catalog.metadata, models: environment.catalog.modelsDetail,
          profiles: profiles(client, backend, environment), default_config: environment.defaultConfig, default_sources: environment.defaultSources,
          supported_access: backend === 'codex' ? ['read-only'] : ['plan','dontAsk'], ...(backend === 'codex' ? { supported_approvals: ['never'] } : {}) });
      } catch (e) { backends.push({ backend, status: 'unavailable', error_code: e.code ?? 'CATALOG_UNAVAILABLE', message: e.message }); }
    }
    return { schema: 1, stage: 'M0', workspace_id: client.workspaceId, backends, task_dispatch_available: false };
  }
  if (!['codex','claude'].includes(request.backend)) fail('INVALID_BACKEND', 'Choose codex or claude');
  let requestFile, fingerprint;
  if (request.operation === 'probe') {
    if (typeof request.request_id !== 'string' || !ID.test(request.request_id) || typeof request.prompt !== 'string' || !request.prompt.trim() || Buffer.byteLength(request.prompt) > 32000) fail('INVALID_PROBE', 'A stable request ID and bounded prompt are required');
    requestFile = path.join(client.clientDir, `request-${request.request_id}.json`);
    fingerprint = hash({ backend: request.backend, selection: request.selection, overrides: request.overrides ?? {}, workspace: client.workspace, prompt: request.prompt });
    if (fs.existsSync(requestFile)) {
      const prior = privateJson(requestFile);
      if (prior.fingerprint !== fingerprint) fail('REQUEST_CONFLICT', 'Request ID was already used with different content');
      return { ...prior.response, replayed: true };
    }
  }
  const environment = (dependencies.environment ?? defaultEnvironment)(request.backend, client);
  const frozen = resolve(client, request, environment);
  if (request.operation === 'resolve') return frozen;
  const lock = path.join(client.clientDir, 'probe.lock');
  let lockFd;
  try { lockFd = fs.openSync(lock, 'wx', 0o600); } catch { fail('CLIENT_BUSY', 'A probe is active or requires local recovery; nothing was restarted'); }
  const pending = { status: 'indeterminate', request_id: request.request_id, config: frozen };
  try {
    // Claim durably before executing. An uncertain claim is never replayed as a second model call.
    save(requestFile, { fingerprint, response: pending }, true);
    const onSpawn = () => save(path.join(client.clientDir, `recent-${request.backend}.json`), { config: frozen.requested_config, usedAt: new Date().toISOString() });
    let response;
    try {
      const result = await (dependencies.execute ?? executeServiceProbe)(client, request, frozen, environment, { onSpawn });
      response = { ...result, request_id: request.request_id, config: frozen };
    } catch (error) {
      response = { status: 'failed', request_id: request.request_id, config: frozen, error_code: error.code ?? 'PROBE_FAILED', message: error.message };
    }
    save(requestFile, { fingerprint, response });
    return response;
  } finally { fs.closeSync(lockFd); fs.unlinkSync(lock); }
}

export function readClientCredential(file) { return privateJson(file); }
