import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { processAlive, readProcessStartTime, terminateProcessTree, waitForExit } from './process.mjs';

// These paths arrive only on the service-owned policy pipe, never in model input.
export function writeReceipt(base, kind, value) {
  if (!base) return;
  const file = `${base}.${kind}.json`, tmp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
export function readReceipt(base, kind) {
  const file = `${base}.${kind}.json`;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.uid !== process.getuid?.() || stat.size > 4 * 1024 * 1024) throw new Error('Insecure execution receipt');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export function validateReceiptBase(base, workspace) {
  if (base === undefined) return;
  const parent = path.dirname(base);
  const relative = path.relative(workspace, parent);
  const stat = fs.lstatSync(parent);
  if (!path.isAbsolute(base) || fs.realpathSync(parent) !== parent || !stat.isDirectory() || stat.mode & 0o077 || stat.uid !== process.getuid?.()
      || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
      || !/^receipt-[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(path.basename(base))) throw new Error('Invalid execution receipt path');
}
export function processIdentity(pid = process.pid) { return { pid, pidStartedAt: readProcessStartTime(pid) }; }
export function identityState(identity) {
  if (!Number.isSafeInteger(identity?.pid) || identity.pid <= 0) return 'unknown';
  if (!processAlive(identity.pid)) return 'gone';
  const current = readProcessStartTime(identity.pid);
  if (!identity.pidStartedAt || !current) return 'unknown';
  return current === identity.pidStartedAt ? 'alive' : 'gone';
}
function groupMembers(pid) {
  const result = spawnSync('ps', ['-axo', 'pid=,pgid='], { encoding: 'utf8' });
  if (result.status !== 0) return [];
  return result.stdout.trim().split('\n').map(row => row.trim().split(/\s+/).map(Number))
    .filter(([member, group]) => group === pid && member !== pid).map(([member]) => processIdentity(member));
}
export function stopIdentity(identity) {
  let state = identityState(identity);
  if (state !== 'alive') return state === 'gone';
  const descendants = groupMembers(identity.pid);
  try { terminateProcessTree(identity.pid, { signal: 'SIGTERM' }); } catch { return false; }
  waitForExit([identity.pid], 1000);
  state = identityState(identity);
  if (state === 'unknown') return false;
  const remaining = [identity, ...descendants].filter(p => identityState(p) === 'alive');
  for (const member of remaining) {
    if (identityState(member) !== 'alive') continue;
    try { terminateProcessTree(member.pid, { signal: 'SIGKILL' }); } catch { return false; }
  }
  waitForExit(remaining.map(p => p.pid), 500);
  return [identity, ...descendants].every(p => identityState(p) === 'gone');
}
export function backendPhase(policy, phase, pid) {
  if (!policy?.receiptBase) return;
  writeReceipt(policy?.receiptBase, 'backend', { phase, ...(pid ? processIdentity(pid) : {}), at: new Date().toISOString() });
}
export function executionProcesses(base) {
  const runner = readReceipt(base, 'runner'), backend = readReceipt(base, 'backend');
  const state = receipt => !receipt ? 'unknown' : receipt.phase === 'closed' || receipt.phase === 'not_started' ? 'gone' : identityState(receipt);
  const descendants = readReceipt(base, 'descendants') ?? [];
  return { runner, backend, runnerState: state(runner), backendState: state(backend), descendantsGone: descendants.every(p => identityState(p) === 'gone') };
}
// Stop the detached native CLI first. Killing only its runner can orphan it.
export function stopExecution(base) {
  const before = executionProcesses(base);
  const descendants = [...(readReceipt(base, 'descendants') ?? []),
    ...(before.backendState === 'alive' ? groupMembers(before.backend.pid) : []),
    ...(before.runnerState === 'alive' ? groupMembers(before.runner.pid) : [])];
  writeReceipt(base, 'descendants', descendants);
  if (before.backendState === 'alive') stopIdentity(before.backend);
  if (before.runnerState === 'alive') stopIdentity(before.runner);
  for (const member of descendants) if (identityState(member) === 'alive') stopIdentity(member);
  const after = executionProcesses(base);
  return after.runnerState === 'gone' && after.backendState === 'gone' && after.descendantsGone;
}
export function stopBackend(base) {
  if (!base) return false;
  const { backend, backendState } = executionProcesses(base);
  if (backendState !== 'alive') return backendState === 'gone';
  const members = [...(readReceipt(base, 'descendants') ?? []), ...groupMembers(backend.pid)];
  writeReceipt(base, 'descendants', members);
  const stopped = stopIdentity(backend);
  return stopped && members.every(p => identityState(p) === 'gone');
}
