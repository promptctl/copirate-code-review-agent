'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { codexAdapter } = require('../src/engine/codex');
const { claudeCodeAdapter } = require('../src/engine/claude-code');
const {
  computeOpenAiCostUsd,
  renderCostLine,
  costWarning,
  formatTokenCount,
  OPENAI_PRICES_PER_MILLION,
} = require('../src/usage');

const CODEX_CONFIG = {
  name: 'codex-mini',
  engine: 'codex',
  model: 'gpt-5.4-mini',
  endpoint: { kind: 'openai-responses', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-x' },
};

const ZAI_CONFIG = {
  name: 'zai-glm',
  engine: 'claude-code',
  model: 'glm-5.1',
  endpoint: { kind: 'anthropic-messages', baseUrl: 'https://api.z.ai/api/anthropic', apiKey: 'k' },
};

// --- computeOpenAiCostUsd ---

describe('computeOpenAiCostUsd', () => {
  test('prices non-cached input, cached input, and output at their distinct rates', () => {
    // gpt-5.4-mini: input 0.75, cachedInput 0.075, output 4.50 (per 1M).
    // 6,000 non-cached in @0.75 + 4,000 cached @0.075 + 2,000 out @4.50 = 13,800 / 1e6.
    const cost = computeOpenAiCostUsd(
      { inputTokens: 10_000, outputTokens: 2_000, cachedInputTokens: 4_000 },
      'gpt-5.4-mini',
    );
    assert.ok(Math.abs(cost - 0.0138) < 1e-9, `expected ~0.0138, got ${cost}`);
  });

  test('treats absent cached tokens as zero (all input billed at full rate)', () => {
    const cost = computeOpenAiCostUsd({ inputTokens: 1_000_000, outputTokens: 0 }, 'gpt-5.5');
    assert.equal(cost, 5.00);
  });

  test('returns null for a model with no price-table entry — never a fabricated zero', () => {
    assert.equal(computeOpenAiCostUsd({ inputTokens: 100, outputTokens: 100 }, 'gpt-unknown'), null);
  });

  test('every codex-supported model has a price-table entry', () => {
    for (const model of ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini']) {
      assert.ok(OPENAI_PRICES_PER_MILLION[model], `missing price for ${model}`);
    }
  });
});

// --- codexAdapter.extractUsage (real codex exec --json shape) ---

describe('codexAdapter.extractUsage', () => {
  test('reads usage from the final turn.completed and computes USD from the price table', () => {
    const stdout = [
      '{"type":"thread.started","thread_id":"abc"}',
      '{"type":"turn.completed","usage":{"input_tokens":5000,"cached_input_tokens":1000,"output_tokens":500,"reasoning_output_tokens":200}}',
    ].join('\n');
    const usage = codexAdapter.extractUsage(stdout, CODEX_CONFIG);
    assert.equal(usage.inputTokens, 5000);
    assert.equal(usage.outputTokens, 500);
    assert.equal(usage.cost.available, true);
    // (4000*0.75 + 1000*0.075 + 500*4.50)/1e6 = (3000 + 75 + 2250)/1e6 = 0.005325
    assert.ok(Math.abs(usage.cost.usd - 0.005325) < 1e-9, `got ${usage.cost.usd}`);
  });

  test('the last turn.completed wins when several are emitted', () => {
    const stdout = [
      '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}',
      '{"type":"turn.completed","usage":{"input_tokens":9000,"output_tokens":300}}',
    ].join('\n');
    const usage = codexAdapter.extractUsage(stdout, CODEX_CONFIG);
    assert.equal(usage.inputTokens, 9000);
    assert.equal(usage.outputTokens, 300);
  });

  test('cost is unavailable with reason no-price (tokens still reported) when the model has no price', () => {
    const stdout = '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":10}}';
    const usage = codexAdapter.extractUsage(stdout, { ...CODEX_CONFIG, model: 'gpt-future' });
    assert.equal(usage.inputTokens, 100);
    assert.deepEqual(usage.cost, { available: false, reason: 'no-price' });
  });

  test('returns null when no turn.completed carries usage', () => {
    const stdout = '{"type":"thread.started","thread_id":"abc"}';
    assert.equal(codexAdapter.extractUsage(stdout, CODEX_CONFIG), null);
  });

  test('an empty usage object is reported as no usage, not a $0.00 run', () => {
    const stdout = '{"type":"turn.completed","usage":{}}';
    assert.equal(codexAdapter.extractUsage(stdout, CODEX_CONFIG), null);
  });
});

// --- claudeCodeAdapter.extractUsage (real -p --output-format json envelope) ---

describe('claudeCodeAdapter.extractUsage', () => {
  test('reads provider-reported total_cost_usd and sums all input-side token fields', () => {
    const stdout = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'done',
      total_cost_usd: 0.0123,
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_input_tokens: 4000,
        cache_creation_input_tokens: 250,
      },
    });
    const usage = claudeCodeAdapter.extractUsage(stdout);
    assert.equal(usage.inputTokens, 1000 + 4000 + 250);
    assert.equal(usage.outputTokens, 500);
    assert.deepEqual(usage.cost, { available: true, usd: 0.0123 });
  });

  test('cost is unavailable with reason not-reported when the envelope omits total_cost_usd', () => {
    const stdout = JSON.stringify({ type: 'result', usage: { input_tokens: 10, output_tokens: 5 } });
    const usage = claudeCodeAdapter.extractUsage(stdout);
    assert.equal(usage.inputTokens, 10);
    assert.deepEqual(usage.cost, { available: false, reason: 'not-reported' });
  });

  test('returns null when the envelope has no usage', () => {
    assert.equal(claudeCodeAdapter.extractUsage('{"type":"result","result":"x"}'), null);
  });

  test('returns null when stdout is not a parseable envelope', () => {
    assert.equal(claudeCodeAdapter.extractUsage('not json at all'), null);
  });
});

// --- renderCostLine (pure formatting) ---

describe('renderCostLine', () => {
  test('renders dollars, comma-grouped tokens, and the engine/model tag', () => {
    const line = renderCostLine({ inputTokens: 12345, outputTokens: 6789, cost: { available: true, usd: 0.0123 } }, CODEX_CONFIG);
    assert.match(line, /\$0\.0123/);
    assert.match(line, /12,345 in \/ 6,789 out tokens/);
    assert.match(line, /codex\/gpt-5\.4-mini/);
  });

  test('marks the z.ai endpoint cost as an Anthropic-priced estimate', () => {
    const line = renderCostLine({ inputTokens: 100, outputTokens: 50, cost: { available: true, usd: 0.5 } }, ZAI_CONFIG);
    assert.match(line, /Anthropic pricing, not z\.ai billing/);
  });

  test('shows cost as "unknown" (tokens still rendered) when cost is unavailable', () => {
    const line = renderCostLine({ inputTokens: 100, outputTokens: 50, cost: { available: false, reason: 'no-price' } }, CODEX_CONFIG);
    assert.match(line, /Cost: unknown/);
    assert.match(line, /100 in \/ 50 out tokens/);
  });

  test('returns empty string when there is no usage at all', () => {
    assert.equal(renderCostLine(null, CODEX_CONFIG), '');
  });
});

describe('costWarning', () => {
  test('null when cost is reported — no warning for a fully-priced run', () => {
    assert.equal(costWarning({ inputTokens: 1, outputTokens: 1, cost: { available: true, usd: 0.1 } }, CODEX_CONFIG), null);
  });

  test('no-price names the price table and the model to add', () => {
    const w = costWarning({ inputTokens: 1, outputTokens: 1, cost: { available: false, reason: 'no-price' } }, { ...CODEX_CONFIG, model: 'gpt-future' });
    assert.match(w, /price-table entry for codex\/gpt-future/);
    assert.match(w, /OPENAI_PRICES_PER_MILLION/);
  });

  test('not-reported names the engine, never the price table — the codex/claude causes do not conflate', () => {
    const w = costWarning({ inputTokens: 1, outputTokens: 1, cost: { available: false, reason: 'not-reported' } }, ZAI_CONFIG);
    assert.match(w, /claude-code reported no cost/);
    assert.doesNotMatch(w, /price-table|OPENAI_PRICES_PER_MILLION/);
  });

  test('no usage at all warns that the cost line is omitted', () => {
    assert.match(costWarning(null, CODEX_CONFIG), /no token usage/);
  });
});

describe('formatTokenCount', () => {
  test('groups thousands', () => {
    assert.equal(formatTokenCount(1234567), '1,234,567');
    assert.equal(formatTokenCount(0), '0');
  });
});
