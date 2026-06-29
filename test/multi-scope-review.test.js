'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseScopes,
  structuralProse,
  workerFocusText,
  dedupeFindings,
  sumUsage,
  composeSummary,
  runScopeWorkers,
  buildPrMaterial,
  buildRepoMaterial,
} = require('../src/multiscope');
const { buildReviewInput, buildPrScoutInput, buildRepoScoutInput } = require('../src/prompt');
const { TransientError } = require('../src/failover');
const { parseArgs } = require('../scripts/multi-scope-review');

const TOOL_NAMES = {
  requestChange: 'mcp__review_collector__request_change',
  finishReview: 'mcp__review_collector__finish_review',
};
const REPO_ROOT = '/home/runner/work/acme/acme';

// ── parseScopes — the loud backstop for whatever the (weak) scout emits ──────────────────────────

describe('parseScopes', () => {
  test('extracts a JSON scope array embedded in prose', () => {
    const summary = 'This is a CLI tool.\n[{"name":"cost","focus":"src/usage.js — the price table"}]';
    const scopes = parseScopes(summary);
    assert.equal(scopes.length, 1);
    assert.deepEqual(scopes[0], { name: 'cost', focus: 'src/usage.js — the price table' });
  });

  test('parses multiple scopes and trims whitespace in fields', () => {
    const summary = '[{"name":" a ","focus":" foo "},{"name":"b","focus":"bar"}]';
    const scopes = parseScopes(summary);
    assert.deepEqual(scopes, [{ name: 'a', focus: 'foo' }, { name: 'b', focus: 'bar' }]);
  });

  test('takes the FIRST balanced array when prose contains more than one', () => {
    const summary = '[{"name":"a","focus":"x"}]\nLATER: [{"name":"b","focus":"y"}]';
    const scopes = parseScopes(summary);
    assert.equal(scopes.length, 1);
    assert.equal(scopes[0].name, 'a');
  });

  test('throws with the raw summary when no JSON array is present', () => {
    assert.throws(() => parseScopes('No JSON here at all.'), /Scout did not produce a JSON scope array/);
  });

  test('throws when the array is malformed JSON', () => {
    assert.throws(() => parseScopes('[{bad json}]'), /not valid JSON/);
  });

  test('throws on an empty array — never a vacuous zero-scope plan', () => {
    assert.throws(() => parseScopes('[]'), /non-empty JSON array/);
  });

  test('throws when a scope is missing its focus', () => {
    assert.throws(() => parseScopes('[{"name":"a"}]'), /invalid or empty focus/);
  });

  test('throws when a scope is missing its name', () => {
    assert.throws(() => parseScopes('[{"focus":"x"}]'), /invalid or empty name/);
  });

  test('throws when a scope is not an object', () => {
    assert.throws(() => parseScopes('["just a string"]'), /is not an object/);
  });
});

// ── structuralProse / workerFocusText — the context handed to each worker ─────────────────────────

describe('structuralProse', () => {
  test('returns everything before the JSON array, trimmed', () => {
    assert.equal(structuralProse('Prose here.\n\n[{"name":"a","focus":"x"}]'), 'Prose here.');
  });
  test('returns the whole string trimmed when there is no array', () => {
    assert.equal(structuralProse('  just prose  '), 'just prose');
  });
});

describe('workerFocusText', () => {
  test('prepends structural context when present', () => {
    const text = workerFocusText({ name: 'cost', focus: 'src/usage.js' }, 'A CLI tool.');
    assert.match(text, /Structural context from the planning pass:\nA CLI tool\./);
    assert.match(text, /cost — src\/usage\.js/);
  });
  test('omits the context block when context is empty', () => {
    const text = workerFocusText({ name: 'cost', focus: 'src/usage.js' }, '');
    assert.doesNotMatch(text, /Structural context/);
    assert.equal(text, 'cost — src/usage.js');
  });
});

// ── dedupeFindings ────────────────────────────────────────────────────────────────────────────

describe('dedupeFindings', () => {
  test('drops duplicates by path:line:body-prefix, preserving order', () => {
    const findings = [
      { path: 'a.js', line: 1, body: '[LAW:x] foo' },
      { path: 'b.js', line: 2, body: '[LAW:y] bar' },
      { path: 'a.js', line: 1, body: '[LAW:x] foo' },
    ];
    const out = dedupeFindings(findings);
    assert.equal(out.length, 2);
    assert.deepEqual(out.map(f => f.path), ['a.js', 'b.js']);
  });

  test('keeps two findings on the same line with different bodies', () => {
    const out = dedupeFindings([
      { path: 'a.js', line: 1, body: 'first distinct issue here' },
      { path: 'a.js', line: 1, body: 'second different issue here' },
    ]);
    assert.equal(out.length, 2);
  });
});

// ── sumUsage — cost is uniform because every spawn shares one config ──────────────────────────────

describe('sumUsage', () => {
  test('sums tokens and available cost across spawns', () => {
    const total = sumUsage([
      { inputTokens: 10, outputTokens: 5, cost: { available: true, usd: 0.1 } },
      { inputTokens: 20, outputTokens: 7, cost: { available: true, usd: 0.2 } },
    ]);
    assert.equal(total.inputTokens, 30);
    assert.equal(total.outputTokens, 12);
    assert.equal(total.cost.available, true);
    assert.ok(Math.abs(total.cost.usd - 0.3) < 1e-9);
  });

  test('any unavailable cost makes the total unavailable, carrying its reason', () => {
    const total = sumUsage([
      { inputTokens: 10, outputTokens: 5, cost: { available: true, usd: 0.1 } },
      { inputTokens: 20, outputTokens: 7, cost: { available: false, reason: 'no-price' } },
    ]);
    assert.equal(total.cost.available, false);
    assert.equal(total.cost.reason, 'no-price');
    assert.equal(total.inputTokens, 30); // tokens still sum
  });

  test('excludes null usages but still sums the present ones', () => {
    const total = sumUsage([null, { inputTokens: 4, outputTokens: 2, cost: { available: true, usd: 0.05 } }]);
    assert.equal(total.inputTokens, 4);
    assert.equal(total.cost.usd, 0.05);
  });

  test('returns null when no spawn reported usage', () => {
    assert.equal(sumUsage([null, null]), null);
    assert.equal(sumUsage([]), null);
  });
});

// ── composeSummary ────────────────────────────────────────────────────────────────────────────

describe('composeSummary', () => {
  const scopes = [{ name: 'cost', focus: 'x' }, { name: 'diff', focus: 'y' }];
  test('names every scope and carries each worker summary, never raw JSON', () => {
    const summary = composeSummary(scopes, [
      { name: 'cost', summary: 'Looks fine.' },
      { name: 'diff', summary: 'One issue.' },
    ]);
    assert.match(summary, /Reviewed 2 scope\(s\): cost, diff\./);
    assert.match(summary, /\*\*cost\*\* — Looks fine\./);
    assert.match(summary, /\*\*diff\*\* — One issue\./);
    assert.doesNotMatch(summary, /[[{]"name"/);
  });
  test('renders a placeholder for an empty worker summary', () => {
    const summary = composeSummary([{ name: 'a', focus: 'x' }], [{ name: 'a', summary: '' }]);
    assert.match(summary, /\*\*a\*\* — \(no summary\)/);
  });
});

// ── runScopeWorkers — fail-loud bounded pool ─────────────────────────────────────────────────────

describe('runScopeWorkers', () => {
  test('returns results in scope order regardless of completion order', async () => {
    const scopes = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
    const runOne = async (s) => {
      await new Promise(r => setTimeout(r, s.name === 'a' ? 5 : 0)); // a finishes last
      return { name: s.name };
    };
    const results = await runScopeWorkers({ scopes, runOne, maxConcurrent: 3 });
    assert.deepEqual(results.map(r => r.name), ['a', 'b', 'c']);
  });

  test('rethrows the first error, preserving its type, so failover can classify it', async () => {
    const scopes = [{ name: 'a' }, { name: 'b' }];
    const runOne = async (s) => { if (s.name === 'b') throw new TransientError('rate-limited'); return { name: s.name }; };
    await assert.rejects(
      runScopeWorkers({ scopes, runOne, maxConcurrent: 1 }),
      (err) => err instanceof TransientError && /rate-limited/.test(err.message),
    );
  });

  test('a non-transient worker error propagates (never swallowed into an empty result)', async () => {
    const scopes = [{ name: 'a' }];
    const runOne = async () => { throw new Error('engine produced garbage'); };
    await assert.rejects(runScopeWorkers({ scopes, runOne, maxConcurrent: 2 }), /engine produced garbage/);
  });
});

// ── materials — closures that build the real engine prompts ──────────────────────────────────────

describe('buildPrMaterial', () => {
  const files = [{ filename: 'src/a.js', status: 'modified', patch: '@@ -1,1 +1,1 @@\n+const x = 1;' }];
  const material = buildPrMaterial({ files, maxDiffChars: 0, reviewedRepoRoot: REPO_ROOT });

  test('scout prompt lists the changed file paths and the scope-array contract', () => {
    const prompt = material.buildScoutPrompt(TOOL_NAMES);
    assert.match(prompt, /src\/a\.js/);
    assert.match(prompt, /JSON array of review scopes/);
    assert.match(prompt, /mcp__review_collector__finish_review/);
  });

  test('worker prompt is the diff review with a CONCENTRATE focus block', () => {
    const prompt = material.buildWorkerPrompt('cost — src/usage.js', TOOL_NAMES);
    assert.match(prompt, /CONCENTRATE THIS REVIEW on one part of the change: cost — src\/usage\.js/);
    assert.match(prompt, /```diff/);
  });
});

describe('buildRepoMaterial', () => {
  const material = buildRepoMaterial({ scope: '', excludePatterns: [], reviewedRepoRoot: REPO_ROOT });

  test('scout prompt surveys the tree and emits the scope-array contract', () => {
    const prompt = material.buildScoutPrompt(TOOL_NAMES);
    assert.match(prompt, /There is no diff/);
    assert.match(prompt, /JSON array of review scopes/);
  });

  test('worker prompt is a focused whole-repo review (the scope focus IS the repo scope)', () => {
    const prompt = material.buildWorkerPrompt('cost — src/usage.js', TOOL_NAMES);
    assert.match(prompt, /Focus this review on the following scope[^]*cost — src\/usage\.js/);
    assert.match(prompt, /PRE-EXISTING issues in any file ARE in scope/);
  });
});

// ── scout prompts — adaptive by grouping, never by a counted threshold ────────────────────────────

describe('scout prompts carry no size threshold', () => {
  const prScout = buildPrScoutInput({ changedPaths: ['src/a.js', 'src/b.js'], toolNames: TOOL_NAMES, reviewedRepoRoot: REPO_ROOT }).prompt;
  const repoScout = buildRepoScoutInput({ scope: '', excludePatterns: [], toolNames: TOOL_NAMES, reviewedRepoRoot: REPO_ROOT }).prompt;

  test('both tie the scope count to the number of concerns, never a target number', () => {
    assert.match(prScout, /number of scopes EQUALS the number of distinct concerns/);
    assert.match(repoScout, /number of scopes EQUALS the number of distinct concerns/);
  });

  test('both fold boundary review INTO a scope rather than emitting a scope per import edge', () => {
    // The 25-scope explosion came from a separate boundary scope per importing pair; the rule now
    // reviews boundaries from inside a scope, so the count stays linear in concerns.
    assert.match(prScout, /do NOT create a separate scope for a boundary/);
    assert.match(repoScout, /do NOT create a separate scope for a boundary/);
    assert.match(prScout, /ALSO read the files this group imports/);
  });

  test('both forward the engine tool identifiers, never hardcoded names', () => {
    const custom = { requestChange: 'tool_rc', finishReview: 'tool_fr' };
    const p = buildPrScoutInput({ changedPaths: ['src/a.js'], toolNames: custom, reviewedRepoRoot: REPO_ROOT }).prompt;
    assert.match(p, /tool_fr/);
    assert.doesNotMatch(p, /mcp__review_collector__finish_review/);
  });

  test('a non-empty repo scope BOUNDS grouping to the focus, not a soft hint', () => {
    const focused = buildRepoScoutInput({ scope: 'the auth layer', excludePatterns: ['*.lock'], toolNames: TOOL_NAMES, reviewedRepoRoot: REPO_ROOT }).prompt;
    assert.match(focused, /focused this review on: the auth layer/);
    assert.match(focused, /ONLY for files inside that focus/);
    assert.doesNotMatch(focused, /follow the code outward/);
    assert.match(focused, /excluded patterns in any scope: \*\.lock/);
  });

  test('an empty repo scope puts the whole repository in bounds', () => {
    assert.match(repoScout, /Cover the whole repository/);
  });
});

// ── buildReviewInput focus value (the single-scope vs narrowed distinction) ───────────────────────

describe('buildReviewInput focus', () => {
  const FILES = [{ filename: 'src/a.js', status: 'modified', patch: '@@ -1,1 +1,1 @@\n+const x = 1;' }];

  test('empty focus renders no CONCENTRATE block (the broad whole-diff review)', () => {
    const { prompt } = buildReviewInput(FILES, 0, TOOL_NAMES, REPO_ROOT);
    assert.doesNotMatch(prompt, /CONCENTRATE THIS REVIEW/);
  });

  test('a non-empty focus renders the CONCENTRATE block with the focus text', () => {
    const { prompt } = buildReviewInput(FILES, 0, TOOL_NAMES, REPO_ROOT, 'cost — src/usage.js');
    assert.match(prompt, /CONCENTRATE THIS REVIEW on one part of the change: cost — src\/usage\.js/);
  });
});

// ── parseArgs (the dev script's CLI) ─────────────────────────────────────────────────────────────

describe('parseArgs', () => {
  test('defaults: repo=cwd, provider=auto, workers=4', () => {
    const opts = parseArgs([]);
    assert.equal(opts.provider, 'auto');
    assert.equal(opts.workers, 4);
  });

  test('--workers parses as an integer', () => {
    assert.equal(parseArgs(['--workers', '6']).workers, 6);
  });

  test('--scope is accepted and captured', () => {
    assert.equal(parseArgs(['--scope', 'the auth layer']).scope, 'the auth layer');
  });

  test('--help returns { help: true }', () => {
    assert.deepEqual(parseArgs(['--help']), { help: true });
  });

  test('throws on unknown option', () => {
    assert.throws(() => parseArgs(['--bogus', 'x']), /Unknown option/);
  });

  test('throws on a non-positive --workers', () => {
    assert.throws(() => parseArgs(['--workers', '0']), /positive integer/);
  });
});
