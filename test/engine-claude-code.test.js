'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  claudeCodeAdapter,
  ZAI_ANTHROPIC_BASE_URL,
  CLAUDE_TIMEOUT_MS,
  buildCommand,
  classifyError,
  assertSucceeded,
  extractUsage,
  parseResultEnvelope,
} = require('../src/engine/claude-code');

// [LAW:verifiable-goals] AC for T3: existing ZAI_* inputs produce a byte-identical
// claude invocation (args + env) to the pre-refactor runClaudeCode + buildClaudeArgs.
// These fixtures are the machine-verifiable record of what "byte-identical" means.

const MOCK_COLLECTOR = { mcpConfigPath: '/tmp/test-mcp-config.json' };
const MOCK_HOME = '/tmp/test-reviewer-home';
const BASE_CONFIG = {
  name: 'zai-compat',
  engine: 'claude-code',
  model: 'claude-sonnet-4-6',
  endpoint: {
    kind: 'anthropic-messages',
    baseUrl: ZAI_ANTHROPIC_BASE_URL,
    apiKey: 'test-api-key-xyz',
  },
};

describe('buildCommand — canonical claude-code args', () => {
  test('command is always "npx"', () => {
    const { command } = buildCommand({
      config: BASE_CONFIG,
      collector: MOCK_COLLECTOR,
      home: MOCK_HOME,
    });
    assert.equal(command, 'npx');
  });

  test('args match the exact order and values', () => {
    const { args } = buildCommand({
      config: BASE_CONFIG,
      collector: MOCK_COLLECTOR,
      home: MOCK_HOME,
    });

    // Canonical arg sequence — stream-json --verbose so every transcript carries thinking/tool calls
    assert.deepEqual(args, [
      '-y',
      '@anthropic-ai/claude-code@2.1.0',
      '-p',
      '--verbose',
      '--output-format',
      'stream-json',
      '--no-session-persistence',
      '--tools',
      'Read,Grep,Glob',
      '--allowedTools',
      'Read,Grep,Glob,mcp__review_collector__request_change,mcp__review_collector__finish_review,mcp__review_collector__add_scope',
      '--disallowedTools',
      'Bash,Edit,Write,WebFetch,WebSearch',
      '--mcp-config',
      '/tmp/test-mcp-config.json',
      '--strict-mcp-config',
      '--permission-mode',
      'dontAsk',
      '--model',
      'claude-sonnet-4-6',
      'Review the pull request instructions and diff from stdin.',
    ]);
  });

  test('omits --model when model is empty string', () => {
    const { args } = buildCommand({
      config: { ...BASE_CONFIG, model: '' },
      collector: MOCK_COLLECTOR,
      home: MOCK_HOME,
    });
    assert.equal(args.includes('--model'), false);
    assert.equal(args.at(-1), 'Review the pull request instructions and diff from stdin.');
  });

  test('omits --append-system-prompt when systemPrompt is absent', () => {
    const { args } = buildCommand({
      config: BASE_CONFIG,
      collector: MOCK_COLLECTOR,
      home: MOCK_HOME,
    });
    assert.equal(args.includes('--append-system-prompt'), false);
  });

  test('--append-system-prompt appears before the prompt string when set', () => {
    const { args } = buildCommand({
      config: { ...BASE_CONFIG, systemPrompt: 'Focus on security.' },
      collector: MOCK_COLLECTOR,
      home: MOCK_HOME,
    });
    const idx = args.indexOf('--append-system-prompt');
    assert.ok(idx !== -1, '--append-system-prompt missing');
    assert.equal(args[idx + 1], 'Focus on security.');
    assert.equal(args.at(-1), 'Review the pull request instructions and diff from stdin.');
  });

  test('mcp-config arg uses collector.mcpConfigPath', () => {
    const { args } = buildCommand({
      config: BASE_CONFIG,
      collector: { mcpConfigPath: '/custom/path/mcp.json' },
      home: MOCK_HOME,
    });
    const idx = args.indexOf('--mcp-config');
    assert.ok(idx !== -1);
    assert.equal(args[idx + 1], '/custom/path/mcp.json');
  });
});

describe('buildCommand — env matches pre-refactor runClaudeCode env', () => {
  test('HOME is set to the provided home directory', () => {
    const { env } = buildCommand({
      config: BASE_CONFIG,
      collector: MOCK_COLLECTOR,
      home: '/custom/home/dir',
    });
    assert.equal(env.HOME, '/custom/home/dir');
  });

  test('ANTHROPIC_AUTH_TOKEN comes from config.endpoint.apiKey', () => {
    const { env } = buildCommand({
      config: BASE_CONFIG,
      collector: MOCK_COLLECTOR,
      home: MOCK_HOME,
    });
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'test-api-key-xyz');
  });

  test('ANTHROPIC_BASE_URL comes from config.endpoint.baseUrl (ZAI URL for compat shim)', () => {
    const { env } = buildCommand({
      config: BASE_CONFIG,
      collector: MOCK_COLLECTOR,
      home: MOCK_HOME,
    });
    assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic');
  });

  test('ANTHROPIC_MODEL is set to config.model', () => {
    const { env } = buildCommand({
      config: BASE_CONFIG,
      collector: MOCK_COLLECTOR,
      home: MOCK_HOME,
    });
    assert.equal(env.ANTHROPIC_MODEL, 'claude-sonnet-4-6');
  });

  test('API_TIMEOUT_MS is set to the string form of CLAUDE_TIMEOUT_MS (3000000)', () => {
    const { env } = buildCommand({
      config: BASE_CONFIG,
      collector: MOCK_COLLECTOR,
      home: MOCK_HOME,
    });
    assert.equal(env.API_TIMEOUT_MS, '3000000');
  });

  test('CLAUDE_CODE_SKIP_PROMPT_HISTORY is "1"', () => {
    const { env } = buildCommand({
      config: BASE_CONFIG,
      collector: MOCK_COLLECTOR,
      home: MOCK_HOME,
    });
    assert.equal(env.CLAUDE_CODE_SKIP_PROMPT_HISTORY, '1');
  });

  test('NO_COLOR is "1"', () => {
    const { env } = buildCommand({
      config: BASE_CONFIG,
      collector: MOCK_COLLECTOR,
      home: MOCK_HOME,
    });
    assert.equal(env.NO_COLOR, '1');
  });

  test('CLAUDE_CODE_EFFORT_LEVEL is absent when reasoning is not set', () => {
    const { env } = buildCommand({
      config: BASE_CONFIG,
      collector: MOCK_COLLECTOR,
      home: MOCK_HOME,
    });
    assert.equal('CLAUDE_CODE_EFFORT_LEVEL' in env, false);
  });

  test('CLAUDE_CODE_EFFORT_LEVEL is set from config.reasoning when present', () => {
    const { env } = buildCommand({
      config: { ...BASE_CONFIG, reasoning: 'high' },
      collector: MOCK_COLLECTOR,
      home: MOCK_HOME,
    });
    assert.equal(env.CLAUDE_CODE_EFFORT_LEVEL, 'high');
  });

  test('env inherits process.env entries', () => {
    const { env } = buildCommand({
      config: BASE_CONFIG,
      collector: MOCK_COLLECTOR,
      home: MOCK_HOME,
    });
    // PATH is always present in process.env; confirms spread is happening
    assert.ok('PATH' in env);
  });
});

describe('claudeCodeAdapter interface declarations', () => {
  test('name is "claude-code"', () => {
    assert.equal(claudeCodeAdapter.name, 'claude-code');
  });

  test('CLAUDE_TIMEOUT_MS is 3000000 (50 minutes)', () => {
    assert.equal(CLAUDE_TIMEOUT_MS, 3_000_000);
  });

  test('endpointKinds contains only "anthropic-messages"', () => {
    assert.deepEqual(claudeCodeAdapter.capabilities.endpointKinds, ['anthropic-messages']);
  });

  test('reasoningEfforts contains the four claude effort levels', () => {
    assert.deepEqual(claudeCodeAdapter.capabilities.reasoningEfforts, ['low', 'medium', 'high', 'max']);
  });

  test('toolNames reference mcp__review_collector__ prefix', () => {
    assert.equal(claudeCodeAdapter.toolNames.requestChange, 'mcp__review_collector__request_change');
    assert.equal(claudeCodeAdapter.toolNames.finishReview, 'mcp__review_collector__finish_review');
  });

  // [LAW:behavior-not-structure] The lifted seam: the public adapter exposes produceReview, not the
  // subprocess primitives (buildCommand/materializeHome/...), which are now CLI-internal and tested
  // directly as exported functions above.
  test('adapter exposes the lifted produceReview interface, not subprocess primitives', () => {
    assert.equal(typeof claudeCodeAdapter.produceReview, 'function');
    assert.equal(claudeCodeAdapter.materializeHome, undefined);
    assert.equal(claudeCodeAdapter.buildCommand, undefined);
  });
});

describe('classifyError', () => {
  const base = new Error('spawn failed');

  test('429 text produces TransientError', () => {
    const { TransientError } = require('../src/failover');
    const result = classifyError(base, 'HTTP 429 Too Many Requests');
    assert.ok(result instanceof TransientError);
    assert.ok(result.message.includes('rate-limited'));
  });

  test('529 text produces TransientError with null retryAfterMs', () => {
    const { TransientError } = require('../src/failover');
    const result = classifyError(base, 'HTTP 529 overloaded');
    assert.ok(result instanceof TransientError);
    assert.equal(result.retryAfterMs, null);
  });

  test('unrelated error is returned unchanged', () => {
    const result = classifyError(base, 'unexpected token at line 42');
    assert.equal(result, base);
  });
});

// claude-code always emits the streaming JSONL form so the full reasoning/tool flow is captured in
// every session transcript — there is no opt-in flag and no plain-json path.
describe('buildCommand — canonical stream-json output format', () => {
  test('always uses --verbose --output-format stream-json (no debug field)', () => {
    const { args } = buildCommand({ config: BASE_CONFIG, collector: MOCK_COLLECTOR, home: MOCK_HOME });
    assert.ok(args.includes('--verbose'));
    assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json');
    // stream-json requires --verbose to precede the format selection
    assert.ok(args.indexOf('--verbose') < args.indexOf('--output-format'));
  });

  test('a debug field on the config does not change the format (mode is gone)', () => {
    const { args } = buildCommand({
      config: { ...BASE_CONFIG, debug: false },
      collector: MOCK_COLLECTOR,
      home: MOCK_HOME,
    });
    assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json');
  });
});

// parseResultEnvelope normalizes BOTH output formats to one envelope so assertSucceeded/extractUsage
// stay uniform. The single-object (default) path must behave exactly as parseJsonEnvelope did.
describe('parseResultEnvelope — robust to json and stream-json', () => {
  const RESULT = { type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0.01, usage: { input_tokens: 100, output_tokens: 10 } };

  test('single-object json envelope is returned verbatim', () => {
    assert.deepEqual(parseResultEnvelope(JSON.stringify(RESULT)), RESULT);
  });

  test('a single-object envelope without an explicit type is still recovered', () => {
    const env = { is_error: false, result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } };
    assert.deepEqual(parseResultEnvelope(JSON.stringify(env)), env);
  });

  test('stream-json JSONL returns the terminal result event', () => {
    const stream = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'considering' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__review_collector__request_change' }] } }),
      JSON.stringify(RESULT),
    ].join('\n') + '\n';
    assert.deepEqual(parseResultEnvelope(stream), RESULT);
  });

  test('assertSucceeded and extractUsage work off a stream-json transcript', () => {
    const stream = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'x' }] } }),
      JSON.stringify(RESULT),
    ].join('\n');
    assert.doesNotThrow(() => assertSucceeded(stream));
    const usage = extractUsage(stream, { ...BASE_CONFIG, endpoint: { ...BASE_CONFIG.endpoint, baseUrl: 'https://api.deepseek.com/anthropic' }, model: 'deepseek-v4-pro' });
    assert.equal(usage.inputTokens, 100);
    assert.equal(usage.outputTokens, 10);
  });

  test('a multi-line stream with no terminal result is a failure (assertSucceeded throws)', () => {
    // A genuine stream-json transcript that never reached a result event: the whole-stdout parse
    // fails (multi-line) and no `type:"result"` line exists, so the envelope is unrecoverable.
    const stream = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({ type: 'assistant', message: { content: [] } }),
    ].join('\n');
    assert.throws(() => assertSucceeded(stream), /invalid JSON/);
  });
});
