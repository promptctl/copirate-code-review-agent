'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { claudeCodeAdapter, ZAI_ANTHROPIC_BASE_URL } = require('../src/engine/claude-code');

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

describe('claudeCodeAdapter.buildCommand — args match pre-refactor buildClaudeArgs', () => {
  test('command is always "npx"', () => {
    const { command } = claudeCodeAdapter.buildCommand({
      config: BASE_CONFIG,
      collector: MOCK_COLLECTOR,
      home: MOCK_HOME,
    });
    assert.equal(command, 'npx');
  });

  test('args match the exact pre-refactor order and values', () => {
    const { args } = claudeCodeAdapter.buildCommand({
      config: BASE_CONFIG,
      collector: MOCK_COLLECTOR,
      home: MOCK_HOME,
    });

    // Exact pre-refactor arg sequence from buildClaudeArgs (byte-identical contract)
    assert.deepEqual(args, [
      '-y',
      '@anthropic-ai/claude-code@latest',
      '-p',
      '--output-format',
      'json',
      '--no-session-persistence',
      '--tools',
      'Read,Grep,Glob',
      '--allowedTools',
      'Read,Grep,Glob,mcp__review_collector__request_change,mcp__review_collector__finish_review',
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
    const { args } = claudeCodeAdapter.buildCommand({
      config: { ...BASE_CONFIG, model: '' },
      collector: MOCK_COLLECTOR,
      home: MOCK_HOME,
    });
    assert.equal(args.includes('--model'), false);
    assert.equal(args.at(-1), 'Review the pull request instructions and diff from stdin.');
  });

  test('omits --append-system-prompt when systemPrompt is absent', () => {
    const { args } = claudeCodeAdapter.buildCommand({
      config: BASE_CONFIG,
      collector: MOCK_COLLECTOR,
      home: MOCK_HOME,
    });
    assert.equal(args.includes('--append-system-prompt'), false);
  });

  test('--append-system-prompt appears before the prompt string when set', () => {
    const { args } = claudeCodeAdapter.buildCommand({
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
    const { args } = claudeCodeAdapter.buildCommand({
      config: BASE_CONFIG,
      collector: { mcpConfigPath: '/custom/path/mcp.json' },
      home: MOCK_HOME,
    });
    const idx = args.indexOf('--mcp-config');
    assert.ok(idx !== -1);
    assert.equal(args[idx + 1], '/custom/path/mcp.json');
  });
});

describe('claudeCodeAdapter.buildCommand — env matches pre-refactor runClaudeCode env', () => {
  test('HOME is set to the provided home directory', () => {
    const { env } = claudeCodeAdapter.buildCommand({
      config: BASE_CONFIG,
      collector: MOCK_COLLECTOR,
      home: '/custom/home/dir',
    });
    assert.equal(env.HOME, '/custom/home/dir');
  });

  test('ANTHROPIC_AUTH_TOKEN comes from config.endpoint.apiKey', () => {
    const { env } = claudeCodeAdapter.buildCommand({
      config: BASE_CONFIG,
      collector: MOCK_COLLECTOR,
      home: MOCK_HOME,
    });
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'test-api-key-xyz');
  });

  test('ANTHROPIC_BASE_URL comes from config.endpoint.baseUrl (ZAI URL for compat shim)', () => {
    const { env } = claudeCodeAdapter.buildCommand({
      config: BASE_CONFIG,
      collector: MOCK_COLLECTOR,
      home: MOCK_HOME,
    });
    assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic');
  });

  test('ANTHROPIC_MODEL is set to config.model', () => {
    const { env } = claudeCodeAdapter.buildCommand({
      config: BASE_CONFIG,
      collector: MOCK_COLLECTOR,
      home: MOCK_HOME,
    });
    assert.equal(env.ANTHROPIC_MODEL, 'claude-sonnet-4-6');
  });

  test('API_TIMEOUT_MS is set to the string form of CLAUDE_TIMEOUT_MS (3000000)', () => {
    const { env } = claudeCodeAdapter.buildCommand({
      config: BASE_CONFIG,
      collector: MOCK_COLLECTOR,
      home: MOCK_HOME,
    });
    assert.equal(env.API_TIMEOUT_MS, '3000000');
  });

  test('CLAUDE_CODE_SKIP_PROMPT_HISTORY is "1"', () => {
    const { env } = claudeCodeAdapter.buildCommand({
      config: BASE_CONFIG,
      collector: MOCK_COLLECTOR,
      home: MOCK_HOME,
    });
    assert.equal(env.CLAUDE_CODE_SKIP_PROMPT_HISTORY, '1');
  });

  test('NO_COLOR is "1"', () => {
    const { env } = claudeCodeAdapter.buildCommand({
      config: BASE_CONFIG,
      collector: MOCK_COLLECTOR,
      home: MOCK_HOME,
    });
    assert.equal(env.NO_COLOR, '1');
  });

  test('CLAUDE_CODE_EFFORT_LEVEL is absent when reasoning is not set', () => {
    const { env } = claudeCodeAdapter.buildCommand({
      config: BASE_CONFIG,
      collector: MOCK_COLLECTOR,
      home: MOCK_HOME,
    });
    assert.equal('CLAUDE_CODE_EFFORT_LEVEL' in env, false);
  });

  test('CLAUDE_CODE_EFFORT_LEVEL is set from config.reasoning when present', () => {
    const { env } = claudeCodeAdapter.buildCommand({
      config: { ...BASE_CONFIG, reasoning: 'high' },
      collector: MOCK_COLLECTOR,
      home: MOCK_HOME,
    });
    assert.equal(env.CLAUDE_CODE_EFFORT_LEVEL, 'high');
  });

  test('env inherits process.env entries', () => {
    const { env } = claudeCodeAdapter.buildCommand({
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

  test('timeoutMs is 3000000 (50 minutes)', () => {
    assert.equal(claudeCodeAdapter.timeoutMs, 3_000_000);
  });

  test('endpointKinds contains only "anthropic-messages"', () => {
    assert.deepEqual(claudeCodeAdapter.capabilities.endpointKinds, ['anthropic-messages']);
  });

  test('findingsChannels contains only "mcp-collector"', () => {
    assert.deepEqual(claudeCodeAdapter.capabilities.findingsChannels, ['mcp-collector']);
  });

  test('reasoningEfforts contains the four claude effort levels', () => {
    assert.deepEqual(claudeCodeAdapter.capabilities.reasoningEfforts, ['low', 'medium', 'high', 'max']);
  });

  test('toolNames reference mcp__review_collector__ prefix', () => {
    assert.equal(claudeCodeAdapter.toolNames.requestChange, 'mcp__review_collector__request_change');
    assert.equal(claudeCodeAdapter.toolNames.finishReview, 'mcp__review_collector__finish_review');
  });

  test('adapter exposes all required interface methods', () => {
    assert.equal(typeof claudeCodeAdapter.materializeHome, 'function');
    assert.equal(typeof claudeCodeAdapter.buildCommand, 'function');
    assert.equal(typeof claudeCodeAdapter.assertSucceeded, 'function');
    assert.equal(typeof claudeCodeAdapter.classifyError, 'function');
  });
});

describe('claudeCodeAdapter.classifyError', () => {
  const base = new Error('spawn failed');

  test('429 text produces TransientError', () => {
    const { TransientError } = require('../src/failover');
    const result = claudeCodeAdapter.classifyError(base, 'HTTP 429 Too Many Requests');
    assert.ok(result instanceof TransientError);
    assert.ok(result.message.includes('rate-limited'));
  });

  test('529 text produces TransientError with null retryAfterMs', () => {
    const { TransientError } = require('../src/failover');
    const result = claudeCodeAdapter.classifyError(base, 'HTTP 529 overloaded');
    assert.ok(result instanceof TransientError);
    assert.equal(result.retryAfterMs, null);
  });

  test('unrelated error is returned unchanged', () => {
    const result = claudeCodeAdapter.classifyError(base, 'unexpected token at line 42');
    assert.equal(result, base);
  });
});
