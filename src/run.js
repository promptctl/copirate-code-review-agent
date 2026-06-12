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
const { produceReview, buildAttributionFooter } = require('./failover');
const { runEngine } = require('./engine/run');
const registry = require('./engine/registry');
const { ZAI_ANTHROPIC_BASE_URL } = require('./engine/claude-code');
const { loadConfig, assertNoLegacyConflict } = require('./config');

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
// buildPromptFor(toolNames) is called here so each engine gets the MCP tool identifiers
// its adapter registers, not chain[0]'s identifiers. [LAW:types-are-the-program]
// Nested try/finally guarantees cleanup even when materializeHome throws: the
// outer finally cleans collector.dir unconditionally; the inner finally cleans
// home only when materializeHome succeeded and home is defined. [LAW:no-silent-failure]
async function produceReviewOnce(config, buildPromptFor, anchors) {
  const adapter = registry.get(config.engine);
  const prompt = buildPromptFor(adapter.toolNames);
  const collector = createReviewCollector();
  try {
    const home = adapter.materializeHome({ config, instructionsPath: REVIEW_AGENT_INSTRUCTIONS_PATH, collector });
    try {
      await runEngine(adapter, config, prompt, home, collector);
      const review = readCollectedReview(collector.recordsPath);
      validateFindings(review.findings, anchors);
      return review;
    } finally {
      fs.rmSync(home, { recursive: true });
    }
  } finally {
    fs.rmSync(collector.dir, { recursive: true });
  }
}

async function run() {
  // [LAW:one-source-of-truth] Default path is declared in action.yml; do not duplicate it here.
  const configFilePath = core.getInput('CONFIG_FILE');
  const configName = core.getInput('CONFIG');
  const apiKey = core.getInput('ZAI_API_KEY');
  const hasConfigFile = fs.existsSync(configFilePath);

  // [LAW:one-source-of-truth] [LAW:no-silent-failure] Two config sources = two sources
  // of truth for the same fact. Fail loud before touching anything else.
  try {
    assertNoLegacyConflict(configFilePath, hasConfigFile, apiKey);
  } catch (e) {
    core.setFailed(e.message);
    return;
  }

  // [LAW:types-are-the-program] Build a typed ReviewConfig chain. Config file produces
  // a validated multi-config chain; ZAI_* inputs synthesize a single-entry compat chain.
  let chain;
  if (hasConfigFile) {
    try {
      chain = loadConfig(configFilePath, configName || undefined, process.env);
    } catch (e) {
      core.setFailed(e.message);
      return;
    }
    chain.forEach(c => core.setSecret(c.endpoint.apiKey));
  } else {
    if (!apiKey) {
      core.setFailed(
        `No configuration found. '${configFilePath}' does not exist and ZAI_API_KEY is not set. ` +
        'Provide a valid CONFIG_FILE path or ZAI_API_KEY.',
      );
      return;
    }
    core.setSecret(apiKey);
    const model = core.getInput('ZAI_MODEL');
    const systemPrompt = core.getInput('ZAI_SYSTEM_PROMPT');
    chain = [synthesizeZaiConfig(apiKey, model, systemPrompt)];
  }

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

  // buildPromptFor(toolNames) is called per-attempt in produceReviewOnce so each engine gets
  // the MCP tool identifiers its adapter registers. Anchors are engine-agnostic (purely
  // diff-line based), so they are computed once here from any toolNames. [LAW:types-are-the-program]
  // [LAW:no-ambient-temporal-coupling] produceReview owns all retry/failover timing.
  const anchorInput = buildReviewInput(filteredFiles, maxDiffChars, registry.get(chain[0].engine).toolNames);
  const anchors = buildReviewAnchors(anchorInput.files);
  const buildPromptFor = (toolNames) => buildReviewInput(filteredFiles, maxDiffChars, toolNames).prompt;

  // [LAW:one-source-of-truth] Claude Code owns review judgment; the action owns GitHub transport.
  core.info(`Running PR review for ${filteredFiles.length} file(s) with ${chain.length} config(s) in chain...`);
  const { review, configUsed } = await produceReview(chain, buildPromptFor, anchors, produceReviewOnce);
  const footer = buildAttributionFooter(configUsed);
  await submitReview(reviewOctokit, owner, repo, pullNumber, headSha, reviewerName, review, Boolean(reviewToken), transport, footer);
}

module.exports = { run };
