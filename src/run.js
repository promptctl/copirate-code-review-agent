'use strict';
const core = require('@actions/core');
const github = require('@actions/github');
const fs = require('fs');
const path = require('path');

const { filterFiles, buildReviewAnchors } = require('./diff');
const { selectTransport, submitReview, resolveReviewTarget } = require('./transport');
const { buildReviewInput } = require('./prompt');
const { validateFindings } = require('./review');
const { createReviewCollector, readCollectedReview } = require('./collector');
const { TransientError, sleep, transientBackoffMs, TRANSIENT_RETRY_BUDGET_MS } = require('./failover');
const { runEngine } = require('./engine/run');
const registry = require('./engine/registry');
const { ZAI_ANTHROPIC_BASE_URL } = require('./engine/claude-code');

// ACTION_ROOT resolves to the repo root whether running as an action (GITHUB_ACTION_PATH
// is set) or from src/ during local development (one level above __dirname).
const ACTION_ROOT = process.env.GITHUB_ACTION_PATH || path.join(__dirname, '..');
const REVIEW_AGENT_INSTRUCTIONS_PATH = path.join(ACTION_ROOT, 'review-agent', 'instructions.md');

// [LAW:types-are-the-program] The ReviewConfig typed value is the single representation
// of what engine, endpoint, and model are being invoked. [LAW:one-source-of-truth]
// This compat shim synthesizes one from legacy ZAI_* inputs for v1 workflows.
function synthesizeZaiConfig(apiKey, model, systemPrompt) {
  return {
    name: 'zai-compat',
    engine: 'claude-code',
    model,
    systemPrompt: systemPrompt || undefined,
    endpoint: {
      kind: 'anthropic-messages',
      baseUrl: ZAI_ANTHROPIC_BASE_URL,
      apiKey,
    },
  };
}

// One attempt at producing a validated review against a fresh collector and home.
// Both are created here and destroyed in the finally block so partial state from a
// failed attempt can never leak into a later successful read. [LAW:no-silent-failure]
async function produceReviewOnce(config, prompt, anchors) {
  const adapter = registry.get(config.engine);
  const collector = createReviewCollector();
  const home = adapter.materializeHome({ config, instructionsPath: REVIEW_AGENT_INSTRUCTIONS_PATH, collector });
  try {
    await runEngine(adapter, config, prompt, home, collector);
    const review = readCollectedReview(collector.recordsPath);
    validateFindings(review.findings, anchors);
    return review;
  } finally {
    fs.rmSync(collector.dir, { recursive: true });
    fs.rmSync(home, { recursive: true });
  }
}

// [LAW:no-ambient-temporal-coupling] This loop is the single explicit owner of retry
// timing; runEngine does one attempt and stays timing-free. Transient failures (429
// rate-limited, 529 overloaded) retry until the time budget is spent; everything else
// surfaces immediately. [LAW:no-silent-failure]
async function produceReview(config, prompt, anchors) {
  const deadline = Date.now() + TRANSIENT_RETRY_BUDGET_MS;
  for (let attempt = 1; ; attempt++) {
    try {
      return await produceReviewOnce(config, prompt, anchors);
    } catch (err) {
      if (!(err instanceof TransientError) || Date.now() >= deadline) {
        throw err;
      }
      const budgetLeft = Math.max(0, deadline - Date.now());
      const hintOrBackoff = err.retryAfterMs ?? transientBackoffMs(attempt);
      const delay = Math.min(hintOrBackoff, budgetLeft);
      const minsLeft = Math.ceil(budgetLeft / 60_000);
      const delaySource = hintOrBackoff <= budgetLeft ? (err.retryAfterMs !== null ? 'Retry-After' : 'backoff') : 'budget';
      core.warning(`Transient error on '${config.name}' (${err.message}); retrying in ${Math.round(delay / 1000)}s [${delaySource}] (~${minsLeft}m of retry budget left).`);
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

  // [LAW:types-are-the-program] Synthesize a typed ReviewConfig from v1 ZAI_* inputs.
  // The adapter is looked up once to get toolNames for buildReviewInput so the prompt
  // references the correct MCP tool identifiers for this engine.
  const config = synthesizeZaiConfig(apiKey, model, systemPrompt);
  const adapter = registry.get(config.engine);
  const reviewInput = buildReviewInput(filteredFiles, maxDiffChars, adapter.toolNames);
  const anchors = buildReviewAnchors(reviewInput.files);

  // [LAW:one-source-of-truth] Claude Code owns review judgment; the action owns GitHub transport.
  core.info(`Running PR review for ${filteredFiles.length} file(s)...`);
  const review = await produceReview(config, reviewInput.prompt, anchors);
  await submitReview(reviewOctokit, owner, repo, pullNumber, headSha, reviewerName, review, Boolean(reviewToken), transport);
}

module.exports = { run };
