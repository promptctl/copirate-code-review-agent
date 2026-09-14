'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const claudeCode = require('../src/engine/claude-code');
const codex = require('../src/engine/codex');
const opencode = require('../src/engine/opencode');

// [LAW:behavior-not-structure] The contract every engine's live meter holds: fed an engine's stream line
// by line, its last reading is the spawn's running total in THE TOKEN RECORD's classes — the same
// figure extractUsage reports for that stream, so the token cap and the review footer count one thing.
function lastReading(meter, lines) {
  let last = null;
  for (const line of lines) {
    const reading = meter(line);
    if (reading) last = reading;
  }
  return last;
}

describe('claude-code meterUsage', () => {
  const usage = (input, write, read, output) => ({ input_tokens: input, cache_creation_input_tokens: write, cache_read_input_tokens: read, output_tokens: output });
  // stream-json repeats a message's usage on every content-block event of that message.
  const stream = [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    JSON.stringify({ type: 'assistant', message: { id: 'msg_1', usage: usage(10, 1_000, 0, 5) } }),
    JSON.stringify({ type: 'assistant', message: { id: 'msg_1', usage: usage(10, 1_000, 0, 40) } }),
    JSON.stringify({ type: 'user', message: { content: [] } }),
    JSON.stringify({ type: 'assistant', message: { id: 'msg_2', usage: usage(3, 200, 1_000, 60) } }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, usage: usage(13, 1_200, 1_000, 100), total_cost_usd: 0.01 }),
  ];

  test('counts each message once, at its latest usage — never once per content block', () => {
    assert.deepEqual(lastReading(claudeCode.meterUsage(), stream), { inputCacheMiss: 1_213, inputCacheHit: 1_000, output: 100 });
  });

  test('agrees with extractUsage on the same stream', () => {
    const config = { model: 'claude-sonnet-5', endpoint: { baseUrl: 'https://api.anthropic.com', credential: { kind: 'api-key', value: 'k' } } };
    const { tokens } = claudeCode.extractUsage(stream.join('\n'), config, new Date('2026-09-14T00:00:00Z'));
    assert.deepEqual(lastReading(claudeCode.meterUsage(), stream), tokens);
  });

  test('a line that is not a usage event reads as nothing', () => {
    const meter = claudeCode.meterUsage();
    assert.equal(meter('not json'), null);
    assert.equal(meter(JSON.stringify({ type: 'assistant', message: { id: 'm' } })), null);
  });
});

describe('codex meterUsage', () => {
  const request = (inputTokens, cachedInputTokens, outputTokens) => ({ inputTokens, cachedInputTokens, outputTokens });
  const notify = last => JSON.stringify({ jsonrpc: '2.0', method: 'thread/tokenUsage/updated', params: { tokenUsage: { last } } });
  const requests = [request(16_000, 12_000, 300), request(17_000, 16_000, 500)];
  const stream = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }),
    notify(requests[0]),
    JSON.stringify({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: {} }),
    notify(requests[1]),
    JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { turn: { status: 'completed' } } }),
  ];

  test('sums every request, and agrees with extractUsage over the same requests', () => {
    const { tokens } = codex.extractUsage({ requests }, { model: 'gpt-5.4-mini' }, new Date('2026-09-14T00:00:00Z'));
    assert.deepEqual(lastReading(codex.meterUsage(), stream), tokens);
    assert.deepEqual(tokens, { inputCacheMiss: 5_000, inputCacheHit: 28_000, output: 800 });
  });

  test('a usage notification it cannot read throws, so the spawn is stopped loudly rather than uncounted', () => {
    const meter = codex.meterUsage();
    assert.throws(() => meter(JSON.stringify({ jsonrpc: '2.0', method: 'thread/tokenUsage/updated', params: {} })), /carried no request usage/);
  });
});

describe('opencode meterUsage', () => {
  const step = (tokens, reason = 'tool-calls') => JSON.stringify({ type: 'step_finish', part: { type: 'step-finish', reason, tokens } });
  const stream = [
    JSON.stringify({ type: 'text', part: { text: 'hi' } }),
    step({ input: 100, output: 10, reasoning: 5, cache: { read: 50, write: 20 } }),
    step({ input: 60, output: 8 }, 'stop'),
  ];

  test('sums every step, and agrees with extractUsage on the same stream', () => {
    const { tokens } = opencode.extractUsage(stream.join('\n'));
    assert.deepEqual(lastReading(opencode.meterUsage(), stream), tokens);
    assert.deepEqual(tokens, { inputCacheMiss: 180, inputCacheHit: 50, output: 23 });
  });
});
