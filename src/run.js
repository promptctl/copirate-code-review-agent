'use strict';
const core = require('@actions/core');
const github = require('@actions/github');
const fs = require('fs');
const path = require('path');

const { filterFiles, buildReviewAnchors } = require('./diff');
const { selectTransport, submitReview, resolveReviewTarget, prIsFromFork } = require('./transport');
const { buildReviewInput } = require('./prompt');
const { validateFindings } = require('./review');
const { createReviewCollector, readCollectedReview } = require('./collector');
const { produceReview, buildAttributionFooter } = require('./failover');
const { runEngine } = require('./engine/run');
const registry = require('./engine/registry');
const { loadConfig, peekConfigNames } = require('./config');
const { synthesizeProviderConfig } = require('./provider');
const { selectConfig } = require('./selection');

// ACTION_ROOT resolves to the repo root whether running as an action (GITHUB_ACTION_PATH
// is set) or from src/ during local development (one level above __dirname).
const ACTION_ROOT = process.env.GITHUB_ACTION_PATH || path.join(__dirname, '..');
const REVIEW_AGENT_INSTRUCTIONS_PATH = path.join(ACTION_ROOT, 'review-agent', 'instructions.md');

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
  const configNameInput = core.getInput('CONFIG');
  const hasConfigFile = fs.existsSync(configFilePath);

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

  // [LAW:single-enforcer] One PR fetch, one place that decides fork eligibility. The PR
  // object also feeds config-file label/body selection below, so it is fetched once here.
  let pr;
  try {
    ({ data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber }));
  } catch (e) {
    core.setFailed(`Failed to fetch PR #${pullNumber}: ${e.message}`);
    return;
  }

  // [LAW:dataflow-not-control-flow] Fork eligibility is read from the PR data, not a mode:
  // the action never reviews a fork PR (its diff is untrusted and would spend the host's
  // own AI credits on outside contributors). Skipping is an intentional clean no-op — logged,
  // exit 0, no review posted, no engine spawned. [LAW:no-silent-failure] the skip is announced.
  if (prIsFromFork(pr)) {
    core.info(
      `Skipping review: PR #${pullNumber} is from a fork. Fork pull requests are not reviewed `
      + 'by this action.',
    );
    return;
  }

  // [LAW:types-are-the-program] Build a typed ReviewConfig chain. Config file produces
  // a validated multi-config chain; the PROVIDER inputs synthesize a single-entry chain.
  let chain;
  if (hasConfigFile) {
    // peekConfigNames is a fast read so config names are available for selection.
    let configNames, defaultName;
    try {
      ({ configNames, defaultName } = peekConfigNames(configFilePath));
    } catch (e) {
      core.setFailed(e.message);
      return;
    }

    let selectedName;
    try {
      selectedName = selectConfig(
        { labels: pr.labels, body: pr.body },
        { configInput: configNameInput, configNames, defaultName },
      );
    } catch (e) {
      core.setFailed(e.message);
      return;
    }

    core.info(`Selected reviewer config: '${selectedName}'`);

    try {
      chain = loadConfig(configFilePath, selectedName, process.env);
    } catch (e) {
      core.setFailed(e.message);
      return;
    }
    chain.forEach(c => core.setSecret(c.endpoint.apiKey));
  } else {
    // [LAW:dataflow-not-control-flow] Simple mode: the PROVIDER value alone decides the
    // engine — credential presence never steers it. The chosen provider's key is then
    // required, and its absence fails loud naming the input to set. [LAW:no-silent-failure]
    let config;
    try {
      config = synthesizeProviderConfig({
        provider: core.getInput('PROVIDER'),
        openaiApiKey: core.getInput('OPENAI_API_KEY'),
        openaiModel: core.getInput('OPENAI_MODEL'),
        openaiReasoning: core.getInput('OPENAI_REASONING_EFFORT'),
        openaiBaseUrl: core.getInput('OPENAI_BASE_URL'),
        zaiApiKey: core.getInput('ZAI_API_KEY'),
        zaiModel: core.getInput('ZAI_MODEL'),
        zaiSystemPrompt: core.getInput('ZAI_SYSTEM_PROMPT'),
        zaiBaseUrl: core.getInput('ZAI_BASE_URL'),
      });
    } catch (e) {
      core.setFailed(e.message);
      return;
    }
    core.setSecret(config.endpoint.apiKey);
    core.info(`Using provider '${config.name}' (engine: ${config.engine}, model: ${config.model}).`);
    chain = [config];
  }

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
