'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { extractUsage: codexExtractUsage } = require('../src/engine/codex');
const { extractUsage: claudeExtractUsage } = require('../src/engine/claude-code');
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

const DEEPSEEK_CONFIG = {
  name: 'deepseek',
  engine: 'claude-code',
  model: 'deepseek-v4-pro',
  endpoint: { kind: 'anthropic-messages', baseUrl: 'https://api.deepseek.com/anthropic', apiKey: 'k' },
};

// A genuine Anthropic endpoint — the only case where claude-code's total_cost_usd is a usable cost.
const ANTHROPIC_CONFIG = {
  name: 'anthropic',
  engine: 'claude-code',
  model: 'claude-x',
  endpoint: { kind: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', apiKey: 'k' },
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

// --- codexExtractUsage (real codex exec --json shape) ---

describe('codexExtractUsage', () => {
  test('reads usage from the final turn.completed and computes USD from the price table', () => {
    const stdout = [
      '{"type":"thread.started","thread_id":"abc"}',
      '{"type":"turn.completed","usage":{"input_tokens":5000,"cached_input_tokens":1000,"output_tokens":500,"reasoning_output_tokens":200}}',
    ].join('\n');
    const usage = codexExtractUsage(stdout, CODEX_CONFIG);
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
    const usage = codexExtractUsage(stdout, CODEX_CONFIG);
    assert.equal(usage.inputTokens, 9000);
    assert.equal(usage.outputTokens, 300);
  });

  test('cost is unavailable with reason no-price (tokens still reported) when the model has no price', () => {
    const stdout = '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":10}}';
    const usage = codexExtractUsage(stdout, { ...CODEX_CONFIG, model: 'gpt-future' });
    assert.equal(usage.inputTokens, 100);
    assert.deepEqual(usage.cost, { available: false, reason: 'no-price' });
  });

  test('returns null when no turn.completed carries usage', () => {
    const stdout = '{"type":"thread.started","thread_id":"abc"}';
    assert.equal(codexExtractUsage(stdout, CODEX_CONFIG), null);
  });

  test('an empty usage object is reported as no usage, not a $0.00 run', () => {
    const stdout = '{"type":"turn.completed","usage":{}}';
    assert.equal(codexExtractUsage(stdout, CODEX_CONFIG), null);
  });
});

// --- claudeExtractUsage (real -p --output-format json envelope) ---

describe('claudeExtractUsage', () => {
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
    const usage = claudeExtractUsage(stdout, ANTHROPIC_CONFIG);
    assert.equal(usage.inputTokens, 1000 + 4000 + 250);
    assert.equal(usage.outputTokens, 500);
    assert.deepEqual(usage.cost, { available: true, usd: 0.0123 });
  });

  test('cost is unavailable with reason not-reported when a genuine Anthropic envelope omits total_cost_usd', () => {
    const stdout = JSON.stringify({ type: 'result', usage: { input_tokens: 10, output_tokens: 5 } });
    const usage = claudeExtractUsage(stdout, ANTHROPIC_CONFIG);
    assert.equal(usage.inputTokens, 10);
    assert.deepEqual(usage.cost, { available: false, reason: 'not-reported' });
  });

  test('cost is withheld as foreign-endpoint for a non-Anthropic endpoint, even when total_cost_usd is present', () => {
    // [LAW:no-silent-failure] claude-code prices total_cost_usd against Anthropic; for z.ai/deepseek
    // that is the wrong vendor, so the figure must never become a rendered cost — tokens still report.
    const stdout = JSON.stringify({
      type: 'result',
      total_cost_usd: 0.5,
      usage: { input_tokens: 1000, output_tokens: 500 },
    });
    for (const cfg of [ZAI_CONFIG, DEEPSEEK_CONFIG]) {
      const usage = claudeExtractUsage(stdout, cfg);
      assert.equal(usage.inputTokens, 1000);
      assert.equal(usage.outputTokens, 500);
      assert.deepEqual(usage.cost, { available: false, reason: 'foreign-endpoint' });
    }
  });

  test('a lookalike host (notanthropic.com) is classified foreign, not trusted as Anthropic', () => {
    // [LAW:types-are-the-program] regression: endsWith('anthropic.com') wrongly accepted this host.
    const stdout = JSON.stringify({ type: 'result', total_cost_usd: 0.5, usage: { input_tokens: 10, output_tokens: 5 } });
    const lookalike = { engine: 'claude-code', model: 'x', endpoint: { baseUrl: 'https://api.notanthropic.com' } };
    assert.deepEqual(claudeExtractUsage(stdout, lookalike).cost, { available: false, reason: 'foreign-endpoint' });
    // a genuine subdomain still classifies as Anthropic
    const sub = { engine: 'claude-code', model: 'x', endpoint: { baseUrl: 'https://api.anthropic.com' } };
    assert.deepEqual(claudeExtractUsage(stdout, sub).cost, { available: true, usd: 0.5 });
  });

  test('returns null when the envelope has no usage', () => {
    assert.equal(claudeExtractUsage('{"type":"result","result":"x"}', ANTHROPIC_CONFIG), null);
  });

  test('returns null when stdout is not a parseable envelope', () => {
    assert.equal(claudeExtractUsage('not json at all', ANTHROPIC_CONFIG), null);
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

  test('marks every cost as an estimate — codex (list-price table) included, not just claude', () => {
    const line = renderCostLine({ inputTokens: 100, outputTokens: 50, cost: { available: true, usd: 0.5 } }, CODEX_CONFIG);
    assert.match(line, /· est\.$|· est\._$/);
  });

  test('a non-z.ai claude-code run is still marked an estimate (total_cost_usd is client-side)', () => {
    const anthropicConfig = { engine: 'claude-code', model: 'claude-x', endpoint: { baseUrl: 'https://api.anthropic.com' } };
    const line = renderCostLine({ inputTokens: 100, outputTokens: 50, cost: { available: true, usd: 0.5 } }, anthropicConfig);
    assert.match(line, /· est\._$/);
    assert.doesNotMatch(line, /z\.ai/);
  });

  test('a z.ai/deepseek (foreign) claude-code run renders cost as unknown, never a wrong-vendor dollar figure', () => {
    const stdout = JSON.stringify({ type: 'result', total_cost_usd: 0.5, usage: { input_tokens: 100, output_tokens: 50 } });
    for (const cfg of [ZAI_CONFIG, DEEPSEEK_CONFIG]) {
      const line = renderCostLine(claudeExtractUsage(stdout, cfg), cfg);
      assert.match(line, /Cost: unknown/);
      assert.doesNotMatch(line, /\$0\.5/);
    }
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

  test('foreign-endpoint names the non-Anthropic host and explains the withheld cost', () => {
    const w = costWarning({ inputTokens: 1, outputTokens: 1, cost: { available: false, reason: 'foreign-endpoint' } }, DEEPSEEK_CONFIG);
    assert.match(w, /non-Anthropic endpoint \(api\.deepseek\.com\)/);
    assert.match(w, /Anthropic prices/);
    assert.doesNotMatch(w, /OPENAI_PRICES_PER_MILLION/);
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
