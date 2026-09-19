import fs from 'node:fs';
import path from 'node:path';
import { validateReceiptBase } from './localchat-receipts.mjs';
import { withDelegationBoundary, withClaudeDelegationBoundary } from './delegation-boundary.mjs';

export function localchatPrompt(target, prompt) {
  const wrapped = target === 'codex' ? withDelegationBoundary(prompt) : withClaudeDelegationBoundary(prompt);
  return wrapped.replace(/^This request already reached you by delegation from (Claude Code|OpenAI Codex)\./,
    'This request already reached you by delegation from Chat through localchat.');
}

export function readLocalchatPolicy(env = process.env) {
  if (env.CC_SUITE_LOCALCHAT_POLICY_FD === undefined) return null;
  if (env.CC_SUITE_LOCALCHAT_POLICY_FD !== '3') throw new Error('Invalid localchat policy channel');
  const raw = fs.readFileSync(3, 'utf8');
  if (Buffer.byteLength(raw) > 16384) throw new Error('Localchat policy is too large');
  const value = JSON.parse(raw);
  if (value.schema !== 1 || value.mode !== 'read-only' || !path.isAbsolute(value.workspace)) {
    throw new Error('Unsupported localchat execution policy');
  }
  if (fs.realpathSync(process.cwd()) !== value.workspace) throw new Error('Localchat workspace mismatch');
  if (value.target === 'codex') {
    if (!path.isAbsolute(value.codexHome) || fs.realpathSync(env.CODEX_HOME) !== value.codexHome) {
      throw new Error('Localchat Codex configuration mismatch');
    }
  } else if (value.target !== 'claude') throw new Error('Invalid localchat target');
  validateReceiptBase(value.receiptBase, value.workspace);
  if (value.resumeSession !== undefined && (value.target !== 'codex' || !/^[a-f0-9-]{16,64}$/i.test(value.resumeSession))) throw new Error('Invalid Localchat continuation');
  return Object.freeze(value);
}

export function codexReadonlyConfig(workspace) {
  return `approval_policy = "never"
default_permissions = "localchat-read"
project_doc_max_bytes = 0
web_search = "disabled"
cli_auth_credentials_store = "file"
[features]
apps = false
browser_use = false
browser_use_external = false
computer_use = false
in_app_browser = false
hooks = false
plugins = false
remote_plugin = false
multi_agent = false
skill_mcp_dependency_install = false
skill_search = false
skip_host_skill_discovery = true
[permissions.localchat-read.filesystem]
":minimal" = "read"
${JSON.stringify(workspace)} = "read"
[permissions.localchat-read.network]
enabled = false
`;
}

export function claudeReadonlySettings(workspace) {
  const root = workspace.replace(/^\/+/, '');
  return {
    permissions: {
      allow: [`Read(//${root}/**)`],
      deny: ['Edit', 'Write', 'Bash', 'Agent', 'Task', 'WebFetch', 'WebSearch'],
      disableAutoMode: 'disable', disableBypassPermissionsMode: 'disable',
    },
    sandbox: {
      enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false,
      filesystem: { allowWrite: [], denyRead: ['/'], allowRead: [workspace] },
    },
  };
}
