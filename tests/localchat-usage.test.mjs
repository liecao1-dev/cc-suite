import test from 'node:test';
import assert from 'node:assert/strict';
import { localchatUsage } from '../scripts/lib/localchat-usage.mjs';

test('native terminal usage preserves zero, distinguishes missing fields and never infers a bill', () => {
  const codex = localchatUsage('codex', { type: 'turn.completed', usage: { input_tokens: 125, cached_input_tokens: 100, output_tokens: 0, reasoning_output_tokens: 0 } });
  assert.equal(codex.status, 'reported'); assert.equal(codex.input_tokens, 125); assert.equal(codex.output_tokens, 0);
  assert.equal(codex.cache_write_input_tokens, null); assert.equal(codex.reported_cost_usd, null); assert.equal(codex.billing_verified, false);
  const claude = localchatUsage('claude', { type: 'result', total_cost_usd: 0.023, usage: { input_tokens: 20, output_tokens: 40, cache_read_input_tokens: 7, cache_creation_input_tokens: 9 } });
  assert.equal(claude.cached_input_tokens, 7); assert.equal(claude.cache_write_input_tokens, 9); assert.equal(claude.reported_cost_usd, 0.023); assert.equal(claude.reasoning_output_tokens, null);
});

test('nonterminal, malformed and unexpected telemetry stays unavailable without leaking event text', () => {
  for (const backend of ['codex','claude']) {
    assert.equal(localchatUsage(backend, null).status, 'unavailable');
    assert.equal(localchatUsage(backend, { type: 'item.completed', usage: { input_tokens: 1 } }).status, 'unavailable');
    const usage = localchatUsage(backend, { type: backend === 'codex' ? 'turn.completed' : 'result', total_cost_usd: -3,
      usage: { input_tokens: '12', output_tokens: -1, cached_input_tokens: Infinity, cache_creation_input_tokens: 0.5, cache_read_input_tokens: -2, reasoning_output_tokens: NaN, token: 'private' }, result: 'private' });
    assert.equal(usage.status, 'unavailable'); assert(!JSON.stringify(usage).includes('private'));
  }
});
