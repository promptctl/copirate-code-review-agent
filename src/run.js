'use strict';
const core = require('@actions/core');
const github = require('@actions/github');
const fs = require('fs');
const path = require('path');

const { filterFiles, buildReviewAnchors } = require('./diff');
const { selectTransport, submitReview, resolveReviewTarget, prIsFromFork } = require('./transport');
const { buildReviewInput, buildRepoReviewInput } = require('./prompt');
const { partitionFindings } = require('./review');
const { produceReview, buildAttributionFooter } = require('./failover');
const { renderCostLine, costWarning } = require('./usage');
const { renderRepoReport } = require('./report');
const registry = require('./engine/registry');
const { loadConfig, peekConfigNames } = require('./config');
const { synthesizeProviderConfig } = require('./provider');
const { selectConfig } = require('./selection');

// ACTION_ROOT resolves to the repo root whether running as an action (GITHUB_ACTION_PATH
// is set) or from src/ during local development (one level above __dirname).
const ACTION_ROOT = process.env.GITHUB_ACTION_PATH || path.join(__dirname, '..');
const REVIEW_AGENT_INSTRUCTIONS_PATH = path.join(ACTION_ROOT, 'review-agent', 'instructions.md');

// [LAW:one-source-of-truth] The absolute path of the REVIEWED repo (the checked-out working tree),
// resolved once at the boundary. The engine spawns with an isolated working directory OUTSIDE this
// tree (owned by the CLI adapter), so a repo-committed CLAUDE.md/AGENTS.md can never be auto-loaded
// as reviewer instructions; the repo is reached only by this explicit path, which the prompt hands
// to the agent for absolute-path Read/Grep/Glob. GITHUB_WORKSPACE is set by GitHub Actions and
// Gitea's act_runner alike; process.cwd() is the local-dev fallback. [LAW:effects-at-boundaries]
const REVIEWED_REPO_ROOT = process.env.GITHUB_WORKSPACE || process.cwd();

// [LAW:decomposition] The engine attempt is now the adapter's own concern: adapter.produceReview
// runs one engine against the prompt and returns {summary, findings, usage}, knowing nothing about
// pull requests, diff anchors, or the host. The orchestrator no longer owns the CLI lifecycle (the
// collector dance is private to the CLI adapters); it only chooses the adapter and supplies the
// shared review context. buildPromptFor(toolNames) is applied inside the adapter with its own MCP
// tool identifiers, so a failover chain gives each engine the right names. [LAW:types-are-the-program]
function runOneReview(config, buildPromptFor) {
  return registry.get(config.engine).produceReview({
    config,
    buildPromptFor,
    instructionsPath: REVIEW_AGENT_INSTRUCTIONS_PATH,
  });
}

// PR-mode attempt: the shared engine plus diff-anchor reconciliation. [LAW:dataflow-not-control-flow]
// Reconcile findings with the diff anchors as a value: anchored (incl. snapped) post inline;
// unanchored are surfaced in the summary. A mis-anchored finding never aborts the review.
// [LAW:no-silent-failure] each unanchored finding is logged here at the boundary so it is visible
// in the run, never dropped silently.
async function produceReviewOnce(config, buildPromptFor, anchors) {
  const { summary, findings, usage } = await runOneReview(config, buildPromptFor);
  const { anchored, unanchored } = partitionFindings(findings, anchors);
  for (const f of unanchored) {
    core.warning(`Finding references ${f.path}:${f.line}, outside the reviewed diff — surfaced in the review summary instead of inline.`);
  }
  return { summary, findings: anchored, unanchored, usage };
}

// Repo-mode attempt: the shared engine, with no anchor reconciliation. There is no diff grid, so
// every file:line the agent cites is valid — findings flow through unchanged. produceReview passes
// anchors as the third argument for every mode; this attempt ignores it. [LAW:composability]
async function produceRepoReviewOnce(config, buildPromptFor) {
  return runOneReview(config, buildPromptFor);
}

// [LAW:decomposition] Establish the typed ReviewConfig chain for this run and register its
// secrets. selection is the value PR/repo modes differ on: a PR run passes its labels + body so a
// config file can pick a per-PR reviewer; a repo run has no PR, so it passes empty selectors and
// per-PR rules fall through to the explicit CONFIG input or the file default. [LAW:dataflow-not-control-flow]
// Throws on any config error so the single caller boundary reports it via setFailed.
function buildConfigChain(selection) {
  // [LAW:one-source-of-truth] Default path is declared in action.yml; do not duplicate it here.
  const configFilePath = core.getInput('CONFIG_FILE');
  const configNameInput = core.getInput('CONFIG');

  if (fs.existsSync(configFilePath)) {
    const { configNames, defaultName } = peekConfigNames(configFilePath);
    const selectedName = selectConfig(selection, { configInput: configNameInput, configNames, defaultName });
    core.info(`Selected reviewer config: '${selectedName}'`);
    const chain = loadConfig(configFilePath, selectedName, process.env);
    chain.forEach(c => core.setSecret(c.endpoint.apiKey));
    return chain;
  }

  // [LAW:dataflow-not-control-flow] Simple mode: the PROVIDER value alone decides the engine —
  // credential presence never steers it. The chosen provider's key is then required, and its
  // absence fails loud naming the input to set. [LAW:no-silent-failure]
  const config = synthesizeProviderConfig({
    provider: core.getInput('PROVIDER'),
    openaiApiKey: core.getInput('OPENAI_API_KEY'),
    openaiModel: core.getInput('OPENAI_MODEL'),
    openaiReasoning: core.getInput('OPENAI_REASONING_EFFORT'),
    openaiBaseUrl: core.getInput('OPENAI_BASE_URL'),
    zaiApiKey: core.getInput('ZAI_API_KEY'),
    zaiModel: core.getInput('ZAI_MODEL'),
    zaiSystemPrompt: core.getInput('ZAI_SYSTEM_PROMPT'),
    zaiBaseUrl: core.getInput('ZAI_BASE_URL'),
    deepseekApiKey: core.getInput('DEEPSEEK_API_KEY'),
    deepseekModel: core.getInput('DEEPSEEK_MODEL'),
    deepseekBaseUrl: core.getInput('DEEPSEEK_BASE_URL'),
  });
  core.setSecret(config.endpoint.apiKey);
  core.info(`Using provider '${config.name}' (engine: ${config.engine}, model: ${config.model}).`);
  return [config];
}

// [LAW:effects-at-boundaries] The cost-reporting boundary, shared by both sinks: renderCostLine
// and costWarning are pure; this is the one place the "loud, not silent" signal is emitted, and it
// returns the full attribution + cost footer. [LAW:no-silent-failure] costWarning names the actual
// cause (carried in usage.cost.reason), so the boundary never re-derives why cost is absent.
function buildReviewFooter(usage, configUsed) {
  const warning = costWarning(usage, configUsed);
  if (warning) core.warning(warning);
  const costLine = renderCostLine(usage, configUsed);
  if (costLine) core.info(costLine.replace(/^_|_$/g, ''));
  return [buildAttributionFooter(configUsed), costLine].filter(Boolean).join('\n\n');
}

// PR-diff review: fetch the PR, gate forks, build the diff material + anchors, run the engine
// chain, and submit an inline GitHub review.
async function runPrReview(reviewerName, excludePatterns) {
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
      + 'detected automatically; on other events (e.g. workflow_run) pass PR_NUMBER and HEAD_SHA explicitly. '
      + 'For an on-demand whole-repo review with no PR, set MODE: repo.',
    );
    return;
  }

  const octokit = github.getOctokit(token);
  const reviewOctokit = github.getOctokit(reviewToken || token);

  // [LAW:single-enforcer] One PR fetch, one place that decides fork eligibility. The PR object
  // also feeds config-file label/body selection below, so it is fetched once here.
  let pr;
  try {
    ({ data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber }));
  } catch (e) {
    core.setFailed(`Failed to fetch PR #${pullNumber}: ${e.message}`);
    return;
  }

  // [LAW:dataflow-not-control-flow] Fork eligibility is read from the PR data, not a mode: the
  // action never reviews a fork PR (its diff is untrusted and would spend the host's own AI credits
  // on outside contributors). Skipping is an intentional clean no-op — logged, exit 0, no review
  // posted, no engine spawned. [LAW:no-silent-failure] the skip is announced; malformed PR data (no
  // base repo) throws here and surfaces as a loud failure, never a skip.
  let isFork;
  try {
    isFork = prIsFromFork(pr);
  } catch (e) {
    core.setFailed(e.message);
    return;
  }
  if (isFork) {
    core.info(
      `Skipping review: PR #${pullNumber} is from a fork. Fork pull requests are not reviewed `
      + 'by this action.',
    );
    return;
  }

  let chain;
  try {
    chain = buildConfigChain({ labels: pr.labels, body: pr.body });
  } catch (e) {
    core.setFailed(e.message);
    return;
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

  // Anchors are engine-agnostic (purely diff-line based), so they are computed once here from any
  // toolNames; buildPromptFor is called per-attempt so each engine gets its own tool identifiers.
  // [LAW:types-are-the-program] [LAW:no-ambient-temporal-coupling] produceReview owns retry timing.
  const anchorInput = buildReviewInput(filteredFiles, maxDiffChars, registry.get(chain[0].engine).toolNames, REVIEWED_REPO_ROOT);
  const anchors = buildReviewAnchors(anchorInput.files);
  const buildPromptFor = (toolNames) => buildReviewInput(filteredFiles, maxDiffChars, toolNames, REVIEWED_REPO_ROOT).prompt;

  // [LAW:one-source-of-truth] The engine owns review judgment; the action owns GitHub transport.
  core.info(`Running PR review for ${filteredFiles.length} file(s) with ${chain.length} config(s) in chain...`);
  const { review, configUsed } = await produceReview(chain, buildPromptFor, anchors, produceReviewOnce);

  const footer = buildReviewFooter(review.usage, configUsed);
  await submitReview(reviewOctokit, owner, repo, pullNumber, headSha, reviewerName, review, Boolean(reviewToken), transport, footer);
}

// Whole-repo review: no PR, no fork gate, no host transport. Build a repo-exploration prompt
// (optionally scoped), run the same engine chain, and print the report to the Step Summary + logs.
async function runRepoReview(reviewerName, excludePatterns) {
  const scope = core.getInput('SCOPE').trim();

  let chain;
  try {
    // [LAW:dataflow-not-control-flow] No PR means no per-PR selectors; the same selectConfig runs
    // with empty labels/body, so the file default or explicit CONFIG input decides the engine.
    chain = buildConfigChain({ labels: [], body: '' });
  } catch (e) {
    core.setFailed(e.message);
    return;
  }

  // No diff means no anchors and no per-attempt anchor reconciliation; the prompt is rebuilt per
  // engine so each gets its own tool identifiers. [LAW:composability]
  const buildPromptFor = (toolNames) => buildRepoReviewInput({ scope, excludePatterns, toolNames, reviewedRepoRoot: REVIEWED_REPO_ROOT }).prompt;

  core.info(
    `Running whole-repo review with ${chain.length} config(s) in chain`
    + `${scope ? ` (scope: ${scope})` : ' (whole repository)'}...`,
  );
  const { review, configUsed } = await produceReview(chain, buildPromptFor, null, produceRepoReviewOnce);

  const footer = buildReviewFooter(review.usage, configUsed);
  const report = renderRepoReport({ reviewerName, scope, review, footer });

  // [LAW:effects-at-boundaries] The printed sink: the report goes to the run log and the Step
  // Summary (the maintainer-facing output for a manual run). [LAW:no-silent-failure] findings are
  // surfaced loudly here; there is no PR to mark, so the run stays informational (exit 0). The log
  // is written first so findings are never lost if the Step Summary write fails (e.g. an
  // environment with GITHUB_STEP_SUMMARY unset surfaces its error loudly, after the log is on record).
  core.info(report);
  core.info(`Whole-repo review complete: ${review.findings.length} finding(s).`);
  await core.summary.addRaw(report).write();
}

async function run() {
  const reviewerName = core.getInput('ZAI_REVIEWER_NAME');
  const excludePatterns = core.getInput('EXCLUDE_PATTERNS')
    .split(',')
    .map(p => p.trim())
    .filter(p => p.length > 0);

  // [LAW:types-are-the-program] MODE is the explicit discriminator between the two review materials
  // and sinks. It is read as a value, never inferred from "is a PR present" — inferring would turn a
  // misconfigured PR run into an accidental whole-repo audit. [LAW:no-silent-failure] an unknown
  // value fails loud rather than defaulting silently.
  const mode = (core.getInput('MODE') || 'pr').trim();
  if (mode === 'pr') {
    await runPrReview(reviewerName, excludePatterns);
  } else if (mode === 'repo') {
    await runRepoReview(reviewerName, excludePatterns);
  } else {
    core.setFailed(`Invalid MODE '${mode}'. Valid values: 'pr' (review a pull request) or 'repo' (whole-repo review).`);
  }
}

module.exports = { run };
