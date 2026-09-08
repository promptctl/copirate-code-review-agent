'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  parseArgs, replayArgs, jobTimeoutMinutes, expectedMatcherLabel, estimateCandidateCostUsd,
  compareVerdict, renderVerdictMarkdown, resolveBaselineJsonPath, computeExpectedOpportunities,
  completedDepth, affordsAnotherWave, foldSpend,
} = require('../eval/compare');
const { buildBaseline, parseBaseline } = require('../eval/baseline');
const { JUDGE_MODEL } = require('../eval/score');

// [LAW:verifiable-goals] AC: compare.js gates a candidate suite against a frozen baseline and emits a
// DEGRADED/OK/IMPROVED verdict (non-zero exit on DEGRADED). These tests exercise the PURE core — arg parse,
// the matcher-label pre-check, the cost estimate, the comparison, the rendering — with in-memory fixtures.
// No IO, no spawn. [LAW:behavior-not-structure] They assert the gate contract, not internals.

// A candidate SUITE is exactly buildBaseline's output — build fixtures through it so the test can't drift
// from the real reducer. Each case pools its perRun must-finds. `caseEntry` mirrors eval-baseline.test.js:
// the gate reads the INVENTORY band/fractions (the primary gate since the pooled-inventory refactor), so
// each perRun entry carries both the frozen-round and inventory fractions — here identical (no extra
// inventory rounds), matching a case with a single frozen round.
function caseEntry(name, mustFindBand, perRun, engine) {
  return {
    summary: {
      case: name, runs: perRun.length, matcher: 'llm/deepseek-v4-flash',
      mustFindRecall: mustFindBand,
      inventoryMustFindRecall: mustFindBand,
      niceToFindRecall: { mean: 0, min: 0, max: 0, n: perRun.length },
      inventoryNiceToFindRecall: { mean: 0, min: 0, max: 0, n: perRun.length },
      noiseCount: { mean: 1, min: 0, max: 2, n: perRun.length },
      costUsd: { mean: 0.2, min: 0.1, max: 0.3, n: perRun.length },
      perRun: perRun.map(([found, total], i) => ({
        mustFind: { found, total }, inventoryMustFind: { found, total }, costUsd: 0.1 + i * 0.05,
      })),
    },
    engine: engine ?? { provider: 'deepseek', model: 'deepseek-v4-pro', reasoning: null },
  };
}

// A frozen baseline (parseBaseline output) built from the SAME reducer, then loaded — so baseline and
// candidate share one producer, exactly as production does.
function frozenBaseline(cases, provenance = { sha: 'basesha0', date: '2026-08-01' }) {
  return parseBaseline(JSON.stringify(buildBaseline({ cases, provenance })), 'baseline.json');
}
function candidateSuite(cases, provenance = { sha: 'candsha0', date: '2026-08-02' }) {
  return buildBaseline({ cases, provenance });
}

// The verdict RECORD exactly as main() assembles it — the comparison plus what the run cost. The renderer
// takes this and verdict.json holds this, so a test that renders is also a test of what gets persisted;
// the two maps have no separate shape to drift apart in. [LAW:one-source-of-truth]
function verdictRecord(verdict, extra = {}) {
  return {
    ...verdict,
    candidate: null,
    baselineSha: 'basesha0deadbeef',
    cost: null,
    run: {
      elapsedMs: 12 * 60 * 1000,
      budgetMs: 45 * 60 * 1000,
      waves: [{ startedAt: '2026-09-08T00:00:00.000Z', elapsedMs: 12 * 60 * 1000, replays: 2 }],
      spend: { basis: 'subscription', amountUsd: 13.77, costedRuns: 2, uncostedRuns: 0 },
    },
    ...extra,
  };
}

// A candidate at a PARTIAL rung: one run per case, the same 3-opportunity mixture per wave, so the pooled
// denominator stays 6 per wave exactly as the baseline's 12 over 2 waves does.
const wave1 = (found) => candidateSuite([
  caseEntry('case-a', { mean: found ? 1 : 0, min: 0, max: 1, n: 1 }, [[Math.min(found, 3), 3]]),
  caseEntry('case-b', { mean: 0, min: 0, max: 0, n: 1 }, [[Math.max(0, found - 3), 3]]),
]);

// A shared two-case shape: pooled 3/6 across each ⇒ suite 6/12 = 0.5, gate floor ≈ 0.22 (2σ under 0.5).
const CASES_A = () => [
  caseEntry('case-a', { mean: 0.5, min: 0.3333, max: 0.6667, n: 2 }, [[1, 3], [2, 3]]),
  caseEntry('case-b', { mean: 0.5, min: 0.3333, max: 0.6667, n: 2 }, [[1, 3], [2, 3]]),
];

// ── arg parsing ────────────────────────────────────────────────────────────────────────────────────

test('parseArgs applies defaults and honors flags', () => {
  const d = parseArgs([]);
  assert.equal(d.baseline, null);
  assert.equal(d.matcher, 'llm');
  assert.equal(d.out, null);
  assert.equal(d.credentials, null);
  assert.equal(d.casesDir, 'eval/cases');
  assert.equal(d.cache, 'eval/out/.judge-cache.json');
  assert.equal(d.reuseCandidate, null);
  const o = parseArgs(['--baseline', 'b', '--matcher=lexical', '--out', 'o', '--credentials=A,B', '--cases-dir', 'c', '--cache=k']);
  assert.equal(o.baseline, 'b');
  assert.equal(o.matcher, 'lexical');
  assert.equal(o.out, 'o');
  assert.equal(o.credentials, 'A,B');
  assert.equal(o.casesDir, 'c');
  assert.equal(o.cache, 'k');
  assert.equal(parseArgs(['--reuse-candidate', 'r']).reuseCandidate, 'r');
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).help, true);
});

test('parseArgs rejects bad input loudly', () => {
  assert.throws(() => parseArgs(['positional']), /Unexpected argument/);
  assert.throws(() => parseArgs(['--nope', 'v']), /Unknown option/);
  assert.throws(() => parseArgs(['--baseline']), /requires a non-empty value/);
  assert.throws(() => parseArgs(['--baseline', '--matcher=llm']), /requires a non-empty value/);
  assert.throws(() => parseArgs(['--out=']), /requires a non-empty value/);
  assert.throws(() => parseArgs(['--matcher', 'fuzzy']), /--matcher must be 'llm' or 'lexical'/);
  assert.throws(() => parseArgs(['--credentials=']), /requires a non-empty value/);
  assert.throws(() => parseArgs(['--workers', '2']), /Unknown option: --workers/);
  // A flag that only shapes the replay contradicts --reuse-candidate, which replays nothing.
  assert.throws(() => parseArgs(['--out', 'o', '--reuse-candidate', 'r']), /--out and --reuse-candidate are mutually exclusive/);
  assert.throws(() => parseArgs(['--credentials', 'A,B', '--reuse-candidate', 'r']), /--credentials and --reuse-candidate are mutually exclusive/);
});

// ── replayArgs (what the replay step hands freeze-suite.js) ────────────────────────────────────────────
// The gate's two invariants live in these arguments: the BASELINE's case set and the BASELINE's N. A
// candidate replayed over a different set or depth measures a different population.

test('replayArgs pins the baseline case set and N, and forwards the lane roster verbatim', () => {
  const args = replayArgs({ repeats: 5, candidateRoot: '/c', casesDir: '/g', caseNames: ['b', 'a'], credentials: 'X,Y', jobTimeout: 45 });
  assert.deepEqual(args, ['-n', '5', '--out', '/c', '--cases-dir', '/g', '--cases', 'b,a', '--job-timeout', '45', '--credentials', 'X,Y']);
});

test('replayArgs with no --credentials leaves lane selection to freeze-suite.js (its single-lane default)', () => {
  const args = replayArgs({ repeats: 2, candidateRoot: '/c', casesDir: '/g', caseNames: ['a'], credentials: null, jobTimeout: 12 });
  assert.deepEqual(args, ['-n', '2', '--out', '/c', '--cases-dir', '/g', '--cases', 'a', '--job-timeout', '12']);
  assert.ok(!args.includes('--credentials'));
});

// A replay's deadline is never omitted: an unbudgeted wave is not a state the ladder can reach, so there
// is no variant for freeze-suite's 120m default to win by.
test('replayArgs always carries a deadline, whatever else it is given', () => {
  const args = replayArgs({ repeats: 1, candidateRoot: '/c', casesDir: '/g', caseNames: ['a'], credentials: null, jobTimeout: 1 });
  assert.ok(args.includes('--job-timeout'));
});

// ── jobTimeoutMinutes (the budget, applied inside a wave) ─────────────────────────────────────────────
// The budget bounds when a wave may START; without this it bounds nothing about how long one may RUN,
// and freeze-suite's 120m per-replay default silently outranks a 45m bar.

test('jobTimeoutMinutes hands a replay what is left of the budget, in whole minutes', () => {
  assert.equal(jobTimeoutMinutes({ elapsedMs: 0, budgetMs: 45 * 60 * 1000 }), 45);
  assert.equal(jobTimeoutMinutes({ elapsedMs: 20 * 60 * 1000, budgetMs: 45 * 60 * 1000 }), 25);
});

test('jobTimeoutMinutes shrinks as the ladder climbs, so a later wave cannot outlive the budget', () => {
  const budgetMs = 45 * 60 * 1000;
  const climbing = [0, 10, 25, 40].map(min => jobTimeoutMinutes({ elapsedMs: min * 60 * 1000, budgetMs }));
  assert.deepEqual(climbing, [45, 35, 20, 5]);
  climbing.forEach((deadline, i) => assert.ok(deadline * 60 * 1000 + [0, 10, 25, 40][i] * 60 * 1000 <= budgetMs + 60 * 1000));
});

// Whole minutes is the flag's unit, so a remainder shorter than one is expressed as the shortest legal
// deadline rather than as 0 — which freeze-suite's parsePositiveInt would refuse outright.
test('jobTimeoutMinutes never asks freeze-suite for a deadline it would refuse', () => {
  assert.equal(jobTimeoutMinutes({ elapsedMs: 44 * 60 * 1000 + 59_000, budgetMs: 45 * 60 * 1000 }), 1);
  assert.equal(jobTimeoutMinutes({ elapsedMs: 90 * 60 * 1000, budgetMs: 45 * 60 * 1000 }), 1);
});

// ── expectedMatcherLabel (the fast pre-check) ─────────────────────────────────────────────────────────

test('expectedMatcherLabel builds the exact label score.js records', () => {
  assert.equal(expectedMatcherLabel('lexical'), 'lexical');
  assert.equal(expectedMatcherLabel('llm'), `llm/${JUDGE_MODEL}`);
  assert.throws(() => expectedMatcherLabel('fuzzy'), /Unknown matcher kind/);
});

// ── estimateCandidateCostUsd (the cost guardrail) ─────────────────────────────────────────────────────

test('estimateCandidateCostUsd prices the full-suite passes still owed — fractional on an uneven resume — or null when uncosted', () => {
  assert.equal(estimateCandidateCostUsd({ costPerFullRunUsd: 0.6952 }, 5), 0.6952 * 5);
  assert.equal(estimateCandidateCostUsd({ costPerFullRunUsd: 0.6952 }, 9 / 4), 0.6952 * 9 / 4);
  assert.equal(estimateCandidateCostUsd({ costPerFullRunUsd: null }, 5), null);
  assert.equal(estimateCandidateCostUsd({}, 5), null);
  assert.equal(estimateCandidateCostUsd(null, 5), null);
});

// ── computeExpectedOpportunities (the pre-loop opportunities-guard arithmetic) ────────────────────────

test('computeExpectedOpportunities sums per-case must-find counts and multiplies by the repeat count', () => {
  assert.equal(computeExpectedOpportunities({ 'case-a': 3, 'case-b': 3 }, 2), 12);
  assert.equal(computeExpectedOpportunities({ 'case-a': 5 }, 1), 5);
  assert.equal(computeExpectedOpportunities({}, 5), 0); // no cases ⇒ no opportunities, regardless of N
  assert.equal(computeExpectedOpportunities({ 'case-a': 0, 'case-b': 4 }, 3), 12); // a case with zero must-finds contributes zero, not skipped
});

// ── compareVerdict (THE GATE) ─────────────────────────────────────────────────────────────────────────

test('compareVerdict returns OK when the candidate clears the floor at the baseline rate', () => {
  const baseline = frozenBaseline(CASES_A());
  const candidate = candidateSuite(CASES_A());
  const v = compareVerdict(baseline, candidate);
  assert.equal(v.degraded, false);
  assert.equal(v.status, 'OK'); // identical rate ⇒ not > baseline ⇒ OK, not IMPROVED
  assert.equal(v.pooled.candidate.rate, 0.5);
  assert.equal(v.pooled.baseline.rate, 0.5);
  assert.equal(v.movedCases.length, 0);
  assert.equal(v.cases.length, 2);
  assert.equal(v.cases[0].delta, 0);
});

test('compareVerdict flags DEGRADED and localizes the moved case when the candidate falls below the floor', () => {
  const baseline = frozenBaseline(CASES_A()); // rate 0.5, floor ≈ 0.22
  // Candidate finds nothing on either case ⇒ pooled 0/12 = 0 < floor.
  const candidate = candidateSuite([
    caseEntry('case-a', { mean: 0, min: 0, max: 0, n: 2 }, [[0, 3], [0, 3]]),
    caseEntry('case-b', { mean: 0, min: 0, max: 0, n: 2 }, [[0, 3], [0, 3]]),
  ]);
  const v = compareVerdict(baseline, candidate);
  assert.equal(v.degraded, true);
  assert.equal(v.status, 'DEGRADED');
  assert.equal(v.pooled.candidate.rate, 0);
  // Both candidate means (0) are below the baseline diagnostic floor (0.3333) ⇒ both localized.
  assert.deepEqual(v.movedCases.sort(), ['case-a', 'case-b']);
});

test('compareVerdict reports IMPROVED (informational) when the candidate exceeds the baseline rate', () => {
  const baseline = frozenBaseline(CASES_A()); // 0.5
  const candidate = candidateSuite([
    caseEntry('case-a', { mean: 1, min: 1, max: 1, n: 2 }, [[3, 3], [3, 3]]),
    caseEntry('case-b', { mean: 1, min: 1, max: 1, n: 2 }, [[3, 3], [3, 3]]),
  ]);
  const v = compareVerdict(baseline, candidate);
  assert.equal(v.degraded, false);
  assert.equal(v.status, 'IMPROVED');
  assert.equal(v.pooled.candidate.rate, 1);
});

test('compareVerdict treats a candidate exactly AT the floor as OK (strictly-less gate)', () => {
  const baseline = frozenBaseline(CASES_A());
  const floor = baseline.pooledInventoryMustFind.gateFloor; // rounded to ≤4 decimal places by buildBaseline
  // Drive the boundary through TRUE equality with the fraction evaluateGate actually compares
  // (found/opportunities), not an approximation. opportunities=10000 guarantees floor*opportunities is an
  // integer (floor has ≤4 decimal digits), so found/opportunities reproduces floor exactly — unlike a
  // Math.ceil()-rounded found, which lands strictly ABOVE the floor and never exercises true equality despite
  // a test name/comment claiming it does. Also override baseline's own opportunities to the same value, so
  // this construction still satisfies compareVerdict's candidate/baseline pooled-opportunities-match check.
  const opportunities = 10000;
  const found = Math.round(floor * opportunities);
  assert.equal(found / opportunities, floor); // sanity: exact equality, not merely close
  baseline.pooledInventoryMustFind.opportunities = opportunities;

  const atFloor = candidateSuite(CASES_A());
  atFloor.suite.pooledInventoryMustFind.found = found;
  atFloor.suite.pooledInventoryMustFind.opportunities = opportunities;
  atFloor.suite.pooledInventoryMustFind.rate = found / opportunities;
  assert.equal(compareVerdict(baseline, atFloor).degraded, false);

  const below = candidateSuite(CASES_A());
  below.suite.pooledInventoryMustFind.found = found - 1;
  below.suite.pooledInventoryMustFind.opportunities = opportunities;
  below.suite.pooledInventoryMustFind.rate = (found - 1) / opportunities;
  assert.equal(compareVerdict(baseline, below).degraded, true);
});

test('compareVerdict refuses a rung above the ceiling / incomparable engine / matcher / case set', () => {
  const baseline = frozenBaseline(CASES_A());
  // A depth PAST the ceiling has no rung: the baseline's N bounds the ladder. (A depth BELOW it is a
  // legitimate rung — see the ladder tests — which is the whole point of deriving the replay count.)
  assert.throws(() => compareVerdict(baseline, candidateSuite([
    caseEntry('case-a', { mean: 0.5, min: 0.5, max: 0.5, n: 3 }, [[1, 3], [1, 3], [1, 3]]),
    caseEntry('case-b', { mean: 0.5, min: 0.5, max: 0.5, n: 3 }, [[1, 3], [1, 3], [1, 3]]),
  ])), /Incomparable: candidate ran at depth 3, outside the ladder's 1\.\.2 rungs/);
  // Mismatched engine.
  const zai = { provider: 'zai', model: 'glm', reasoning: null };
  assert.throws(() => compareVerdict(baseline, candidateSuite([
    caseEntry('case-a', { mean: 0.5, min: 0.3333, max: 0.6667, n: 2 }, [[1, 3], [2, 3]], zai),
    caseEntry('case-b', { mean: 0.5, min: 0.3333, max: 0.6667, n: 2 }, [[1, 3], [2, 3]], zai),
  ])), /Incomparable: candidate ran on engine/);
  // Missing a case + an extra case.
  assert.throws(() => compareVerdict(baseline, candidateSuite([
    caseEntry('case-a', { mean: 0.5, min: 0.3333, max: 0.6667, n: 2 }, [[1, 3], [2, 3]]),
    caseEntry('case-c', { mean: 0.5, min: 0.3333, max: 0.6667, n: 2 }, [[1, 3], [2, 3]]),
  ])), /Incomparable case sets.*missing \[case-b\].*extra \[case-c\]/s);
});

test('compareVerdict refuses a candidate whose pooled inventory opportunities differ from the baseline', () => {
  // expected.json is a living document (curated independent of re-freezing); if a case's inventory changed
  // opportunity count since the baseline was frozen, the candidate's pooled denominator no longer matches
  // what the gate floor was computed from — an apples-to-oranges verdict this check refuses.
  const baseline = frozenBaseline(CASES_A());
  const candidate = candidateSuite(CASES_A());
  candidate.suite.pooledInventoryMustFind.opportunities += 1; // simulate expected.json gaining a must-find
  assert.throws(() => compareVerdict(baseline, candidate),
    /Incomparable: candidate holds 13 pooled inventory opportunities over 2 wave\(s\)/);
  // The check is on opportunities PER WAVE, so a legitimate partial rung — half the depth, half the
  // denominator, the same mixture — passes it. That is what lets the ladder stop early at all.
  assert.equal(compareVerdict(baseline, wave1(3)).pooled.candidate.opportunities, 6);
});

// ── the ladder: how deep the gate has to go ──────────────────────────────────────────────────────────

test('compareVerdict decides at a partial rung when no completion could change the verdict', () => {
  const baseline = frozenBaseline(CASES_A()); // floor ≈ 0.2172 over 12 terminal opportunities
  // 3 of 6 at wave 1. Even finding NOTHING in wave 2 lands 3/12 = 25%, still above the floor — so this is
  // the full-depth verdict, reached at half the spend. [LAW:derive-dont-hardcode]
  const early = compareVerdict(baseline, wave1(3));
  assert.equal(early.status, 'OK');
  assert.equal(early.basis, 'certain');
  assert.equal(early.depth, 1);
  assert.equal(early.ceiling, 2);
  assert.equal(early.replaysSpent, 2);
});

test('compareVerdict reports UNDECIDED — never OK — when the sample places the candidate on neither side', () => {
  const baseline = frozenBaseline(CASES_A());
  // 1 of 6: finding nothing further would red it, finding everything would clear it, and the interval
  // straddles the floor. The honest answer is that this sample decides nothing.
  const v = compareVerdict(baseline, wave1(1));
  assert.equal(v.status, 'UNDECIDED');
  assert.equal(v.basis, null);
  assert.equal(v.degraded, false);
  // UNDECIDED must never render or exit as a pass.
  const md = renderVerdictMarkdown(verdictRecord(v));
  assert.match(md, /NOT MEASURED, WHICH IS NOT THE SAME AS NOT DEGRADED/);
  // It states that the ladder stopped short, and points at the wall-clock line for WHY, rather than
  // asserting a budget it may never have consulted — --reuse-candidate reaches this verdict with no
  // budget in play at all. A verdict that names the wrong cause is a map of something that did not happen.
  assert.match(md, /the ladder stopped before the ceiling/);
  assert.doesNotMatch(md, /the budget could not buy/);
});

test('the ceiling always decides — the ladder terminates without a special case for the top rung', () => {
  const baseline = frozenBaseline(CASES_A());
  // Every reachable full-depth count, and none of them may come back UNDECIDED: at the ceiling the two
  // certainty bounds collapse onto the terminal rule, so one of them always fires.
  for (let found = 0; found <= 6; found++) {
    const full = candidateSuite([
      caseEntry('case-a', { mean: 0, min: 0, max: 0, n: 2 }, [[Math.min(found, 3), 3], [0, 3]]),
      caseEntry('case-b', { mean: 0, min: 0, max: 0, n: 2 }, [[Math.max(0, found - 3), 3], [0, 3]]),
    ]);
    const v = compareVerdict(baseline, full);
    assert.notEqual(v.status, 'UNDECIDED', `full depth with ${found}/12 came back UNDECIDED`);
    assert.equal(v.basis, 'certain');
    // and it is exactly the frozen rule: below the floor is degraded, at or above it is not.
    assert.equal(v.degraded, found / 12 < baseline.pooledInventoryMustFind.gateFloor);
  }
});

test('compareVerdict matcher mismatch is refused', () => {
  const baseline = frozenBaseline(CASES_A());
  const lexicalCase = (name) => {
    const c = caseEntry(name, { mean: 0.5, min: 0.3333, max: 0.6667, n: 2 }, [[1, 3], [2, 3]]);
    c.summary.matcher = 'lexical';
    return c;
  };
  assert.throws(() => compareVerdict(baseline, candidateSuite([lexicalCase('case-a'), lexicalCase('case-b')])),
    /Incomparable: candidate was scored with matcher 'lexical'/);
});

// ── rendering ────────────────────────────────────────────────────────────────────────────────────────

test('renderVerdictMarkdown surfaces the gate, the per-case table, cost, and a final verdict line', () => {
  const baseline = frozenBaseline(CASES_A());
  const candidate = candidateSuite([
    caseEntry('case-a', { mean: 0, min: 0, max: 0, n: 2 }, [[0, 3], [0, 3]]),
    caseEntry('case-b', { mean: 0, min: 0, max: 0, n: 2 }, [[0, 3], [0, 3]]),
  ]);
  const v = compareVerdict(baseline, candidate);
  const md = renderVerdictMarkdown(verdictRecord(v, {
    candidate: { sha: 'cafe1234', dirty: true },
    cost: { baselinePerRun: 0.7, candidatePerRun: 0.5, delta: -0.2 },
  }));
  assert.match(md, /## Eval verdict — 🔴 DEGRADED/);
  assert.match(md, /PRIMARY GATE — pooled inventory must-find recall/);
  assert.match(md, /Candidate \(a dirty tree at commit cafe123\) vs baseline/);
  assert.match(renderVerdictMarkdown(verdictRecord(v, { candidate: { sha: 'cafe1234', dirty: false } })), /Candidate \(commit cafe123\) vs baseline/);
  assert.match(renderVerdictMarkdown(verdictRecord(v)), /Candidate \(no recorded identity/);
  assert.match(md, /\| `case-a` \|/);
  assert.match(md, /⚠️ yes/);
  assert.match(md, /\*\*Cost basis:\*\*/);
  assert.match(md, /\*\*VERDICT: DEGRADED\*\*/);
  assert.match(md, /Localized to: `case-a`, `case-b`/);
  // What the run cost travels WITH the verdict, in the same object verdict.json holds — the wall clock the
  // 45-minute bar is stated in, and the spend with its basis intact rather than dressed as billed dollars.
  assert.match(md, /\*\*Wall clock:\*\* 12m00s of a 45m00s budget, over 1 wave\(s\)/);
  assert.match(md, /\*\*Spend:\*\* \$13\.7700 \*\*notional\*\* — subscription quota at list-price equivalent, not billed/);
  // and how strong a claim the badge is making.
  assert.match(md, /\*\*Decided at wave 2 of 2\*\* \(4 replay\(s\) spent, ceiling 4\) · \*\*certain\*\*/);
});

test('renderVerdictMarkdown OK path names no cases and reads clean', () => {
  const baseline = frozenBaseline(CASES_A());
  const md = renderVerdictMarkdown(verdictRecord(compareVerdict(baseline, candidateSuite(CASES_A()))));
  assert.match(md, /## Eval verdict — 🟢 OK/);
  assert.match(md, /\*\*VERDICT: OK\*\*/);
  assert.doesNotMatch(md, /Localized to/);
});

test('a screened pass never renders as an adjudicated one', () => {
  // The claim clause is the whole point of carrying `basis` beside the status: the same green badge means
  // different things at different depths, and flattening them is the dishonesty this gate was asked to
  // avoid. A partial rung decided on the interval says so, in the sentence a reader sees first.
  const screened = renderVerdictMarkdown(verdictRecord({
    ...compareVerdict(frozenBaseline(CASES_A()), wave1(3)), basis: 'screened',
  }));
  assert.match(screened, /\*\*screened\*\* — the candidate's ~2σ interval sits entirely on one side of the floor/);
  assert.match(screened, /A weaker claim than a full-depth adjudication: the sample it rests on is 1\/2 of one/);
  assert.doesNotMatch(renderVerdictMarkdown(verdictRecord(compareVerdict(frozenBaseline(CASES_A()), CASES_A() && candidateSuite(CASES_A())))), /screened/);
});

// ── resolveBaselineJsonPath (effect code — a real temp git repo, not a pure-core fixture) ──────────────
//
// This function has been rewritten three times across review rounds (bare name sort → generatedAt
// tie-break → git-commit-time tie-break), each prior version wrong in a different, subtle way. A real
// integration test against actual git history is what a mocked/pure fixture cannot catch — the whole bug
// class is "does this correctly read real git state," which a fixture can only assert the code CLAIMS to
// do. gitCwd is a seam specifically so this can point git at a disposable temp repo instead of asserting
// against (or fabricating commits into) this repo's own history.

function withTempGitRepo(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'compare-baseline-'));
  const prevCwd = process.cwd();
  try {
    execFileSync('git', ['init', '-q'], { cwd: tmp });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmp });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmp });
    process.chdir(tmp);
    fn(tmp);
  } finally {
    process.chdir(prevCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function writeBaselineDir(tmp, dirName) {
  const dir = path.join(tmp, 'eval', 'baseline', dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'baseline.json'), JSON.stringify({ marker: dirName }));
  return dir;
}

function commitAll(tmp, message) {
  execFileSync('git', ['add', '-A'], { cwd: tmp });
  execFileSync('git', ['commit', '-q', '-m', message], { cwd: tmp });
}

test('resolveBaselineJsonPath tie-breaks a same-date pair by actual commit order, not directory name', () => {
  withTempGitRepo((tmp) => {
    // Same date prefix on both — a bare name sort OR a generatedAt tie-break (which carries the identical
    // date string) would pick whichever name sorts last ('zzz...' > 'aaa...'), regardless of which was
    // actually frozen more recently. Committing 'aaa' SECOND (chronologically later) while it sorts FIRST
    // by name proves the picked winner comes from real commit order, not the name.
    writeBaselineDir(tmp, '2026-08-01-zzz9999');
    commitAll(tmp, 'freeze zzz (first, older)');
    writeBaselineDir(tmp, '2026-08-01-aaa1111');
    commitAll(tmp, 'freeze aaa (second, newer)');

    const picked = resolveBaselineJsonPath(null, tmp);
    assert.match(picked, /2026-08-01-aaa1111/);
  });
});

test('resolveBaselineJsonPath picks an uncommitted baseline over any committed one — freshly frozen, not yet committed, is the newest', () => {
  withTempGitRepo((tmp) => {
    writeBaselineDir(tmp, '2026-08-09-committed');
    commitAll(tmp, 'freeze, committed');
    // Written to disk but never committed — the exact "just ran eval/baseline.js, about to gate against
    // it" moment. Its name looks OLDER than the committed one to prove the win comes from being
    // uncommitted, not from the name.
    writeBaselineDir(tmp, '2020-01-01-uncommitted');

    const picked = resolveBaselineJsonPath(null, tmp);
    assert.match(picked, /2020-01-01-uncommitted/);
  });
});

test('resolveBaselineJsonPath refuses to pick among multiple baselines in a shallow clone — no real history to rank them by', () => {
  withTempGitRepo((source) => {
    writeBaselineDir(source, '2026-08-01-first');
    commitAll(source, 'freeze first');
    writeBaselineDir(source, '2026-08-02-second');
    commitAll(source, 'freeze second');

    // A shallow clone (actions/checkout's default fetch-depth: 1) sees only the single checked-out commit —
    // commitOrder has nothing to rank either baseline.json against.
    const shallow = fs.mkdtempSync(path.join(os.tmpdir(), 'compare-baseline-shallow-'));
    const prevCwd = process.cwd();
    try {
      execFileSync('git', ['clone', '--depth', '1', `file://${source}`, shallow], { stdio: 'ignore' });
      process.chdir(shallow);
      assert.throws(() => resolveBaselineJsonPath(null, shallow), /shallow git clone/);
    } finally {
      process.chdir(prevCwd);
      fs.rmSync(shallow, { recursive: true, force: true });
    }
  });
});

test('resolveBaselineJsonPath does NOT refuse a shallow clone with only one baseline — nothing to tie-break', () => {
  withTempGitRepo((source) => {
    writeBaselineDir(source, '2026-08-01-only');
    commitAll(source, 'freeze only');

    const shallow = fs.mkdtempSync(path.join(os.tmpdir(), 'compare-baseline-shallow-'));
    const prevCwd = process.cwd();
    try {
      execFileSync('git', ['clone', '--depth', '1', `file://${source}`, shallow], { stdio: 'ignore' });
      process.chdir(shallow);
      const picked = resolveBaselineJsonPath(null, shallow);
      assert.match(picked, /2026-08-01-only/);
    } finally {
      process.chdir(prevCwd);
      fs.rmSync(shallow, { recursive: true, force: true });
    }
  });
});

test('resolveBaselineJsonPath does NOT refuse a shallow clone with an uncommitted baseline alongside committed ones — the uncommitted one already wins outright, nothing ambiguous', () => {
  withTempGitRepo((source) => {
    writeBaselineDir(source, '2026-08-01-committed-a');
    commitAll(source, 'freeze a');
    writeBaselineDir(source, '2026-08-02-committed-b');
    commitAll(source, 'freeze b');

    const shallow = fs.mkdtempSync(path.join(os.tmpdir(), 'compare-baseline-shallow-'));
    const prevCwd = process.cwd();
    try {
      execFileSync('git', ['clone', '--depth', '1', `file://${source}`, shallow], { stdio: 'ignore' });
      process.chdir(shallow);
      // The two committed baselines are indistinguishable in this shallow clone (git reports the same
      // boundary commit as the last to touch both) — but this uncommitted one is unconditionally newer
      // than either, so the pick is NOT ambiguous despite there being three candidate dirs in a shallow
      // clone. A blunt "more than one dir in a shallow clone ⇒ refuse" rule would wrongly refuse this.
      writeBaselineDir(shallow, '2020-01-01-uncommitted');
      const picked = resolveBaselineJsonPath(null, shallow);
      assert.match(picked, /2020-01-01-uncommitted/);
    } finally {
      process.chdir(prevCwd);
      fs.rmSync(shallow, { recursive: true, force: true });
    }
  });
});

// ── resume or refuse: prior runs under --out against the tree under gate ──────────────────────────────
const { foreignRuns, readPriorRuns, deficitReplays, excessRuns, driftedRuns, producedTree } = require('../eval/compare');

test('foreignRuns keeps the runs replayed on this exact clean commit and names every other by both trees', () => {
  const here = { sha: 'aaaaaaa1', dirty: false };
  const runs = [
    { dir: 'r1', candidate: { sha: 'aaaaaaa1', dirty: false } },   // ours
    { dir: 'r2', candidate: { sha: 'bbbbbbb2', dirty: false } },   // another commit
    { dir: 'r3', candidate: { sha: 'aaaaaaa1', dirty: true } },    // same commit, dirty when replayed
    { dir: 'r4', candidate: null },                                // pre-provenance run
  ];
  const foreign = foreignRuns(here, runs);
  assert.deepEqual(foreign.map(f => f.dir), ['r2', 'r3', 'r4']);
  assert.match(foreign[0].reason, /replayed on commit bbbbbbb; the tree under gate is commit aaaaaaa/);
  assert.match(foreign[1].reason, /a dirty tree at commit aaaaaaa/);
  assert.match(foreign[2].reason, /no recorded identity/);
});

test('foreignRuns under a dirty tree refuses EVERY prior run — nothing can be proven its own', () => {
  const ours = [{ dir: 'r1', candidate: { sha: 'aaaaaaa1', dirty: false } }];
  const dirty = foreignRuns({ sha: 'aaaaaaa1', dirty: true }, ours);
  assert.equal(dirty.length, 1);
  assert.match(dirty[0].reason, /the tree under gate is a dirty tree at commit aaaaaaa/);
  assert.deepEqual(foreignRuns({ sha: 'aaaaaaa1', dirty: true }, []), []);
});

test('completedDepth is the rung every case has reached — the MINIMUM, so an uneven root resumes level', () => {
  const prior = [{ case: 'a' }, { case: 'a' }, { case: 'a' }, { case: 'b' }, { case: 'c' }, { case: 'c' }];
  // 'b' has one run, so the suite stands on rung 1 however deep the others go: a suite pooled over
  // unequal depth measures an unequal mixture.
  assert.equal(completedDepth(['a', 'b', 'c'], prior), 1);
  assert.equal(completedDepth(['a', 'c'], prior), 2);
  assert.equal(completedDepth(['a', 'b', 'd'], prior), 0);
  assert.equal(completedDepth(['a'], []), 0);
});

test('affordsAnotherWave prices the next wave at what a wave has already cost, against the elapsed budget', () => {
  const budgetMs = 45 * 60 * 1000;
  assert.equal(affordsAnotherWave({ elapsedMs: 20 * 60 * 1000, longestWaveMs: 20 * 60 * 1000, budgetMs }), true);
  assert.equal(affordsAnotherWave({ elapsedMs: 28 * 60 * 1000, longestWaveMs: 20 * 60 * 1000, budgetMs }), false);
  // Exactly filling the budget is affordable; overrunning it by a millisecond is not.
  assert.equal(affordsAnotherWave({ elapsedMs: 25 * 60 * 1000, longestWaveMs: 20 * 60 * 1000, budgetMs }), true);
  assert.equal(affordsAnotherWave({ elapsedMs: 25 * 60 * 1000 + 1, longestWaveMs: 20 * 60 * 1000, budgetMs }), false);
});

test('foldSpend keeps the basis with the number and refuses to add two currencies', () => {
  // Summed as written, never rounded: the renderer decides how many decimals a reader sees, and a fold
  // that rounded would be a second, lossier map of the same fact. [LAW:one-source-of-truth]
  const subs = [{ basis: 'subscription', notionalUsd: 13.5 }, { basis: 'subscription', notionalUsd: 12.25 }];
  assert.deepEqual(foldSpend(subs), { basis: 'subscription', amountUsd: 25.75, costedRuns: 2, uncostedRuns: 0 });
  assert.deepEqual(foldSpend([{ basis: 'dollars', usd: 0.5 }, null]), { basis: 'dollars', amountUsd: 0.5, costedRuns: 1, uncostedRuns: 1 });
  assert.deepEqual(foldSpend([]), { basis: null, amountUsd: null, costedRuns: 0, uncostedRuns: 0 });
  // A notional quota figure and a billed figure are not the same currency; summing them would produce a
  // number with no meaning, and "$360" being read as cash is the exact confusion this refuses.
  assert.throws(() => foldSpend([{ basis: 'subscription', notionalUsd: 1 }, { basis: 'dollars', usd: 1 }]),
    /more than one basis \(subscription, dollars\)/);
});

test('excessRuns names every case holding more runs than N — the population the gate cannot measure', () => {
  const prior = [{ case: 'a' }, { case: 'a' }, { case: 'a' }, { case: 'c' }, { case: 'c' }];
  assert.deepEqual(excessRuns(['a', 'b', 'c'], prior, 2), [{ case: 'a', completed: 3 }]);
  assert.deepEqual(excessRuns(['a', 'b', 'c'], prior, 3), []);
});

test('driftedRuns compares the recorded tree to the snapshot by equality — a dirty tree\'s own fresh runs are NOT drift', () => {
  const dirty = { sha: 'aaaaaaa1', dirty: true };
  const clean = { sha: 'aaaaaaa1', dirty: false };
  assert.deepEqual(driftedRuns(dirty, [{ dir: 'r1', candidate: { sha: 'aaaaaaa1', dirty: true } }]), []);
  assert.deepEqual(driftedRuns(clean, [{ dir: 'r1', candidate: { sha: 'aaaaaaa1', dirty: false } }]), []);
  const moved = driftedRuns(clean, [
    { dir: 'r1', candidate: { sha: 'aaaaaaa1', dirty: false } },
    { dir: 'r2', candidate: { sha: 'aaaaaaa1', dirty: true } },   // edited mid-run
    { dir: 'r3', candidate: { sha: 'bbbbbbb2', dirty: false } },  // committed mid-run
    { dir: 'r4', candidate: null },
  ]);
  assert.deepEqual(moved.map(m => m.dir), ['r2', 'r3', 'r4']);
  assert.match(moved[0].reason, /recorded a dirty tree at commit aaaaaaa; the tree snapshotted before the replay was commit aaaaaaa/);
});

test('producedTree names the one tree every run records — the verdict\'s provenance comes from the runs, not the checkout', () => {
  const clean = { sha: 'aaaaaaa1', dirty: false };
  assert.deepEqual(producedTree([{ dir: 'r1', candidate: clean }, { dir: 'r2', candidate: { sha: 'aaaaaaa1', dirty: false } }]), clean);
  assert.deepEqual(producedTree([{ dir: 'r1', candidate: { sha: 'aaaaaaa1', dirty: true } }]), { sha: 'aaaaaaa1', dirty: true });
  // Pre-provenance runs agree with each other on having no identity, and the verdict says so; a reused
  // root of summaries alone (no run dirs) has none to name either.
  assert.equal(producedTree([{ dir: 'r1', candidate: null }, { dir: 'r2', candidate: null }]), null);
  assert.equal(producedTree([]), null);
  assert.throws(() => producedTree([
    { dir: 'r1', candidate: clean },
    { dir: 'r2', candidate: { sha: 'bbbbbbb2', dirty: false } },
    { dir: 'r3', candidate: null },
  ]), /not produced by one tree:\n {2}r2 recorded commit bbbbbbb; r1 recorded commit aaaaaaa\n {2}r3 recorded no recorded identity/);
});

test('readPriorRuns reads the census the replay will take — completed runs only, each with its recorded tree', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compare-prior-'));
  try {
    const mk = (caseName, run, meta, complete = true) => {
      const dir = path.join(root, caseName, run);
      fs.mkdirSync(dir, { recursive: true });
      if (complete) fs.writeFileSync(path.join(dir, 'findings.json'), '[]\n');
      fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ case: caseName, ...meta }) + '\n');
      return dir;
    };
    const a1 = mk('case-a', '2026-01-01T00-00-00-000Z-run1', { candidate: { sha: 'abc', dirty: false } });
    const a2 = mk('case-a', '2026-01-01T00-00-01-000Z-run1', {});
    mk('case-a', '2026-01-01T00-00-02-000Z-run1', { candidate: { sha: 'abc', dirty: false } }, false); // crashed: no findings.json
    mk('case-c', '2026-01-01T00-00-03-000Z-run1', { candidate: { sha: 'abc', dirty: false } });       // not a gated case
    const prior = readPriorRuns(root, ['case-a', 'case-b']);
    const misplaced = path.join(root, 'case-b', '2026-01-01T00-00-04-000Z-run1');
    fs.mkdirSync(misplaced, { recursive: true });
    fs.writeFileSync(path.join(misplaced, 'findings.json'), '[]\n');
    fs.writeFileSync(path.join(misplaced, 'meta.json'), JSON.stringify({ case: 'case-a', candidate: { sha: 'abc', dirty: false } }) + '\n');
    assert.throws(() => readPriorRuns(root, ['case-a', 'case-b']), /names case 'case-a' but lives under 'case-b'/);
    fs.rmSync(misplaced, { recursive: true, force: true });
    assert.deepEqual(prior, [
      { case: 'case-a', dir: a1, candidate: { sha: 'abc', dirty: false } },
      { case: 'case-a', dir: a2, candidate: null },
    ]);
    assert.deepEqual(readPriorRuns(path.join(root, 'absent'), ['case-a']), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
