#!/usr/bin/env node
import fs from 'node:fs';
import { handleLocalchatRequest, registerLocalchatClient } from './lib/localchat-service.mjs';

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (!['register','request'].includes(command) || argv.length % 2) throw new Error('Use register or request with named arguments');
  const options = {};
  const keys = command === 'register' ? ['scope','workspace','client','credential-file','presets-file'] : ['scope'];
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    if (!argv[i].startsWith('--') || !keys.includes(key) || Object.hasOwn(options, key)) throw new Error('Unsupported or duplicate argument');
    options[key] = argv[i+1];
  }
  if (!options.scope) throw new Error('--scope is required');
  if (command === 'register') return registerLocalchatClient({
    scope: options.scope, workspace: options.workspace, clientId: options.client,
    credentialFile: options['credential-file'],
    presets: options['presets-file'] ? JSON.parse(fs.readFileSync(options['presets-file'], 'utf8')) : [],
  });
  if (process.stdin.isTTY) throw new Error('Service requests require closed non-TTY stdin');
  let bytes = 0;
  const chunks = [];
  const timer = setTimeout(() => { process.stderr.write('Service input timed out\n'); process.exit(2); }, 10000);
  try {
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > 131072) throw new Error('Request is too large');
      chunks.push(chunk);
    }
  } finally { clearTimeout(timer); }
  return handleLocalchatRequest(options.scope, JSON.parse(Buffer.concat(chunks).toString('utf8')));
}
main().then(result => { process.stdout.write(JSON.stringify({ ok: true, result }) + '\n'); }, error => {
  process.stdout.write(JSON.stringify({ ok: false, error: { code: error.code ?? 'SERVICE_ERROR', message: error.code ? error.message : 'Invalid service request or unavailable local configuration' } }) + '\n');
  process.exitCode = 1;
});
