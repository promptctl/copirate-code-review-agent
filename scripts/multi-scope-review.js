#!/usr/bin/env node
'use strict';
// Multi-scope whole-repository review — a DEV DIAGNOSTIC. It runs the REAL adaptive multi-scope pass
// (scout → one worker per scope → aggregate) against the local working tree with NO GitHub, and
// prints the aggregated report.
//
// [LAW:one-source-of-truth] This is a thin caller, not a second implementation: it reuses the action's
// own seams — synthesizeProviderConfig (provider), buildRepoMaterial + runMultiScope (the shared
// engine in src/multiscope.js), renderRepoReport (the printed sink) — so its behavior matches a
// production repo-mode run for the same inputs. It is an instrument. The scout-planning, worker pool,
// usage summing, and aggregation all live in src/multiscope.js and are exercised here exactly as the
// action exercises them.
//
// [LAW:effects-at-boundaries] Module load is PURE: only stdlib + pure arg parsing. All world-effects
// (temp dirs, env mutation, engine requires) live inside main().

const fs = require('fs');
const os = require('os');
const path = require('path');

const USAGE = `Multi-scope whole-repository review (dev diagnostic).

Runs the action's real adaptive multi-scope pass locally — a scout plans review scopes from the repo's
structure, then one worker reviews each scope — and prints the aggregated findings, summary, and cost.
No GitHub. The provider credential is read from the same env var the action uses
(DEEPSEEK_API_KEY / ZAI_API_KEY / OPENAI_API_KEY).

Usage: node scripts/multi-scope-review.js [options]

  --repo <path>       Repository to review (default: current directory).
  --scope <text>      Free-text focus for the scout (default: whole repository).
  --provider <name>   Provider: auto (default), deepseek, codex, zai.
  --workers <N>       Max concurrent scope workers (default: 4).
  --model <id>        Override the provider default model.
  --base-url <url>    Override the provider endpoint base URL.
  --help              Show this help.
`;

// [LAW:effects-at-boundaries] Pure: parse argv into options, no IO.
function parseArgs(argv) {
  const opts = { repo: process.cwd(), provider: 'auto', workers: 4 };
  const known = new Set(['repo', 'scope', 'provider', 'workers', 'model', 'base-url']);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (!known.has(name)) throw new Error(`Unknown option: --${name}`);
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined) throw new Error(`Option --${name} requires a value.`);
    opts[name === 'base-url' ? 'baseUrl' : name] = value;
  }
  opts.workers = parseInt(opts.workers, 10);
  if (isNaN(opts.workers) || opts.workers < 1) throw new Error('--workers must be a positive integer.');
  return opts;
}

// [LAW:effects-at-boundaries] Lazy engine-stack require — only called inside main().
function resolveConfig(opts) {
  const { synthesizeProviderConfig } = require('../src/provider');
  return synthesizeProviderConfig({
    provider: opts.provider,
    openaiApiKey: process.env.OPENAI_API_KEY, openaiModel: opts.model, openaiBaseUrl: opts.baseUrl,
    deepseekApiKey: process.env.DEEPSEEK_API_KEY, deepseekModel: opts.model, deepseekBaseUrl: opts.baseUrl,
    zaiApiKey: process.env.ZAI_API_KEY, zaiModel: opts.model, zaiBaseUrl: opts.baseUrl,
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { process.stdout.write(USAGE); return; }

  // [LAW:no-ambient-temporal-coupling] Establish RUNNER_TEMP BEFORE requiring the engine stack so
  // debug.js computes TRANSCRIPT_DIR for this run. [LAW:effects-at-boundaries]
  const runTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-review-'));
  process.env.RUNNER_TEMP = runTemp;

  const registry = require('../src/engine/registry');
  const { runMultiScope, buildRepoMaterial } = require('../src/multiscope');
  const { renderRepoReport } = require('../src/report');
  const { buildAttributionFooter } = require('../src/failover');
  const { renderCostLine } = require('../src/usage');

  const repo = path.resolve(opts.repo);
  const scope = opts.scope || '';
  const config = resolveConfig(opts);
  const instructionsPath = path.join(__dirname, '..', 'review-agent', 'instructions.md');
  const log = msg => process.stderr.write(`[multi-review] ${msg}\n`);

  log(`reviewing ${repo} with ${config.name} (engine=${config.engine}, model=${config.model})…`);
  const { review, configUsed } = await runMultiScope({
    chain: [config], material: buildRepoMaterial({ scope, excludePatterns: [], reviewedRepoRoot: repo }),
    registry, instructionsPath, maxConcurrent: opts.workers, log,
  });

  const footer = [buildAttributionFooter(configUsed), renderCostLine(review.usage, configUsed)].filter(Boolean).join('\n\n');
  const report = renderRepoReport({ reviewerName: 'Multi-scope review', scope, review, footer });
  process.stdout.write(`\n${report}\n`);
}

if (require.main === module) {
  main().catch(err => {
    process.stderr.write(`multi-scope-review: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { parseArgs };
