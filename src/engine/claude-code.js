'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { TransientError, parseRetryAfterMs } = require('../failover');
const { parseJsonEnvelope, formatOutputTail } = require('./run');

const ZAI_ANTHROPIC_BASE_URL = 'https://api.z.ai/api/anthropic';
const CLAUDE_CODE_PACKAGE = '@anthropic-ai/claude-code';
const CLAUDE_TIMEOUT_MS = 3_000_000;
const CLAUDE_ALLOWED_TOOLS = [
  'Read',
  'Grep',
  'Glob',
  'mcp__review_collector__request_change',
  'mcp__review_collector__finish_review',
];
const CLAUDE_DISALLOWED_TOOLS = [
  'Bash',
  'Edit',
  'Write',
  'WebFetch',
  'WebSearch',
];

// [LAW:effects-at-boundaries] The only effect in this adapter: writing files to a temp HOME.
// The caller (produceReviewOnce) owns cleanup via fs.rmSync in its finally block.
function materializeHome({ config, instructionsPath, collector }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zai-reviewer-home-'));
  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  // [LAW:single-enforcer] The packaged action owns reusable reviewer instructions.
  fs.copyFileSync(instructionsPath, path.join(claudeDir, 'CLAUDE.md'));
  return home;
}

// [LAW:effects-at-boundaries] Pure: returns a full spawn spec from a validated ReviewConfig.
// [LAW:single-enforcer] Z.ai/Anthropic auth translation happens exactly once, here in the adapter.
function buildCommand({ config, collector, home }) {
  const args = [
    '-y',
    `${CLAUDE_CODE_PACKAGE}@latest`,
    '-p',
    '--output-format',
    'json',
    '--no-session-persistence',
    '--tools',
    'Read,Grep,Glob',
    '--allowedTools',
    CLAUDE_ALLOWED_TOOLS.join(','),
    '--disallowedTools',
    CLAUDE_DISALLOWED_TOOLS.join(','),
    '--mcp-config',
    collector.mcpConfigPath,
    '--strict-mcp-config',
    '--permission-mode',
    'dontAsk',
  ];

  if (config.model) {
    args.push('--model', config.model);
  }

  if (config.systemPrompt) {
    args.push('--append-system-prompt', config.systemPrompt);
  }

  args.push('Review the pull request instructions and diff from stdin.');

  const env = {
    ...process.env,
    HOME: home,
    ANTHROPIC_AUTH_TOKEN: config.endpoint.apiKey,
    ANTHROPIC_BASE_URL: config.endpoint.baseUrl,
    ANTHROPIC_MODEL: config.model,
    API_TIMEOUT_MS: String(CLAUDE_TIMEOUT_MS),
    CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1',
    NO_COLOR: '1',
  };

  if (config.reasoning) {
    env.CLAUDE_CODE_EFFORT_LEVEL = config.reasoning;
  }

  return { command: 'npx', args, env };
}

function assertSucceeded(stdout) {
  const parsed = parseJsonEnvelope(stdout);
  if (!parsed) {
    throw new Error(`Claude Code returned invalid JSON.\n\n${formatOutputTail('stdout tail', stdout)}`);
  }
  if (parsed.is_error || parsed.subtype === 'error') {
    throw new Error(`Claude Code review failed: ${parsed.result || 'unknown error'}`);
  }
}

// [LAW:single-enforcer] Error classification and Retry-After extraction happen exactly
// once, here at the engine boundary. 529/overloaded has no hint header;
// 429/rate-limited attaches it when the CLI echoes it. [LAW:one-source-of-truth]
function classifyError(err, text) {
  if (/\b429\b|rate.?limit/i.test(text)) return new TransientError(`rate-limited: ${err.message}`, parseRetryAfterMs(text));
  if (/\b529\b|overloaded/i.test(text)) return new TransientError(`overloaded: ${err.message}`);
  return err;
}

// [LAW:one-source-of-truth] classifyClaudeError is the stable public name re-exported
// from src/index.js for test compatibility; classifyError is the adapter interface name.
const classifyClaudeError = classifyError;

// [LAW:one-type-per-behavior] One adapter object per engine CLI; adapters compose with
// the generic runEngine via the declared interface contract.
const claudeCodeAdapter = {
  name: 'claude-code',
  timeoutMs: CLAUDE_TIMEOUT_MS,
  capabilities: {
    // [LAW:types-are-the-program] Capability declarations are the single source of truth
    // for config validation in src/config.js (T4). Illegal combos are rejected at load
    // time via these declarations, never discovered at spawn time.
    reasoningEfforts: ['low', 'medium', 'high', 'max'],
    endpointKinds: ['anthropic-messages'],
    findingsChannels: ['mcp-collector'],
  },
  toolNames: {
    requestChange: 'mcp__review_collector__request_change',
    finishReview: 'mcp__review_collector__finish_review',
  },
  materializeHome,
  buildCommand,
  assertSucceeded,
  classifyError,
};

module.exports = {
  ZAI_ANTHROPIC_BASE_URL,
  classifyClaudeError,
  claudeCodeAdapter,
};
