'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { TransientError, parseRetryAfterMs } = require('../failover');
const { parseJsonEnvelope, formatOutputTail } = require('./run');

const ZAI_ANTHROPIC_BASE_URL = 'https://api.z.ai/api/anthropic';
const CLAUDE_CODE_PACKAGE = '@anthropic-ai/claude-code';
const CLAUDE_TIMEOUT_MS = 3_000_000;

// [LAW:one-source-of-truth] Declared first so CLAUDE_ALLOWED_TOOLS can derive its MCP
// entries from here. toolNames feeds the prompt; CLAUDE_ALLOWED_TOOLS feeds --allowedTools.
// Both must agree — a tool the model is told to call must also be on the allowed list.
const TOOL_NAMES = {
  requestChange: 'mcp__review_collector__request_change',
  finishReview: 'mcp__review_collector__finish_review',
};

const CLAUDE_ALLOWED_TOOLS = [
  'Read',
  'Grep',
  'Glob',
  ...Object.values(TOOL_NAMES),
];
const CLAUDE_DISALLOWED_TOOLS = [
  'Bash',
  'Edit',
  'Write',
  'WebFetch',
  'WebSearch',
];

// [LAW:effects-at-boundaries] The only effect in this adapter: writing files to a temp HOME.
// The caller passes the full interface context { config, instructionsPath, collector };
// this adapter only needs instructionsPath. Codex/opencode adapters will consume config
// (model/endpoint) and collector (MCP server registration in config.toml/opencode.json).
function materializeHome({ instructionsPath }) {
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

// [LAW:effects-at-boundaries] Pure: reads usage from the JSON envelope and returns a Usage value,
// or null when usage is absent. total_cost_usd is the real, provider-reported cost (no price table
// needed); a missing one yields cost {available:false, reason:'not-reported'}, tokens still report.
// total_cost_usd is Claude Code's own CLIENT-SIDE estimate (tokens × its bundled price table), not a
// billed charge — so the renderer marks every cost line "est.". The input count sums all input-side
// fields (fresh + cache read + cache write) so it reflects the total prompt tokens the run processed.
// Against the z.ai endpoint the estimate is priced against the wrong provider (Anthropic prices, z.ai
// billing), so the renderer adds a stronger caveat there. [FRAMING:representation]
function extractUsage(stdout) {
  const env = parseJsonEnvelope(stdout);
  if (!env || !env.usage) return null;
  const u = env.usage;
  const inputTokens =
    (u.input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0);
  const outputTokens = u.output_tokens ?? 0;
  // [LAW:types-are-the-program] cost is a discriminated value. Claude Code self-reports USD, so a
  // missing total_cost_usd means the engine did not report a cost ('not-reported') — distinct from
  // codex's 'no-price', and unrelated to the price table. The adapter declares its own reason.
  const cost = typeof env.total_cost_usd === 'number'
    ? { available: true, usd: env.total_cost_usd }
    : { available: false, reason: 'not-reported' };
  return { inputTokens, outputTokens, cost };
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
  // [LAW:one-source-of-truth] Reference TOOL_NAMES — do not redeclare the strings here.
  toolNames: TOOL_NAMES,
  materializeHome,
  buildCommand,
  assertSucceeded,
  classifyError,
  extractUsage,
};

module.exports = {
  ZAI_ANTHROPIC_BASE_URL,
  classifyClaudeError,
  claudeCodeAdapter,
  extractUsage,
};
