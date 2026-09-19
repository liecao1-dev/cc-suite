const counter = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const amount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

// Forward a numeric allowlist only. Never forward event bodies, tool usage,
// model transcripts, response headers or credentials as telemetry.
export function localchatUsage(backend, event) {
  const terminal = backend === 'codex' ? event?.type === 'turn.completed' : event?.type === 'result';
  const raw = terminal ? event.usage : null;
  const fields = {
    input_tokens: counter(raw?.input_tokens), output_tokens: counter(raw?.output_tokens),
    cached_input_tokens: counter(backend === 'codex' ? raw?.cached_input_tokens : raw?.cache_read_input_tokens),
    cache_write_input_tokens: counter(backend === 'codex' ? raw?.cache_write_input_tokens : raw?.cache_creation_input_tokens),
    reasoning_output_tokens: backend === 'codex' ? counter(raw?.reasoning_output_tokens) : null,
    reported_cost_usd: backend === 'claude' && terminal ? amount(event.total_cost_usd) : null,
  };
  const reported = Object.values(fields).some(value => value !== null);
  return { status: reported ? 'reported' : 'unavailable', source: reported ? (backend === 'codex' ? 'codex.turn.completed' : 'claude.result') : null,
    ...fields, scope: 'native-cli-report', aggregation: 'none', billing_verified: false };
}
