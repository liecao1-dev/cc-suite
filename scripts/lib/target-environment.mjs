import { withoutClaudeEnvironmentAuth } from './claude-oauth-refresh.mjs';

// Shared by the composer broker and the explicitly registered service entry.
// These are host identity hints, not a way to remove an OS sandbox.
export function cleanTargetEnvironment(base = process.env) {
  const env = withoutClaudeEnvironmentAuth(base);
  for (const key of Object.keys(env)) {
    if (key.startsWith('CC_SUITE_COMPOSER_') || key.startsWith('CC_SUITE_DISPATCH_BROKER_') || key === 'CC_SUITE_PROGRAMMATIC_BROKER_GRANT') delete env[key];
  }
  for (const key of ['CODEX_CI','CODEX_SANDBOX','CODEX_SESSION_ID','CODEX_SHELL','CODEX_THREAD_ID','CODEX_TOOLKIT_BACKGROUND_JOB_ID','CODEX_TOOLKIT_SESSION_ID','CLAUDECODE','CLAUDE_CODE','CLAUDE_CODE_ENTRYPOINT','CLAUDE_CODE_REMOTE','CLAUDE_CODE_SESSION_ID','CLAUDE_CODE_SSE_HOST','CLAUDE_CODE_SSE_PORT','CC_SUITE_SCOPE_ROOT','CC_SUITE_WORKSPACE_ROOT']) delete env[key];
  return env;
}
