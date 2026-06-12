'use strict';
const core = require('@actions/core');
const github = require('@actions/github');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { filterFiles, buildReviewAnchors } = require('./diff');
const { selectTransport, submitReview, resolveReviewTarget } = require('./transport');
const { buildReviewInput } = require('./prompt');
const { validateFindings } = require('./review');
const { createReviewCollector, readCollectedReview } = require('./collector');
const { TransientError, classifyClaudeError, sleep, transientBackoffMs, TRANSIENT_RETRY_BUDGET_MS } = require('./failover');

const ZAI_ANTHROPIC_BASE_URL = 'https://api.z.ai/api/anthropic';
const CLAUDE_CODE_PACKAGE = '@anthropic-ai/claude-code';
const MAX_RESPONSE_SIZE = 1024 * 1024;
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
const ACTION_ROOT = process.env.GITHUB_ACTION_PATH || path.join(__dirname, '..');
const REVIEW_AGENT_CLAUDE_PATH = path.join(ACTION_ROOT, 'review-agent', 'CLAUDE.md');

function buildClaudeArgs(model, systemPrompt, mcpConfigPath) {
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
    mcpConfigPath,
    '--strict-mcp-config',
    '--permission-mode',
    'dontAsk',
  ];

  if (model) {
    args.push('--model', model);
  }

  if (systemPrompt) {
    args.push('--append-system-prompt', systemPrompt);
  }

  args.push('Review the pull request instructions and diff from stdin.');

  return args;
}

function parseJsonEnvelope(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    const trimmed = stdout.trim();
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      return undefined;
    }
    try {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    } catch {
      return undefined;
    }
  }
}

function assertClaudeSucceeded(stdout) {
  const parsed = parseJsonEnvelope(stdout);
  if (!parsed) {
    throw new Error(`Claude Code returned invalid JSON.\n\n${formatOutputTail('stdout tail', stdout)}`);
  }

  if (parsed.is_error || parsed.subtype === 'error') {
    throw new Error(`Claude Code review failed: ${parsed.result || 'unknown error'}`);
  }
}

function createReviewerHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zai-reviewer-home-'));
  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  // [LAW:single-enforcer] The packaged action owns reusable reviewer instructions.
  fs.copyFileSync(REVIEW_AGENT_CLAUDE_PATH, path.join(claudeDir, 'CLAUDE.md'));
  return home;
}

function formatOutputTail(label, value) {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return `${label}: <empty>`;
  }
  return `${label}:\n${trimmed.slice(-4000)}`;
}

function formatClaudeFailure(code, args, stdout, stderr) {
  return [
    `Claude Code exited with status ${code}.`,
    `Command: npx ${args.map(arg => JSON.stringify(arg)).join(' ')}`,
    formatOutputTail('stderr tail', stderr),
    formatOutputTail('stdout tail', stdout),
  ].join('\n\n');
}

function runClaudeCode(apiKey, model, systemPrompt, prompt, reviewerHome, mcpConfigPath) {
  return new Promise((resolve, reject) => {
    // [LAW:single-enforcer] Z.ai auth is translated exactly once at the agent runner boundary.
    const env = {
      ...process.env,
      HOME: reviewerHome,
      ANTHROPIC_AUTH_TOKEN: apiKey,
      ANTHROPIC_BASE_URL: ZAI_ANTHROPIC_BASE_URL,
      ANTHROPIC_MODEL: model,
      API_TIMEOUT_MS: String(CLAUDE_TIMEOUT_MS),
      CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1',
      NO_COLOR: '1',
    };
    const args = buildClaudeArgs(model, systemPrompt, mcpConfigPath);
    const child = spawn('npx', args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = result => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      result();
    };

    const timeout = setTimeout(() => {
      finish(() => {
        child.kill('SIGTERM');
        reject(new Error('Claude Code review timed out.'));
      });
    }, CLAUDE_TIMEOUT_MS);

    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.length > MAX_RESPONSE_SIZE) {
        finish(() => {
          child.kill('SIGTERM');
          reject(new Error('Claude Code response exceeded size limit.'));
        });
      }
    });

    child.stderr.on('data', chunk => {
      stderr += chunk;
      if (stderr.length > MAX_RESPONSE_SIZE) {
        stderr = stderr.slice(-MAX_RESPONSE_SIZE);
      }
    });

    child.on('error', err => {
      finish(() => reject(err));
    });

    child.on('close', code => {
      finish(() => {
        if (code !== 0) {
          reject(classifyClaudeError(new Error(formatClaudeFailure(code, args, stdout, stderr)), `${stdout}\n${stderr}`));
          return;
        }
        try {
          assertClaudeSucceeded(stdout);
          resolve();
        } catch (err) {
          reject(classifyClaudeError(err, stdout));
        }
      });
    });

    child.stdin.end(prompt);
  });
}

// One attempt at producing a validated review against a fresh collector. The
// collector is recreated per attempt so partial records from a transient-failed attempt
// can never leak into a later successful read. [LAW:no-silent-failure]
async function produceReviewOnce(apiKey, model, systemPrompt, prompt, reviewerHome, anchors) {
  const collector = createReviewCollector();
  try {
    await runClaudeCode(apiKey, model, systemPrompt, prompt, reviewerHome, collector.mcpConfigPath);
    const review = readCollectedReview(collector.recordsPath);
    validateFindings(review.findings, anchors);
    return review;
  } finally {
    fs.rmSync(collector.dir, { recursive: true });
  }
}

// [LAW:no-ambient-temporal-coupling] This loop is the single explicit owner of retry
// timing; runClaudeCode does one attempt and stays timing-free. Transient failures (429
// rate-limited, 529 overloaded) retry until the time budget is spent; everything else
// surfaces immediately. [LAW:no-silent-failure]
async function produceReview(apiKey, model, systemPrompt, prompt, reviewerHome, anchors) {
  const deadline = Date.now() + TRANSIENT_RETRY_BUDGET_MS;
  for (let attempt = 1; ; attempt++) {
    try {
      return await produceReviewOnce(apiKey, model, systemPrompt, prompt, reviewerHome, anchors);
    } catch (err) {
      if (!(err instanceof TransientError) || Date.now() >= deadline) {
        throw err;
      }
      const budgetLeft = Math.max(0, deadline - Date.now());
      const hintOrBackoff = err.retryAfterMs ?? transientBackoffMs(attempt);
      const delay = Math.min(hintOrBackoff, budgetLeft);
      const minsLeft = Math.ceil(budgetLeft / 60_000);
      const delaySource = hintOrBackoff <= budgetLeft ? (err.retryAfterMs !== null ? 'Retry-After' : 'backoff') : 'budget';
      core.warning(`z.ai transient error (${err.message}); retrying in ${Math.round(delay / 1000)}s [${delaySource}] (~${minsLeft}m of retry budget left).`);
      await sleep(delay);
    }
  }
}

async function run() {
  const apiKey = core.getInput('ZAI_API_KEY', { required: true });
  core.setSecret(apiKey);
  const model = core.getInput('ZAI_MODEL');
  const systemPrompt = core.getInput('ZAI_SYSTEM_PROMPT');
  const reviewerName = core.getInput('ZAI_REVIEWER_NAME');
  const excludePatterns = core.getInput('EXCLUDE_PATTERNS')
    .split(',')
    .map(p => p.trim())
    .filter(p => p.length > 0);
  const maxDiffChars = parseInt(core.getInput('MAX_DIFF_CHARS'), 10) || 0;
  const token = core.getInput('GITHUB_TOKEN');
  core.setSecret(token);
  const reviewToken = core.getInput('GITHUB_REVIEW_TOKEN');
  if (reviewToken) {
    core.setSecret(reviewToken);
  }

  const { context } = github;
  const { owner, repo } = context.repo;
  const { pullNumber, headSha } = resolveReviewTarget(
    core.getInput('PR_NUMBER'),
    core.getInput('HEAD_SHA'),
    context.payload,
  );

  if (!Number.isInteger(pullNumber) || pullNumber <= 0 || !headSha) {
    core.setFailed(
      'Could not determine which pull request to review. On pull_request events this is '
      + 'detected automatically; on other events (e.g. workflow_run) pass PR_NUMBER and HEAD_SHA explicitly.',
    );
    return;
  }

  const octokit = github.getOctokit(token);
  const reviewOctokit = github.getOctokit(reviewToken || token);

  core.info(`Fetching changed files for PR #${pullNumber}...`);
  const transport = await selectTransport(octokit, owner, repo, pullNumber);
  const files = transport.files;

  const filteredFiles = filterFiles(files, excludePatterns);

  if (excludePatterns.length > 0) {
    const excluded = files.length - filteredFiles.length;
    if (excluded > 0) {
      core.info(`Excluded ${excluded} file(s) matching EXCLUDE_PATTERNS.`);
    }
  }

  const patchableFiles = filteredFiles.filter(f => f.patch);

  if (patchableFiles.length === 0) {
    await submitReview(reviewOctokit, owner, repo, pullNumber, headSha, reviewerName, {
      summary: 'No patchable changes found after filtering.',
      findings: [],
    }, Boolean(reviewToken), transport);
    return;
  }

  const reviewInput = buildReviewInput(filteredFiles, maxDiffChars);
  const anchors = buildReviewAnchors(reviewInput.files);
  const reviewerHome = createReviewerHome();

  // [LAW:one-source-of-truth] Claude Code owns review judgment; the action owns GitHub transport.
  core.info(`Running PR review for ${filteredFiles.length} file(s)...`);
  try {
    const review = await produceReview(apiKey, model, systemPrompt, reviewInput.prompt, reviewerHome, anchors);
    await submitReview(reviewOctokit, owner, repo, pullNumber, headSha, reviewerName, review, Boolean(reviewToken), transport);
  } finally {
    // [LAW:no-ambient-temporal-coupling] The same owner that creates temporary review state also tears it down.
    fs.rmSync(reviewerHome, { recursive: true });
  }
}

module.exports = { run };
