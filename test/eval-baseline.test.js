'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseArgs, parseBand, parseCaseSummary, parseCaseEngine, parseFraction,
  sameEngine, pooledFloor, wilsonInterval, buildBaseline, parseBaseline, evaluateGate, decideLadder,
  renderBaselineMarkdown, DEGRADATION_RULE, BASELINE_SCHEMA,
} = require('../eval/baseline');

// [LAW:verifiable-goals] AC: baseline.js reduces the golden cases' scored summaries into one frozen
// distribution + a degradation rule. These tests exercise the PURE core (arg parse, input parsers, the
// reduction, the loader) with in-memory fixtures — no IO. [LAW:behavior-not-structure] They assert the
// frozen contract (the shape 2fk.5 loads + the consistency gates), not internals.

// A realistic scorecard-summary.json (score.js's aggregateRuns output), N=2. The inventory fractions match
// the frozen-round ones (a case with no inventory rounds) unless overridden.
function summaryFixture(overrides = {}) {
  return JSON.stringify({
    case: 'case-a', runs: 2, matcher: 'llm/deepseek-v4-flash',
    mustFindRecall: { mean: 0.5, min: 0.3333, max: 0.6667, n: 2 },
    inventoryMustFindRecall: { mean: 0.5, min: 0.3333, max: 0.6667, n: 2 },
    niceToFindRecall: { mean: 0.25, min: 0, max: 0.5, n: 2 },
    inventoryNiceToFindRecall: { mean: 0.25, min: 0, max: 0.5, n: 2 },
    noiseCount: { mean: 1, min: 0, max: 2, n: 2 },
    costUsd: { mean: 0.2, min: 0.18, max: 0.22, n: 2 },
    perRun: [
      { mustFind: '1/3', inventoryMustFind: '1/3', niceToFind: '0/2', noise: 0, costUsd: 0.18 },
      { mustFind: '2/3', inventoryMustFind: '2/3', niceToFind: '1/2', noise: 2, costUsd: 0.22 },
    ],
    ...overrides,
  });
}

const ENGINE = JSON.stringify({ name: 'case-a', engine: { provider: 'deepseek', model: 'deepseek-v4-pro', reasoning: null } });

// A parsed {summary, engine} case entry buildBaseline consumes. perRun.mustFind / .inventoryMustFind are the
// TYPED {found,total} parseCaseSummary produces at the boundary (buildBaseline no longer parses strings).
// The default perRun gives each run an inventory of 9 opportunities over the frozen round's 3.
function caseEntry(name, mustFindBand, opts = {}) {
  return {
    summary: {
      case: name, runs: opts.runs ?? 2, matcher: opts.matcher ?? 'llm/deepseek-v4-flash',
      mustFindRecall: mustFindBand,
      inventoryMustFindRecall: opts.inventoryBand ?? mustFindBand,
      niceToFindRecall: { mean: 0, min: 0, max: 0, n: 2 },
      inventoryNiceToFindRecall: { mean: 0.5, min: 0.5, max: 0.5, n: 2 },
      noiseCount: { mean: 1, min: 0, max: 2, n: 2 },
      costUsd: { mean: 0.2, min: 0.1, max: 0.3, n: 2 },
      perRun: opts.perRun ?? [
        { mustFind: { found: 1, total: 3 }, inventoryMustFind: { found: 3, total: 9 }, costUsd: 0.1 },
        { mustFind: { found: 2, total: 3 }, inventoryMustFind: { found: 4, total: 9 }, costUsd: 0.3 },
      ],
    },
    engine: opts.engine ?? { provider: 'deepseek', model: 'deepseek-v4-pro', reasoning: null },
  };
}

// ── arg parsing ────────────────────────────────────────────────────────────────────────────────────

test('parseArgs applies defaults and honors flags', () => {
  const d = parseArgs([]);
  assert.equal(d.outDir, 'eval/out');
  assert.equal(d.casesDir, 'eval/cases');
  assert.equal(d.dest, 'eval/baseline');
  assert.equal(d.sha, null);
  assert.equal(d.date, null);
  const o = parseArgs(['--out-dir', 'o', '--cases-dir=c', '--dest', 'd', '--sha', 'abc123', '--date=2026-08-01']);
  assert.deepEqual(o, { outDir: 'o', casesDir: 'c', dest: 'd', sha: 'abc123', date: '2026-08-01' });
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).help, true);
});

test('parseArgs rejects bad input loudly', () => {
  assert.throws(() => parseArgs(['positional']), /Unexpected argument/);
  assert.throws(() => parseArgs(['--nope', 'v']), /Unknown option/);
  assert.throws(() => parseArgs(['--sha']), /requires a non-empty value/);
  // A --prefixed value is a swallowed flag, not the argument.
  assert.throws(() => parseArgs(['--sha', '--date=x']), /requires a non-empty value/);
  // An empty value (=form or space-form) is rejected, not resolved to cwd downstream.
  assert.throws(() => parseArgs(['--out-dir=']), /requires a non-empty value/);
  assert.throws(() => parseArgs(['--out-dir', '']), /requires a non-empty value/);
});

// ── parseBand ──────────────────────────────────────────────────────────────────────────────────────

test('parseBand accepts numbers-or-null and a non-negative n; rejects the rest', () => {
  assert.deepEqual(parseBand({ mean: 0.5, min: 0.3, max: 0.7, n: 2 }, 'b'), { mean: 0.5, min: 0.3, max: 0.7, n: 2 });
  assert.deepEqual(parseBand({ mean: null, min: null, max: null, n: 0 }, 'b'), { mean: null, min: null, max: null, n: 0 });
  assert.throws(() => parseBand(null, 'b'), /not a band object/);
  assert.throws(() => parseBand([], 'b'), /not a band object/);
  assert.throws(() => parseBand({ mean: 'x', min: 0, max: 0, n: 1 }, 'b'), /mean must be a finite number or null/);
  assert.throws(() => parseBand({ mean: Infinity, min: 0, max: 0, n: 1 }, 'b'), /finite number or null/);
  assert.throws(() => parseBand({ mean: 0, min: 0, max: 0, n: -1 }, 'b'), /n must be a non-negative integer/);
  assert.throws(() => parseBand({ mean: 0, min: 0, max: 0, n: 1.5 }, 'b'), /n must be a non-negative integer/);
});

// ── parseCaseSummary ─────────────────────────────────────────────────────────────────────────────────

test('parseCaseSummary keeps the reduced fields and rejects malformed summaries', () => {
  const s = parseCaseSummary(summaryFixture(), 'sum.json');
  assert.equal(s.case, 'case-a');
  assert.equal(s.runs, 2);
  assert.equal(s.matcher, 'llm/deepseek-v4-flash');
  assert.deepEqual(s.mustFindRecall, { mean: 0.5, min: 0.3333, max: 0.6667, n: 2 });
  assert.deepEqual(s.inventoryMustFindRecall, { mean: 0.5, min: 0.3333, max: 0.6667, n: 2 });
  assert.equal(s.perRun.length, 2);
  assert.equal(s.perRun[0].costUsd, 0.18);
  // mustFind / inventoryMustFind are parsed to typed {found,total} at the boundary, not kept as raw strings.
  assert.deepEqual(s.perRun[0].mustFind, { found: 1, total: 3 });
  assert.deepEqual(s.perRun[0].inventoryMustFind, { found: 1, total: 3 });
  // Valid-but-wrong-typed JSON is rejected at the shared object boundary.
  assert.throws(() => parseCaseSummary('123', 'x'), /not a JSON object/);
  assert.throws(() => parseCaseSummary(summaryFixture({ case: '' }), 'x'), /no 'case' name/);
  assert.throws(() => parseCaseSummary(summaryFixture({ runs: 0 }), 'x'), /'runs' must be a positive integer/);
  assert.throws(() => parseCaseSummary(summaryFixture({ matcher: '' }), 'x'), /no 'matcher'/);
  assert.throws(() => parseCaseSummary(summaryFixture({ perRun: 'x' }), 'x'), /no 'perRun' array/);
  assert.throws(() => parseCaseSummary(summaryFixture({ mustFindRecall: { mean: 1 } }), 'x'), /mustFindRecall.*non-negative integer/s);
  // A pre-inventory (v1-era) summary is rejected loudly — re-score with the current scorer, never pool a
  // missing inventory as zero.
  assert.throws(() => parseCaseSummary(summaryFixture({ inventoryMustFindRecall: undefined }), 'x'), /inventoryMustFindRecall/);
  assert.throws(() => parseCaseSummary(summaryFixture({ inventoryNiceToFindRecall: undefined }), 'x'), /inventoryNiceToFindRecall/);
  // perRun length must agree with `runs` — a desync would silently pool the wrong total.
  assert.throws(() => parseCaseSummary(summaryFixture({ runs: 3 }), 'x'), /2 perRun entries but claims runs=3/);
  // A perRun entry with an absent or non-string fraction is rejected at the boundary (never leaks a null
  // into the reduction). Length is kept at 1 so the fraction check — not the length check — fires.
  assert.throws(() => parseCaseSummary(summaryFixture({ runs: 1, perRun: [{ costUsd: 0.1 }] }), 'x'), /mustFind must be a 'found\/total' string/);
  assert.throws(() => parseCaseSummary(summaryFixture({ runs: 1, perRun: [{ mustFind: 5 }] }), 'x'), /mustFind must be a 'found\/total' string/);
  assert.throws(() => parseCaseSummary(summaryFixture({ runs: 1, perRun: [{ mustFind: '1/3' }] }), 'x'), /inventoryMustFind must be a 'found\/total' string/);
  // A mustFind string that isn't a fraction is rejected too (parseFraction at the boundary).
  assert.throws(() => parseCaseSummary(summaryFixture({ runs: 1, perRun: [{ mustFind: 'n/a' }] }), 'x'), /not a 'found\/total' fraction/);
  // An inventory smaller than the frozen round is corrupt (the inventory pools a superset).
  assert.throws(() => parseCaseSummary(summaryFixture({ runs: 1, perRun: [{ mustFind: '2/3', inventoryMustFind: '1/2' }] }), 'x'), /smaller than mustFind/);
  // A non-numeric perRun cost is a corrupt summary, not a silent null.
  assert.throws(() => parseCaseSummary(summaryFixture({ runs: 1, perRun: [{ mustFind: '1/3', inventoryMustFind: '1/3', costUsd: 'free' }] }), 'x'), /perRun\[0\]\.costUsd/);
});

test('parseCaseSummary treats an absent perRun cost as null (cost unavailable that run)', () => {
  const s = parseCaseSummary(summaryFixture({ runs: 1, perRun: [{ mustFind: '1/3', inventoryMustFind: '2/6' }] }), 'x');
  assert.deepEqual(s.perRun[0].mustFind, { found: 1, total: 3 });
  assert.deepEqual(s.perRun[0].inventoryMustFind, { found: 2, total: 6 });
  assert.equal(s.perRun[0].costUsd, null);
});

// ── parseCaseEngine ──────────────────────────────────────────────────────────────────────────────────

test('parseCaseEngine reads the pinned engine and normalizes absent reasoning to null', () => {
  assert.deepEqual(parseCaseEngine(ENGINE, 'c'), { provider: 'deepseek', model: 'deepseek-v4-pro', reasoning: null });
  assert.throws(() => parseCaseEngine('{}', 'c'), /no 'engine' object/);
  assert.throws(() => parseCaseEngine(JSON.stringify({ engine: { model: 'm' } }), 'c'), /engine.provider is missing/);
  assert.throws(() => parseCaseEngine(JSON.stringify({ engine: { provider: 'p' } }), 'c'), /engine.model is missing/);
});

// ── sameEngine ───────────────────────────────────────────────────────────────────────────────────────

test('sameEngine compares every pin field, treating absent reasoning as null', () => {
  const base = { provider: 'deepseek', model: 'deepseek-v4-pro', reasoning: null };
  assert.equal(sameEngine(base, { ...base }), true);
  assert.equal(sameEngine(base, { provider: 'deepseek', model: 'deepseek-v4-pro' }), true);
  assert.equal(sameEngine(base, { ...base, model: 'other' }), false);
  assert.equal(sameEngine(base, { ...base, reasoning: 'high' }), false);
});

// ── buildBaseline (the reduction) ──────────────────────────────────────────────────────────────────

test('buildBaseline freezes diagnostic bands, the pooled gate, suite cost, and the rule', () => {
  const cases = [
    caseEntry('case-a', { mean: 0.5, min: 0.3333, max: 0.6667, n: 2 }),
    caseEntry('case-b', { mean: 1, min: 1, max: 1, n: 2 }),
  ];
  const b = buildBaseline({ cases, provenance: { sha: 'deadbeefcafe', date: '2026-08-01' } });
  assert.equal(b.schema, 'copirate-eval-baseline/v2');
  assert.equal(b.mainSha, 'deadbeefcafe');
  assert.equal(b.generatedAt, '2026-08-01');
  assert.equal(b.repeats, 2);
  assert.equal(b.matcher, 'llm/deepseek-v4-flash');
  assert.deepEqual(b.engine, { provider: 'deepseek', model: 'deepseek-v4-pro', reasoning: null });
  assert.deepEqual(b.degradationRule, DEGRADATION_RULE);
  // Per-case DIAGNOSTIC floor = the case's observed min INVENTORY must-find recall (not the gate).
  assert.equal(b.cases[0].diagnosticFloor, 0.3333);
  assert.equal(b.cases[1].diagnosticFloor, 1);
  assert.deepEqual(b.cases[0].perRun, ['1/3', '2/3']);
  assert.deepEqual(b.cases[0].perRunInventory, ['3/9', '4/9']);
  // The inventory nice-to-find band is carried per-case (json-only, like the frozen-round nice band).
  assert.deepEqual(b.cases[0].inventoryNiceToFindRecall, { mean: 0.5, min: 0.5, max: 0.5, n: 2 });
  // PRIMARY GATE: pooled INVENTORY recall across every run of every case. Both cases run perRunInventory
  // ['3/9','4/9'] ⇒ each pools 7 found / 18 opportunities; two cases ⇒ 14/36, with a ~2σ lower bound floor.
  assert.equal(b.suite.pooledInventoryMustFind.found, 14);
  assert.equal(b.suite.pooledInventoryMustFind.opportunities, 36);
  assert.equal(b.suite.pooledInventoryMustFind.rate, Math.round((14 / 36) * 1e4) / 1e4);
  assert.equal(b.suite.pooledInventoryMustFind.gateFloor, Math.round(pooledFloor(14, 36) * 1e4) / 1e4);
  assert.ok(b.suite.pooledInventoryMustFind.gateFloor < 14 / 36 && b.suite.pooledInventoryMustFind.gateFloor > 0);
  // Continuity DIAGNOSTIC: the frozen-round pooled rate, computed exactly as v1 did.
  assert.equal(b.suite.pooledMustFind.found, 6);
  assert.equal(b.suite.pooledMustFind.opportunities, 12);
  assert.equal(b.suite.pooledMustFind.rate, 0.5);
  // Suite cost = sum of every run's cost across cases; per-full-run = total / N.
  assert.equal(b.suite.cases, 2);
  assert.equal(b.suite.totalCostUsd, 0.8); // (0.1+0.3) + (0.1+0.3)
  assert.equal(b.suite.costPerFullRunUsd, 0.4);
  assert.equal(b.suite.costedRuns, 4);
  assert.equal(b.suite.uncostedRuns, 0);
  // Informational headline recall = unweighted mean of the per-case INVENTORY means (the gate's axis).
  assert.equal(b.suite.meanInventoryMustFindRecall, 0.75);
});

test('parseFraction reads found/total and rejects non-fractions', () => {
  assert.deepEqual(parseFraction('1/7', 'x'), { found: 1, total: 7 });
  assert.deepEqual(parseFraction('0/0', 'x'), { found: 0, total: 0 });
  assert.throws(() => parseFraction('n/a', 'x'), /not a 'found\/total' fraction/);
  assert.throws(() => parseFraction('1.5/3', 'x'), /not a 'found\/total' fraction/);
  assert.throws(() => parseFraction('5/3', 'x'), /found > total/);
});

test('pooledFloor is a ~2σ binomial lower bound in [0, rate)', () => {
  const f = pooledFloor(14, 75); // the real baseline shape
  assert.ok(f > 0 && f < 14 / 75);
  assert.equal(pooledFloor(0, 0), null); // no opportunities → no floor
  assert.equal(pooledFloor(10, 10), 1);  // p=1 ⇒ se=0 ⇒ floor=1
});

test('buildBaseline counts uncosted runs and excludes them from the total', () => {
  const cases = [caseEntry('case-a', { mean: 0.5, min: 0.5, max: 0.5, n: 1 }, {
    perRun: [
      { mustFind: { found: 1, total: 2 }, inventoryMustFind: { found: 1, total: 2 }, costUsd: 0.15 },
      { mustFind: { found: 1, total: 2 }, inventoryMustFind: { found: 1, total: 2 }, costUsd: null },
    ],
  })];
  const b = buildBaseline({ cases, provenance: { sha: 'abc', date: '2026-08-01' } });
  assert.equal(b.suite.totalCostUsd, 0.15);
  assert.equal(b.suite.costedRuns, 1);
  assert.equal(b.suite.uncostedRuns, 1);
  // Per-full-run cost is NOT computed from a partial sum — it's null when any run is uncosted, never a
  // misleadingly precise underestimate.
  assert.equal(b.suite.costPerFullRunUsd, null);
});

test('buildBaseline computes per-full-run cost only when every run is costed', () => {
  const cases = [caseEntry('case-a', { mean: 0.5, min: 0.5, max: 0.5, n: 2 })]; // default perRun both costed (0.1, 0.3)
  const b = buildBaseline({ cases, provenance: { sha: 'abc', date: '2026-08-01' } });
  assert.equal(b.suite.uncostedRuns, 0);
  assert.equal(b.suite.totalCostUsd, 0.4);
  assert.equal(b.suite.costPerFullRunUsd, 0.2); // 0.4 / 2 repeats
});

test('buildBaseline refuses an inconsistent or empty suite loudly', () => {
  assert.throws(() => buildBaseline({ cases: [], provenance: { sha: 'a', date: 'd' } }), /no scored cases/);
  // Mixed N.
  assert.throws(() => buildBaseline({
    cases: [caseEntry('a', { mean: 1, min: 1, max: 1, n: 2 }), caseEntry('b', { mean: 1, min: 1, max: 1, n: 3 }, { runs: 3 })],
    provenance: { sha: 'a', date: 'd' },
  }), /one common N/);
  // Mixed matcher.
  assert.throws(() => buildBaseline({
    cases: [caseEntry('a', { mean: 1, min: 1, max: 1, n: 2 }), caseEntry('b', { mean: 1, min: 1, max: 1, n: 2 }, { matcher: 'lexical' })],
    provenance: { sha: 'a', date: 'd' },
  }), /one matcher/);
  // Mixed engine.
  assert.throws(() => buildBaseline({
    cases: [caseEntry('a', { mean: 1, min: 1, max: 1, n: 2 }), caseEntry('b', { mean: 1, min: 1, max: 1, n: 2 }, { engine: { provider: 'zai', model: 'glm', reasoning: null } })],
    provenance: { sha: 'a', date: 'd' },
  }), /one engine/);
  // Zero inventory must-find opportunities (every perRun is 0/0) — not a gradeable baseline. Refusing at the
  // producer keeps its output loadable by parseBaseline (which requires opportunities>=1 + a finite gate floor).
  assert.throws(() => buildBaseline({
    cases: [caseEntry('a', { mean: null, min: null, max: null, n: 0 }, {
      perRun: [
        { mustFind: { found: 0, total: 0 }, inventoryMustFind: { found: 0, total: 0 }, costUsd: 0.1 },
        { mustFind: { found: 0, total: 0 }, inventoryMustFind: { found: 0, total: 0 }, costUsd: 0.1 },
      ],
    })],
    provenance: { sha: 'a', date: 'd' },
  }), /zero inventory must-find opportunities/);
});

// ── parseBaseline (the loader 2fk.5 reuses) round-trips buildBaseline ────────────────────────────────

test('parseBaseline round-trips a frozen baseline and rejects a foreign one', () => {
  const cases = [caseEntry('case-a', { mean: 0.5, min: 0.3333, max: 0.6667, n: 2 }, { inventoryBand: { mean: 7 / 18, min: 3 / 9, max: 4 / 9, n: 2 } })];
  const frozen = buildBaseline({ cases, provenance: { sha: 'deadbeef', date: '2026-08-01' } });
  const loaded = parseBaseline(JSON.stringify(frozen), 'baseline.json');
  assert.equal(loaded.mainSha, 'deadbeef');
  assert.equal(loaded.repeats, 2);
  assert.equal(loaded.cases[0].case, 'case-a');
  assert.equal(loaded.cases[0].diagnosticFloor, 3 / 9);
  assert.deepEqual(loaded.cases[0].inventoryMustFindRecall, { mean: 7 / 18, min: 3 / 9, max: 4 / 9, n: 2 });
  // The pooled inventory gate — the number 2fk.5 compares against — is loaded and typed.
  assert.equal(loaded.pooledInventoryMustFind.found, 7);
  assert.equal(loaded.pooledInventoryMustFind.opportunities, 18);
  assert.ok(typeof loaded.pooledInventoryMustFind.gateFloor === 'number');
  // A non-v2 schema (including a pre-inventory v1 baseline), a missing sha, a missing pooled gate, or an
  // empty case set is refused.
  // Derived from the constant, not the current spelling: an assertion pinned to "v2" goes red on the
  // schema bump this constant exists to make safe, which is the test asserting a message's wording
  // rather than its contract. [LAW:behavior-not-structure] [LAW:one-source-of-truth]
  const wrongSchema = new RegExp(`is not schema ${BASELINE_SCHEMA.replace(/[/]/g, '\\/')}`);
  assert.throws(() => parseBaseline('{}', 'x'), wrongSchema);
  assert.throws(() => parseBaseline(JSON.stringify({ ...frozen, schema: 'copirate-eval-baseline/v1' }), 'x'), wrongSchema);
  assert.throws(() => parseBaseline(JSON.stringify({ ...frozen, mainSha: '' }), 'x'), /no 'mainSha'/);
  assert.throws(() => parseBaseline(JSON.stringify({ ...frozen, cases: [] }), 'x'), /no 'cases'/);
  assert.throws(() => parseBaseline(JSON.stringify({ ...frozen, suite: { ...frozen.suite, pooledInventoryMustFind: undefined } }), 'x'), /no 'suite.pooledInventoryMustFind'/);
  assert.throws(() => parseBaseline(JSON.stringify({ ...frozen, cases: [{ case: 'a', diagnosticFloor: 'bad', inventoryMustFindRecall: { mean: 1, min: 1, max: 1, n: 1 } }] }), 'x'), /diagnosticFloor must be a finite number or null/);
});

// ── evaluateGate (the degradation verdict) ───────────────────────────────────────────────────────────

// [LAW:verifiable-goals] The ticket's acceptance: the gate FAILS when a change drops pooled inventory
// recall below the frozen baseline's floor — proven here as behavior, not asserted in prose.
test('evaluateGate fails a candidate below the frozen floor and passes one at or above it', () => {
  const cases = [caseEntry('case-a', { mean: 0.5, min: 0.3333, max: 0.6667, n: 2 })];
  const baseline = parseBaseline(JSON.stringify(buildBaseline({ cases, provenance: { sha: 'deadbeef', date: '2026-08-01' } })), 'b');
  const floor = baseline.pooledInventoryMustFind.gateFloor; // 7/18 minus ~2σ ≈ 0.16
  assert.ok(floor > 0 && floor < 7 / 18);
  // A candidate whose pooled inventory recall dropped below the floor is DEGRADED.
  const failing = evaluateGate(baseline, { found: 1, opportunities: 18 });
  assert.equal(failing.degraded, true);
  assert.equal(failing.gateFloor, floor);
  assert.ok(failing.candidateRate < floor);
  // A candidate at the baseline rate (sampling jitter, not degradation) passes.
  assert.equal(evaluateGate(baseline, { found: 7, opportunities: 18 }).degraded, false);
  // Exactly at the floor is NOT degraded (the rule is strict `lt`).
  const atFloor = { found: Math.ceil(floor * 18), opportunities: 18 };
  assert.equal(evaluateGate(baseline, atFloor).degraded, atFloor.found / 18 < floor);
  // Malformed candidates are refused loudly, never silently passed or failed.
  assert.throws(() => evaluateGate(baseline, { found: 1, opportunities: 0 }), /positive opportunities/);
  assert.throws(() => evaluateGate(baseline, { found: 0.5, opportunities: 2 }), /integer found/);
  assert.throws(() => evaluateGate(baseline, { found: 9, opportunities: 3 }), /found > opportunities/);
});

// ── rendering ────────────────────────────────────────────────────────────────────────────────────────

test('renderBaselineMarkdown surfaces the headline, per-case band, floor, and rule', () => {
  const cases = [caseEntry('case-a', { mean: 0.5, min: 0.3333, max: 0.6667, n: 2 })];
  const md = renderBaselineMarkdown(buildBaseline({ cases, provenance: { sha: 'deadbeefcafe1234', date: '2026-08-01' } }));
  assert.match(md, /# Eval baseline — deadbee \(2026-08-01\)/);
  assert.match(md, /deepseek-v4-pro/);
  assert.match(md, /Repeats \(N\):\*\* 2/);
  assert.match(md, /PRIMARY GATE — pooled inventory must-find recall/);
  assert.match(md, /Frozen-round pooled must-find recall/);
  assert.match(md, /`case-a`/);
  assert.match(md, /3\/9 · 4\/9/); // per-run inventory fractions in the diagnostic table
  assert.match(md, /## Degradation rule/);
  assert.match(md, /candidate\.suite\.pooledInventoryMustFind\.rate </);
});

// ── the ladder: how deep the gate has to go, and what it costs in fidelity ────────────────────────────
//
// [LAW:verifiable-goals] AC (zai-eval-harness-5ux): "the replay count is DERIVED from where the candidate
// sits against the floor, with N=5 only as a termination ceiling", and "gate sensitivity is not reduced".
// The second is the one that has to be DEMONSTRATED rather than argued, and the demonstration is
// exhaustive rather than sampled: every reachable state is enumerated, so this is a proof over the whole
// state space, not evidence from a lucky draw.

// The real shape the gate ships with: the 2026-09-08 suite is 3 cases contributing 10 + 4 + 4 must-finds
// per wave over a ceiling of N=5, pooled 37/90 with a ~2σ floor. Written out rather than imported so a
// re-freeze that moves the numbers cannot quietly move what this proves.
const LADDER_BASELINE = { pooledInventoryMustFind: { found: 37, opportunities: 90, rate: 0.4111, gateFloor: 0.3095 } };
const WAVE_OPPORTUNITIES = 18;
const CEILING = 5;

test('wilsonInterval brackets the rate and stays inside [0,1] at the extremes the normal approximation breaks at', () => {
  const mid = wilsonInterval(9, 18);
  assert.ok(mid.lower < 0.5 && mid.upper > 0.5, 'the interval must bracket the point estimate');
  // The reason this is Wilson and not the normal approximation the floor is cut with: at 0 finds the
  // normal interval collapses to [0,0] and would claim certainty it has not earned, buying an early exit
  // on no evidence. Wilson keeps real width, and never leaves the unit interval.
  assert.equal(wilsonInterval(0, 18).lower, 0);
  assert.ok(wilsonInterval(0, 18).upper > 0.15, 'zero finds out of 18 is not proof of a zero rate');
  assert.equal(wilsonInterval(18, 18).upper, 1);
  assert.ok(wilsonInterval(18, 18).lower < 1);
  // Wider at smaller samples — the property the whole ladder rests on.
  assert.ok((wilsonInterval(4, 18).upper - wilsonInterval(4, 18).lower) > (wilsonInterval(20, 90).upper - wilsonInterval(20, 90).lower));
  assert.throws(() => wilsonInterval(19, 18), /needs 0 <= found <= total/);
  assert.throws(() => wilsonInterval(0, 0), /total >= 1/);
});

test('EVERY certain decision is the full-depth verdict — proved over every state and every completion', () => {
  let certain = 0;
  for (let depth = 1; depth <= CEILING; depth++) {
    const opportunities = WAVE_OPPORTUNITIES * depth;
    const remaining = WAVE_OPPORTUNITIES * (CEILING - depth);
    for (let found = 0; found <= opportunities; found++) {
      const decision = decideLadder(LADDER_BASELINE, { found, opportunities });
      if (decision.basis !== 'certain') continue;
      certain++;
      // The claim 'certain' makes is that no way the remaining waves could land changes the answer. So
      // check every way they could land — not a sample of them.
      for (let extra = 0; extra <= remaining; extra++) {
        const atCeiling = evaluateGate(LADDER_BASELINE, { found: found + extra, opportunities: 90 });
        assert.equal(atCeiling.degraded ? 'degraded' : 'ok', decision.kind,
          `certain '${decision.kind}' at ${found}/${opportunities} is contradicted by a completion finding ${extra} more`);
      }
    }
  }
  assert.ok(certain > 100, `expected the certainty bounds to decide many states, decided ${certain}`);
});

test('a screened decision always puts the point estimate on the side it claims', () => {
  for (let depth = 1; depth <= CEILING; depth++) {
    const opportunities = WAVE_OPPORTUNITIES * depth;
    for (let found = 0; found <= opportunities; found++) {
      const decision = decideLadder(LADDER_BASELINE, { found, opportunities });
      if (decision.basis !== 'screened') continue;
      const rate = found / opportunities;
      assert.equal(rate < decision.gateFloor, decision.kind === 'degraded',
        `screened '${decision.kind}' at ${found}/${opportunities} (${rate}) contradicts the floor ${decision.gateFloor}`);
    }
  }
});

test('the ceiling always decides, and decides exactly what evaluateGate does — no special case for the top rung', () => {
  for (let found = 0; found <= 90; found++) {
    const decision = decideLadder(LADDER_BASELINE, { found, opportunities: 90 });
    assert.notEqual(decision.kind, 'continue', `full depth at ${found}/90 failed to terminate`);
    assert.equal(decision.basis, 'certain');
    assert.equal(decision.kind === 'degraded', evaluateGate(LADDER_BASELINE, { found, opportunities: 90 }).degraded);
    assert.equal(decision.remainingOpportunities, 0);
  }
});

test('the ladder reds a sabotaged candidate at the first wave, and never at a cost the full suite would not have paid', () => {
  // A candidate that has lost most of its finding ability — the deliberate sabotage the acceptance asks
  // for, expressed as counts rather than as a claim about some other program. At 1 of 18 the whole
  // interval sits under the floor, so it reds on the FIRST wave: 3 replays instead of 15.
  const sabotaged = decideLadder(LADDER_BASELINE, { found: 1, opportunities: 18 });
  assert.equal(sabotaged.kind, 'degraded');
  assert.equal(sabotaged.basis, 'screened');
  // And it is the same answer the full suite would reach: even finding every one of the 72 remaining
  // opportunities, 73/90 would clear the floor — so this one is screened, not certain, and the test says
  // which. What must never happen is the opposite: a sabotaged candidate coming back OK.
  assert.notEqual(decideLadder(LADDER_BASELINE, { found: 0, opportunities: 18 }).kind, 'ok');
  assert.notEqual(decideLadder(LADDER_BASELINE, { found: 2, opportunities: 36 }).kind, 'ok');
  assert.notEqual(decideLadder(LADDER_BASELINE, { found: 5, opportunities: 54 }).kind, 'ok');
});

test('decideLadder refuses a rung above the ceiling rather than extrapolating past it', () => {
  assert.throws(() => decideLadder(LADDER_BASELINE, { found: 40, opportunities: 108 }),
    /past the baseline's full-depth 90 — there is no rung above the ceiling/);
});
