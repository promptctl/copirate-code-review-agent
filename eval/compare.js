#!/usr/bin/env node
'use strict';
// THE QUALITY GATE (copirate-eval-harness-2fk.5). One command that answers the epic's question — "did my
// change degrade finding quality?" — with a measured verdict, so a quality-sensitive change (the efficiency
// epic's prompt restructuring, scout removal, tier lowering: copirate-efficiency-235.2/.3/.4/.5) ships only
// when the golden must-finds are still found.
//
//   node eval/compare.js [--baseline <dir|baseline.json>] [--matcher llm|lexical] [--out <dir>] ...
//
// A CANDIDATE IS JUST ANOTHER SUITE. This file does NOT reimplement pooling or scoring. It:
//   1. replays every baseline case N times against the WORKING TREE's src/ (spawning eval/freeze-suite.js,
//      the same credential-parallel scheduler the baseline was frozen with, over eval/run-case.js — the
//      replay runner already drives src/ directly, so "the candidate" is simply the code as checked out;
//      no build or publish),
//   2. scores each case (spawning eval/score.js),
//   3. reduces the candidate's scored summaries into a suite with the SAME buildBaseline the frozen baseline
//      was built with (so producer and comparator can NEVER drift — [LAW:one-source-of-truth]), and
//   4. applies the frozen pooled degradation rule via baseline.js's decideLadder: candidate pooled
//      inventory must-find recall vs the baseline's pooled gate floor  ⇒  DEGRADED (non-zero exit).
// The engine is DERIVED FROM the baseline and asserted, because a candidate run on a different engine is
// not comparable — its pooled rate measures a different thing. [LAW:no-silent-failure]
//
// IT SPENDS THE DEPTH THE ANSWER COSTS, NOT THE DEPTH THE BASELINE HAPPENS TO HOLD (zai-eval-harness-5ux).
// Steps 1-4 are a RUNG, and the gate walks rungs: one replay per case per wave, deepening every case
// together (freeze-suite.js's level-filling plan is already this shape), stopping the moment the pooled
// counts decide. The baseline's N is the CEILING that guarantees termination, never a target
// [LAW:derive-dont-hardcode] — and it is not a special case in the loop either, because at full depth
// decideLadder's certainty bounds collapse onto the terminal rule and always fire.
//
// Its wall clock is BOUNDED, and that bound is measured rather than modelled: each rung spawns
// freeze-suite.js once, which writes one timing leg carrying that wave's real elapsed wall clock, so the
// next wave is priced at the most expensive wave this candidate has actually cost. A wave that will not
// fit the remaining budget is not started, and the gate reports UNDECIDED — a gate that ran out of budget
// must be read as "not measured", never as "not degraded". [LAW:no-silent-failure]
//
// [LAW:effects-at-boundaries] Module load is PURE: only stdlib and functions imported from baseline.js (the
// pure reducers), score.js (parsers, the run census) and run-case.js (the tree identity) — nothing runs at
// require. Every world-effect (fs, git, spawning the run/score CLIs) lives inside main(), so importing
// this file for the pure-core tests performs no IO and spawns no subprocess.

const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const {
  parseCaseSummary, parseCaseEngine, buildBaseline, parseBaseline, sameEngine, decideLadder,
} = require('./baseline');
const { matcherLabel, parseExpected, parseMeta, parseUsage, listRunDirs, requireLlmJudgeCredential } = require('./score');
const { readSuiteTiming, formatDuration } = require('./freeze-suite');
const { workingTree, treeIdentity } = require('./run-case');
const { sumCost } = require('../src/usage');

const USAGE = `Gate a candidate (the current working tree) against a frozen eval baseline: replay the golden
suite one wave at a time, score it, and print a DEGRADED / OK / IMPROVED / UNDECIDED verdict. Exit 1 on
DEGRADED, 3 on UNDECIDED (the budget ran out before the counts decided), 2 if the gate could not run.

Usage: ANTHROPIC_API_KEY=… <engine credential(s)> node eval/compare.js [options]

  --baseline <path>      Frozen baseline dir (or its baseline.json) to gate against. Default: the newest
                         committed baseline under eval/baseline/, by commit-graph order — NOT directory-name
                         order, and an uncommitted baseline.json always outranks a committed one. Refused
                         (exit 2) if the newest can't be determined unambiguously (e.g. a shallow git clone
                         with more than one candidate); pass --baseline explicitly in that case. N, engine,
                         and matcher come FROM whichever baseline is resolved.
  --matcher <kind>       Semantic matcher for scoring the candidate: 'llm' (default) or 'lexical'. MUST
                         match the baseline's matcher, or the recall numbers aren't comparable — refused
                         up front, before any spend. IGNORED under --reuse-candidate (no scoring runs in
                         that mode; the reused summaries' own recorded matcher is what's checked instead).
  --out <dir>            Candidate artifact root (default: eval/out/candidate-<ts>, git-ignored). Kept
                         isolated from the baseline's own run artifacts under eval/out/<case>/. Mutually
                         exclusive with --reuse-candidate (refused if both are passed). An existing root
                         RESUMES: runs already under it that carry this candidate's identity (the same
                         clean commit — tracked content equal to HEAD; untracked files do not count —
                         recorded in each run's meta.json) count toward N and only the
                         deficit is replayed — how a gate survives a quota wall across invocations. Any
                         run under it that is not provably this candidate's (another commit, a dirty
                         tree, no identity recorded), or a case already holding more runs than the
                         baseline's N, is refused by name before any spend rather than silently blended.
                         A root left UNDECIDED by an earlier invocation resumes at the rung it reached, so
                         a second run continues the ladder instead of restarting it.
  --credentials <A,B,…>  Names of env vars holding one engine credential each, forwarded to
                         freeze-suite.js: one replay LANE per name, run concurrently. Default: a single
                         lane on the pinned provider's own credential input. N lanes cut the suite's
                         wall clock by about N and spread its quota across N accounts; the measured
                         figures are in .github/workflows/eval.yml and eval/README.md.
  --cases-dir <dir>      Where the frozen golden cases live (default: eval/cases).
  --cache <file>         Judge-decision cache, forwarded to score.js (default: eval/out/.judge-cache.json).
  --budget-minutes <m>   Wall-clock budget for THIS invocation (default: 45 — the bar the gate is held to).
                         The first wave always runs, because nothing has been measured before it; every
                         later wave must fit inside what is left, priced at the most expensive wave this
                         candidate has actually cost. A gate that cannot afford the next wave stops and
                         reports UNDECIDED rather than overrunning or guessing.
  --reuse-candidate <d>  Skip the replay+score entirely and gate an ALREADY-produced candidate root <d>
                         (one <case>/scorecard-summary.json per baseline case). For re-rendering a verdict
                         or validating the gate without re-spending. The verdict names the tree the reused
                         runs record (each run's meta.json), not the checked-out tree; runs recording
                         different trees are refused by name. Mutually exclusive with --out and with
                         --credentials (nothing is replayed, so there is nothing for either to shape).
  --help                 Show this help.

The candidate runs on the baseline's pinned engine and stops at whatever DEPTH decides it, up to the
baseline's N as a ceiling: one replay per case per wave, re-judged after each. Most waves are never bought
— a candidate far from the floor in either direction is settled by the first. Estimated cost is printed up
front. The engine credential is read one of two
ways: with no --credentials, from the pinned provider's own input var (the one the action reads, e.g.
CLAUDE_CODE_OAUTH_TOKEN for claude-subscription); with --credentials, from each named var in turn, one
lane each (.github/workflows/eval.yml runs this way) — PLUS, unconditionally, ANTHROPIC_API_KEY for the
default '--matcher llm' judge,
regardless of which provider the pinned engine itself uses (pass --matcher lexical to avoid this second
credential). The judge is deliberately a separate credential from the engine's: it is the ruler, and a
ruler that moved with the thing it measures would measure nothing.
`;

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Argument parsing (pure) — mirrors run-case.js / score.js / baseline.js: `--flag value` and `--flag=value`
// both work; an unknown flag, a missing value, or an empty value aborts here, at the boundary, so nothing
// downstream re-checks. [LAW:parse-dont-validate] [LAW:no-silent-failure]
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {
    baseline: null, matcher: 'llm', out: null, credentials: null,
    casesDir: 'eval/cases', cache: 'eval/out/.judge-cache.json', reuseCandidate: null, budgetMinutes: '45',
  };
  const keyFor = {
    baseline: 'baseline', matcher: 'matcher', out: 'out', credentials: 'credentials',
    'cases-dir': 'casesDir', cache: 'cache', 'reuse-candidate': 'reuseCandidate',
    'budget-minutes': 'budgetMinutes',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg} (compare.js takes only --flags). See --help.`);
    const eq = arg.indexOf('=');
    const rawName = arg.slice(2, eq === -1 ? undefined : eq);
    if (!(rawName in keyFor)) throw new Error(`Unknown option: ${arg.slice(0, eq === -1 ? undefined : eq)}`);
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    // A space-separated value that is itself a flag is a missing value, not a literal argument — consuming
    // it would swallow the next flag. An empty value is likewise rejected before it resolves to cwd.
    if (value === undefined || value === '' || (eq === -1 && value.startsWith('--'))) throw new Error(`Option --${rawName} requires a non-empty value.`);
    opts[keyFor[rawName]] = value;
  }
  if (opts.matcher !== 'llm' && opts.matcher !== 'lexical') throw new Error(`--matcher must be 'llm' or 'lexical' (got ${JSON.stringify(opts.matcher)}).`);
  // Parsed to a number HERE, at the boundary, so nothing downstream re-reads a string as minutes.
  // [LAW:parse-dont-validate]
  const budget = Number(String(opts.budgetMinutes).trim());
  if (!Number.isFinite(budget) || budget <= 0) throw new Error(`--budget-minutes must be a positive number of minutes (got ${JSON.stringify(opts.budgetMinutes)}).`);
  opts.budgetMinutes = budget;
  // --reuse-candidate replays nothing, so a flag that only shapes the replay is a contradiction, not a
  // no-op: --out named a root that verdict.{md,json} would then never appear under, and --credentials
  // named lanes that would never run. Refused rather than silently outranked. (--matcher is different:
  // it always has a value, so main() reports it ignored instead.) [LAW:no-silent-failure]
  if (opts.out && opts.reuseCandidate) {
    throw new Error(`--out and --reuse-candidate are mutually exclusive: --reuse-candidate names an existing root to read from and gate; there is nothing fresh for --out to name. Pass one or the other.`);
  }
  if (opts.credentials && opts.reuseCandidate) {
    throw new Error(`--credentials and --reuse-candidate are mutually exclusive: --reuse-candidate replays nothing, so there are no lanes for --credentials to name.`);
  }
  return opts;
}

// [LAW:effects-at-boundaries] Pure: the argv the replay step hands eval/freeze-suite.js. Separated from
// the spawn because this is where the gate's two invariants are pinned as arguments — the BASELINE's case
// set (--cases: a golden case added since the freeze is not gated, because the baseline does not cover
// it) at THIS RUNG's depth — and a wrong argument here silently measures a different population. `repeats`
// is the rung, not the baseline's N: freeze-suite.js fills every case to that level and no further, which
// is what keeps a partial candidate's case MIXTURE identical to the baseline's at every depth.
// `credentials` is forwarded verbatim; its shape (names, non-empty, no repeats) is freeze-suite.js's
// boundary to refuse, and it refuses before any spend. [LAW:single-enforcer] `jobTimeout` is likewise
// always present — every wave is spawned under a budget, so there is no unbounded variant to select
// between. [LAW:dataflow-not-control-flow]
function replayArgs({ repeats, candidateRoot, casesDir, caseNames, credentials, jobTimeout }) {
  return [
    '-n', String(repeats), '--out', candidateRoot, '--cases-dir', casesDir, '--cases', caseNames.join(','),
    '--job-timeout', String(jobTimeout),
    ...(credentials === null ? [] : ['--credentials', credentials]),
  ];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Pure comparison core — the testable gate. No IO, no clock, no spawn.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

// The exact matcher label score.js records for a given --matcher kind — an alias of score.js's OWN
// matcherLabel (the single producer of the format, which its main() also calls), kept under this file's
// established name so a matcher mismatch against the baseline can be refused BEFORE a full suite run.
// [LAW:one-source-of-truth]
const expectedMatcherLabel = matcherLabel;

// The candidate's estimated cost for what THIS invocation will replay: `fullRuns` is the deficit in units
// of one full suite pass (replays still owed ÷ cases — fractional when a resume left the cases uneven),
// priced at the baseline's own recorded per-full-run cost (2fk.4's numbers), so the guardrail printed
// BEFORE spending is the spend about to happen, not the suite's. Null when the baseline never recorded a
// costed per-run figure (nothing to estimate from).
function estimateCandidateCostUsd(rawBaselineSuite, fullRuns) {
  const perRun = rawBaselineSuite && rawBaselineSuite.costPerFullRunUsd;
  if (typeof perRun !== 'number' || !Number.isFinite(perRun)) return null;
  return perRun * fullRuns;
}

// [LAW:effects-at-boundaries] Pure: the cases holding MORE runs than the baseline's N — a population the
// gate cannot measure (every case must be scored over the same N), which buildBaseline would refuse only
// after the other cases' deficit had been replayed and paid for.
function excessRuns(caseNames, prior, repeats) {
  return caseNames
    .map(name => ({ case: name, completed: prior.filter(r => r.case === name).length }))
    .filter(c => c.completed > repeats);
}

// [LAW:effects-at-boundaries] Pure: equality of two recorded trees (commit and dirty flag; an unrecorded
// tree equals only another unrecorded one), not identity: a dirty tree has no identity, yet a replay on
// it is legitimate and its own runs record the same dirty snapshot; what a dirty tree cannot reveal is
// movement within its own dirtiness, and the verdict already says 'dirty'.
function sameTree(a, b) {
  return a === null || b === null ? a === b : a.sha === b.sha && a.dirty === b.dirty;
}

// [LAW:effects-at-boundaries] Pure: which runs record a tree OTHER than the one snapshotted before the
// replay — the tree moved while the suite ran.
function driftedRuns(snapshot, runs) {
  return runs
    .filter(({ candidate }) => !sameTree(candidate, snapshot))
    .map(({ dir, candidate }) => ({ dir, reason: `recorded ${describeTree(candidate)}; the tree snapshotted before the replay was ${describeTree(snapshot)}` }));
}

// [LAW:effects-at-boundaries] Pure: the one tree every run records — the tree a verdict over these runs
// names, read from the runs themselves so a root produced elsewhere is named by its producer, never by the
// tree that happens to be checked out. No runs (a reused root of summaries alone) is no recorded identity,
// the same null a pre-provenance run records. Runs recording two trees are not one candidate: refused by
// name. [LAW:one-source-of-truth] [LAW:no-silent-failure]
function producedTree(runs) {
  const tree = runs[0]?.candidate ?? null;
  const odd = runs.filter(({ candidate }) => !sameTree(candidate, tree));
  if (odd.length > 0) {
    throw new Error(`The runs under the candidate root were not produced by one tree:\n${odd.map(r => `  ${r.dir} recorded ${describeTree(r.candidate)}; ${runs[0].dir} recorded ${describeTree(tree)}`).join('\n')}\nA verdict names one candidate; remove the runs that are not its.`);
  }
  return tree;
}

// The total pooled inventory must-find opportunities a candidate suite would report, given each baseline
// case's CURRENT must-find count (any round) from its expected.json and the repeat count — the same
// quantity buildBaseline sums from real scored runs, computed here without spending on any of them.
// Extracted as a pure function (fed a plain case→count map, not the fs reads that produce it) so the
// arithmetic — the actual risk in this check (an off-by-one, a wrong multiply) — is unit-testable without
// fixtures on disk. [LAW:effects-at-boundaries]
function computeExpectedOpportunities(mustFindCountsByCase, repeats) {
  return repeats * Object.values(mustFindCountsByCase).reduce((sum, n) => sum + n, 0);
}

// Compare a candidate SUITE (buildBaseline output over the candidate's scored summaries) against a frozen
// baseline (parseBaseline output). PURE: same inputs → same verdict, so the gate is unit-testable without
// spending a run. Aborts loudly on any incomparability — a mismatched N, engine, matcher, or case set makes
// the pooled rates measure different things, so a verdict over them would be a silent lie. [LAW:no-silent-failure]
function compareVerdict(baseline, candidate) {
  // A RUNG, not the baseline's N. What the pooled rate actually depends on is the case MIXTURE — which
  // case contributes which share of the denominator — and a whole number of complete waves holds that
  // fixed at every depth, because each wave adds every case's must-find count exactly once. Depth changes
  // only the PRECISION of the estimate, which is what decideLadder prices. What is still refused is a
  // depth past the ceiling: the baseline's N bounds the ladder, so there is no rung above it.
  // [LAW:derive-dont-hardcode]
  if (!Number.isInteger(candidate.repeats) || candidate.repeats < 1 || candidate.repeats > baseline.repeats) {
    throw new Error(`Incomparable: candidate ran at depth ${candidate.repeats}, outside the ladder's 1..${baseline.repeats} rungs (the baseline's N is the ceiling).`);
  }
  // The baseline's engine/matcher are the pins the candidate must have run under. A pre-v1 baseline could
  // carry a null engine; only assert when the baseline actually pins one.
  if (baseline.engine && !sameEngine(candidate.engine, baseline.engine)) {
    throw new Error(`Incomparable: candidate ran on engine ${JSON.stringify(candidate.engine)} but the baseline pins ${JSON.stringify(baseline.engine)}.`);
  }
  if (baseline.matcher && candidate.matcher !== baseline.matcher) {
    throw new Error(`Incomparable: candidate was scored with matcher '${candidate.matcher}' but the baseline used '${baseline.matcher}'. Recall from two matchers isn't comparable.`);
  }
  // Same case SET — the pooled denominator must be over exactly the baseline's suite, or the rates measure
  // different populations. Order-independent; names are unique per suite (uniqueness comes from
  // findGoldenCases's directory enumeration upstream in baseline.js's main(), not from buildBaseline
  // itself). A candidate missing a baseline case, or carrying one the baseline never froze, is refused.
  const baseNames = baseline.cases.map(c => c.case).sort();
  const candNames = candidate.cases.map(c => c.case).sort();
  if (baseNames.length !== candNames.length || baseNames.some((n, i) => n !== candNames[i])) {
    const missing = baseNames.filter(n => !candNames.includes(n));
    const extra = candNames.filter(n => !baseNames.includes(n));
    throw new Error(`Incomparable case sets: ${missing.length ? `candidate is missing [${missing.join(', ')}]` : ''}${missing.length && extra.length ? '; ' : ''}${extra.length ? `candidate has extra [${extra.join(', ')}]` : ''}. The gate pools over the baseline's exact suite.`);
  }
  // Same pooled DENOMINATOR — expected.json is a living document (README: "The pooled inventory, and its
  // eligibility rule"): inventory findings get curated into it over time, independent of re-freezing the
  // baseline. If a case's expected.json gains or loses a must-find entry after the baseline was frozen, the
  // candidate is scored against a different opportunity count than the gate floor was computed from — an
  // apples-to-oranges comparison this file otherwise goes out of its way to refuse. This is a SUITE-total
  // check, not a full per-case one (that would need parseBaseline to carry each case's raw opportunities,
  // which its deliberately lossy gate subset does not — [LAW:carrying-cost]); it catches the realistic case
  // (a case's inventory changed) but not a contrived net-zero add/remove across cases. [LAW:no-silent-failure]
  // Stated as the MIXTURE invariant — opportunities PER WAVE must match — so it holds at every rung
  // rather than only at full depth. Cross-multiplied to keep it in integers: a float division would make
  // the check depend on rounding at exactly the denominators it exists to protect. At the ceiling this is
  // the identical equality it replaced. [LAW:one-source-of-truth]
  const candOpportunities = candidate.suite.pooledInventoryMustFind.opportunities;
  const baseOpportunities = baseline.pooledInventoryMustFind.opportunities;
  if (candOpportunities * baseline.repeats !== baseOpportunities * candidate.repeats) {
    throw new Error(`Incomparable: candidate holds ${candOpportunities} pooled inventory opportunities over ${candidate.repeats} wave(s) (${candOpportunities / candidate.repeats} per wave) but the baseline holds ${baseOpportunities} over ${baseline.repeats} (${baseOpportunities / baseline.repeats} per wave) — expected.json likely changed since the baseline was frozen. Re-freeze the baseline before gating against this expected.json.`);
  }

  // THE GATE — delegated to decideLadder (baseline.js), the single place the degradation rule is applied
  // to a candidate. [LAW:single-enforcer] This file must never re-derive degraded from raw rate/floor
  // numbers, and must never re-derive the ladder's stopping arithmetic either.
  const candidatePooled = candidate.suite.pooledInventoryMustFind;
  const baselinePooled = baseline.pooledInventoryMustFind;
  const decision = decideLadder(baseline, candidatePooled);
  const degraded = decision.kind === 'degraded';
  const gateFloor = decision.gateFloor;
  // UNDECIDED is the honest third answer, not an error and not a pass: at this depth the counts place the
  // candidate on neither side of the floor. The caller decides whether another wave is affordable; what
  // this must never do is round an undecided sample to OK. [LAW:no-silent-failure]
  // IMPROVED / OK are informational labels only (never the gate): the pooled point estimate rising above the
  // baseline's is suggestive, not significant at this denominator. Only DEGRADED reds the run.
  const status = decision.kind === 'continue'
    ? 'UNDECIDED'
    : degraded ? 'DEGRADED' : (baselinePooled.rate !== null && candidatePooled.rate > baselinePooled.rate ? 'IMPROVED' : 'OK');

  // Per-case localization — for each baseline case, its inventory diagnostic band vs the candidate's. `moved`
  // flags a case whose candidate MEAN recall dipped below the baseline's own observed worst run (its
  // diagnostic floor): the localizer for "which case moved the pooled rate". Diagnostics only — never a gate.
  const candByName = new Map(candidate.cases.map(c => [c.case, c]));
  const cases = baseline.cases.map((b) => {
    const c = candByName.get(b.case);
    const candBand = c.inventoryMustFindRecall;
    const delta = (candBand.mean !== null && b.inventoryMustFindRecall.mean !== null) ? candBand.mean - b.inventoryMustFindRecall.mean : null;
    const moved = (b.diagnosticFloor !== null && candBand.mean !== null && candBand.mean < b.diagnosticFloor);
    return {
      case: b.case,
      baselineBand: b.inventoryMustFindRecall,
      baselineDiagnosticFloor: b.diagnosticFloor,
      candidateBand: candBand,
      candidateDiagnosticFloor: c.diagnosticFloor,
      delta,
      moved,
    };
  });

  return {
    status,
    degraded,
    // WHICH CLAIM THIS VERDICT MAKES, carried beside the status rather than folded into it. 'certain' is
    // the full-depth verdict itself, reached from a partial sample by bounding every completion;
    // 'screened' is a ~2σ inference from that sample and is a strictly weaker sentence; null is UNDECIDED.
    // A screened PASS and an adjudicated PASS must never render as the same thing. [LAW:no-silent-failure]
    basis: decision.basis,
    depth: candidate.repeats,
    ceiling: baseline.repeats,
    replaysSpent: candidate.repeats * candidate.cases.length,
    interval: decision.interval,
    engine: baseline.engine,
    matcher: baseline.matcher,
    pooled: {
      candidate: candidatePooled,
      baseline: baselinePooled,
      gateFloor,
    },
    movedCases: cases.filter(c => c.moved).map(c => c.case),
    cases,
  };
}

// [LAW:effects-at-boundaries] Pure: the rung the ladder resumes at — the DEEPEST any case has reached.
// A suite pooled over unequal depth measures an unequal mixture, so an interrupted or UNDECIDED root that
// sits UNEVEN (one case at 2, another at 1) has to be levelled before it can be judged. freeze-suite.js
// fills levels UPWARD — planJobs adds a job only where `completed < level` — so the level that levels the
// root is the one the leader already stands on, and resuming there tops up every case behind it.
//
// The MINIMUM cannot do that job, and used to be taken: `-n <min>` is a no-op for the leader as well as
// for the laggard, so the root stayed uneven, score.js reported each case's own run count, and
// buildBaseline refused the pair ("a baseline needs one common N") on every retry — an externally
// interrupted root could never be resumed, which is the one thing resuming exists for. Levelling upward
// also keeps the replays already paid for, where trimming to the minimum would discard them.
// [LAW:one-source-of-truth]
function resumeDepth(caseNames, prior) {
  return Math.max(...caseNames.map(name => prior.filter(r => r.case === name).length));
}

// [LAW:effects-at-boundaries] Pure: can the remaining budget buy one more wave? Priced at the most
// EXPENSIVE wave this candidate has already cost, never a mean: a wave's wall clock is set by its slowest
// lane, and a lane that walled and handed its jobs on is exactly the risk a mean would average away. A
// status-check leg that planned no jobs contributes ~0 and cannot drag the estimate down for the same
// reason. [LAW:derive-dont-hardcode] — nothing here models lanes, per-replay minutes, or ceil-division;
// the previous wave IS the measurement, and the model that would have guessed those three is absent.
function affordsAnotherWave({ elapsedMs, longestWaveMs, budgetMs }) {
  return elapsedMs + longestWaveMs <= budgetMs;
}

const MS_PER_MINUTE = 60 * 1000;

// [LAW:effects-at-boundaries] Pure: the deadline ONE replay gets, drawn from the same budget that gates
// the waves — so the budget is the single owner of when the gate stops, inside a wave as well as between
// them. [LAW:one-source-of-truth] Without it affordsAnotherWave bounds only the transitions and
// freeze-suite's own 120m default governs what happens inside, so one stalled replay overruns a 45m bar
// by 75m. A replay that cannot finish inside the remaining budget cannot contribute to a verdict within
// it, so waiting past that point buys nothing.
//
// Whole minutes is the flag's unit: a sub-minute remainder resolves to the shortest deadline that can be
// expressed, which is a rounding, not a guard. The flag's UPPER bound is freeze-suite's parsePositiveInt
// to enforce and refuse — a second clamp here would be a second checkpoint. [LAW:single-enforcer]
function jobTimeoutMinutes({ elapsedMs, budgetMs }) {
  return Math.max(1, Math.ceil((budgetMs - elapsedMs) / MS_PER_MINUTE));
}

// [LAW:effects-at-boundaries] Pure: fold the per-run cost records the engine wrote into the ONE spend
// figure the verdict reports, with its BASIS attached. The basis travels with the number because these
// are not the same currency: a subscription run reports a NOTIONAL list-price equivalent of the quota it
// burned and bills nothing, and reporting that as dollars is how "$360" became a number the owner
// reasonably refused to pay. [FRAMING:representation]
//
// Mixed bases are never summed — two currencies added together is a figure with no meaning — but that
// rule is READ from src/usage.js's sumCost rather than restated here. [LAW:single-enforcer] It said so
// itself ("SUMMING IS THE ONE PLACE the 'never add across bases' rule lives"), and the copy that used to
// live here had already drifted to the opposite behaviour: it THREW where the canonical rule resolves to
// 'unpriced'. That throw fired while assembling the verdict record, after the replays were paid for, so a
// secondary figure could discard a primary answer that cost hours — reporting the spend as unknown is the
// honest arm, and losing the verdict is not a stricter version of it. [LAW:no-silent-failure]
//
// An 'unpriced' run is not a rival currency but a run whose price is unrecoverable (a schedule gap, an
// unreported figure), so it is withheld from the basis population and lands in `uncostedRuns` where it
// belongs — which is what it always was.
const AMOUNT_BY_BASIS = { dollars: c => c.usd, subscription: c => c.notionalUsd, unpriced: () => null };

function foldSpend(costs) {
  const present = costs.filter(c => c !== null && c !== undefined);
  const priced = present.filter(c => c.basis !== 'unpriced');
  const folded = priced.length === 0 ? null : sumCost(priced);
  const costedRuns = present.filter(c => Number.isFinite(AMOUNT_BY_BASIS[c.basis](c))).length;
  return {
    basis: folded === null ? null : folded.basis,
    amountUsd: folded === null ? null : AMOUNT_BY_BASIS[folded.basis](folded),
    costedRuns,
    uncostedRuns: costs.length - costedRuns,
  };
}

// Null-safe percent formatting — module scope so both the Markdown renderer and main()'s plain-text log
// line share ONE formatter. parseBaseline allows a pooled `rate` to be null (a hand-edited or otherwise
// non-buildBaseline-produced baseline.json), unlike gateFloor, which it requires; a bare `.toFixed(0)`
// on that field would coerce null to 0 and print a misleading "0%" instead of surfacing the gap.
// [LAW:one-source-of-truth]
function pct(v) {
  return v === null || v === undefined ? 'n/a' : `${(v * 100).toFixed(0)}%`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Rendering (pure). ONE renderer — Markdown — because the verdict table is meant to be pasted into a PR
// body (this ticket) and rendered into a GitHub Step Summary (2fk.6), and it reads fine in a terminal too.
// No plain/markdown split. [LAW:no-mode-explosion]
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

// ONE ARGUMENT, and it is exactly the object written to verdict.json. The human map and the machine map
// were previously built from different values — main() assembled a `cost` object, handed it to this
// renderer, and wrote only the verdict beside it, so the rendered page recorded a spend the machine-
// readable artifact did not, and neither carried wall clock. Two maps of one run that can disagree is one
// map too many. [LAW:one-source-of-truth] [FRAMING:representation]
function renderVerdictMarkdown(record) {
  const usd = (v) => (v === null || v === undefined ? 'n/a' : `$${v.toFixed(4)}`);
  const signedPct = (v) => (v === null || v === undefined ? 'n/a' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(0)}%`);
  const p = record.pooled;
  const eng = record.engine;
  const badge = {
    DEGRADED: '🔴 DEGRADED', OK: '🟢 OK', IMPROVED: '🟢 IMPROVED', UNDECIDED: '🟡 UNDECIDED',
  }[record.status] || record.status;

  // HOW MUCH THE VERDICT IS WORTH, in one clause, because the same badge means different things at
  // different bases. Rendering a screened pass and an adjudicated pass identically is the specific
  // dishonesty this gate was asked not to commit. [LAW:no-silent-failure]
  const claim = {
    certain: `**certain** — bounding every way the remaining ${record.ceiling - record.depth} wave(s) could land leaves the full-depth verdict unchanged, so this IS that verdict, bought early`,
    screened: `**screened** — the candidate's ~2σ interval sits entirely on one side of the floor at this depth. A weaker claim than a full-depth adjudication: the sample it rests on is ${record.depth}/${record.ceiling} of one`,
    null: `**undecided** — the interval straddles the floor at this depth and the ladder stopped short of the ceiling`,
  }[record.basis === null ? 'null' : record.basis];

  const lines = [
    `## Eval verdict — ${badge}`,
    '',
    `Candidate${record.candidate === undefined ? '' : ` (${describeTree(record.candidate)})`} vs baseline` +
      `${record.baselineSha ? ` \`${record.baselineSha.slice(0, 7)}\`` : ''}` +
      `${eng ? ` · engine \`${eng.provider}\`/\`${eng.model}\`${eng.reasoning ? `/reasoning=${eng.reasoning}` : ''}` : ''}` +
      `${record.matcher ? ` · matcher \`${record.matcher}\`` : ''}.`,
    '',
    `**Decided at wave ${record.depth} of ${record.ceiling}** (${record.replaysSpent} replay(s) spent, ceiling ${record.ceiling * record.cases.length}) · ${claim}.`,
    '',
    `**PRIMARY GATE — pooled inventory must-find recall:** candidate **${pct(p.candidate.rate)}** ` +
      `(${p.candidate.found}/${p.candidate.opportunities}, ~2σ ${pct(record.interval.lower)}–${pct(record.interval.upper)}) vs gate floor **${pct(p.gateFloor)}** ` +
      `(baseline ${pct(p.baseline.rate)}, ${p.baseline.found}/${p.baseline.opportunities}) → ` +
      `${record.degraded ? '**below floor**' : record.status === 'UNDECIDED' ? '**straddles the floor**' : 'at/above floor'}.`,
    '',
    '| case | baseline recall (mean [min–max]) | candidate recall (mean [min–max]) | Δ mean | moved? |',
    '|------|----------------------------------|-----------------------------------|--------|--------|',
  ];
  for (const c of record.cases) {
    const b = c.baselineBand;
    const cd = c.candidateBand;
    lines.push(
      `| \`${c.case}\` | ${pct(b.mean)} [${pct(b.min)}–${pct(b.max)}] | ${pct(cd.mean)} [${pct(cd.min)}–${pct(cd.max)}] | ${signedPct(c.delta)} | ${c.moved ? '⚠️ yes' : 'no'} |`,
    );
  }
  lines.push('');

  // WHAT IT COST, from the artifacts rather than from a log line that outlives nothing. The wall clock is
  // the suite's own timing legs (the figure the 45-minute bar is stated in — lanes overlap, so it is
  // elapsed time and never a sum of spawn durations), and the spend is the engine's own per-run records
  // with their basis intact.
  const r = record.run;
  lines.push(
    `**Wall clock:** ${formatDuration(r.elapsedMs)} of a ${formatDuration(r.budgetMs)} budget, over ${r.waves.length} wave(s)` +
    `${r.waves.length ? ` (${r.waves.map(w => formatDuration(w.elapsedMs)).join(', ')})` : ''}.`,
  );
  lines.push(
    `**Spend:** ${r.spend.amountUsd !== null ? `${usd(r.spend.amountUsd)}` : r.spend.basis === 'unpriced' ? 'no single figure — runs reported on bases that cannot be added' : 'not reported by the engine'}` +
    `${r.spend.basis === 'subscription' ? ' **notional** — subscription quota at list-price equivalent, not billed' : r.spend.basis === 'dollars' ? ' billed' : ''}` +
    ` over ${r.spend.costedRuns} costed run(s)${r.spend.uncostedRuns ? `, ${r.spend.uncostedRuns} uncosted` : ''}.`,
  );
  if (record.cost) {
    lines.push(
      `**Cost basis:** baseline ≈ ${usd(record.cost.baselinePerRun)}/full-run vs candidate ≈ ${usd(record.cost.candidatePerRun)}/full-run` +
      `${record.cost.delta === null ? '' : ` (Δ ${record.cost.delta >= 0 ? '+' : ''}${usd(record.cost.delta)})`}.`,
    );
  }
  lines.push('');

  // The final one-line verdict — the sentence a reader (or the Step Summary) reads first.
  if (record.degraded) {
    const named = record.movedCases.length
      ? `Localized to: ${record.movedCases.map(n => `\`${n}\``).join(', ')} (candidate mean below the case's diagnostic floor).`
      : `No single case crossed its diagnostic floor — the pooled recall fell broadly, not in one case.`;
    lines.push(`**VERDICT: DEGRADED** — candidate pooled inventory must-find recall ${pct(p.candidate.rate)} is below the ${pct(p.gateFloor)} gate floor. ${named}`);
  } else if (record.status === 'UNDECIDED') {
    lines.push(
      `**VERDICT: UNDECIDED — NOT MEASURED, WHICH IS NOT THE SAME AS NOT DEGRADED.** At ${record.replaysSpent} replay(s) the pooled recall ${pct(p.candidate.rate)} sits inside its own sampling error of the ${pct(p.gateFloor)} floor, and the ladder stopped before the ceiling. The wall-clock line above says whether the budget is what stopped it. Re-run against the same \`--out\` to continue from wave ${record.depth + 1}, or raise \`--budget-minutes\` to adjudicate in one pass.`,
    );
  } else if (record.status === 'IMPROVED') {
    lines.push(`**VERDICT: OK (improved)** — candidate pooled inventory must-find recall ${pct(p.candidate.rate)} clears the ${pct(p.gateFloor)} floor and exceeds the baseline ${pct(p.baseline.rate)}. (Point estimate only — not significant at this denominator.)`);
  } else {
    lines.push(`**VERDICT: OK** — candidate pooled inventory must-find recall ${pct(p.candidate.rate)} clears the ${pct(p.gateFloor)} gate floor. Finding quality is not degraded.`);
  }
  lines.push('');
  return lines.join('\n') + '\n';
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Effects (main) — resolve the baseline, spawn the replay+score CLIs, reduce, compare, exit.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

// Every commit SHA in `gitCwd`'s history, git's own default order (newest first) — the commit GRAPH's
// parent→child order, not a timestamp. Two baselines frozen back to back land in the SAME second (%cI is
// second-granularity), so comparing ISO timestamp strings ties exactly the pair this tie-break exists to
// distinguish; the commit graph never ties, because a child's parent pointer fixes its position regardless
// of clock resolution. Empty (not a repo, no commits, git unavailable) is a legitimate value, not an error
// — every downstream rank then resolves to null, the same as "uncommitted."
function commitOrder(gitCwd) {
  try {
    return execFileSync('git', ['log', '--format=%H'], { cwd: gitCwd }).toString().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

// filePath's position in `order` (0 = most recent commit in the repo), or null if git can't place it (not
// a repo, the file was never committed, git unavailable). Lower rank = more recently touched.
function lastCommitRank(filePath, gitCwd, order) {
  try {
    const sha = execFileSync('git', ['log', '-1', '--format=%H', '--', filePath], { cwd: gitCwd }).toString().trim();
    if (!sha) return null;
    const idx = order.indexOf(sha);
    return idx === -1 ? null : idx;
  } catch {
    return null;
  }
}

// True when `gitCwd` is a shallow clone (e.g. actions/checkout's default fetch-depth: 1) — commitOrder then
// sees only the truncated history it was given, not the repo's real graph. False on any git failure (not a
// repo, git unavailable): that absence is already reported by commitOrder/lastCommitRank returning null,
// not this function's job to re-diagnose.
function isShallowRepo(gitCwd) {
  try {
    return execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: gitCwd }).toString().trim() === 'true';
  } catch {
    return false;
  }
}

// Resolve a --baseline argument (a dir or a baseline.json path) to the baseline.json file. With no
// argument, pick the newest committed baseline under eval/baseline/. Dirs are `<date>-<shortsha>`; two
// baselines frozen on the same UTC date (plausible mid-tuning: freeze, tweak a case, re-freeze) tie on a
// bare name sort, breaking on the arbitrary short-SHA string — no relation to actual recency. Two prior
// fixes both failed on this same scenario: `generatedAt` carries the identical `YYYY-MM-DD` string the dir
// name is already built from (no finer granularity); comparing each commit's ISO timestamp still ties
// when — as is common for a scripted freeze/re-freeze — both commits land in the same second. Rank by
// position in the commit GRAPH instead (commitOrder/lastCommitRank): unambiguous even for same-second
// commits, since a child's parent pointer fixes order regardless of clock resolution. An UNCOMMITTED
// baseline.json (rank null — no commit touches it yet, the exact "just froze it, about to gate" moment)
// ranks as MORE recent than even the latest real commit, not less.
//
// A GENUINE TIE between the top two ranked candidates — including the shallow-clone case (actions/
// checkout's default fetch-depth: 1 truncates history to the boundary commit; git then reports THAT one
// commit as the last to touch every path present in its tree, verified empirically, so every real baseline
// ties at the same rank) — is refused outright rather than resolved by name order: a wrong SILENT pick is
// worse than a loud stop naming the fix. This is deliberately NOT a raw "more than one committed baseline"
// gate: that over-refuses a fully decidable case (one candidate genuinely uncommitted among several
// committed ones already wins outright, tying with nothing) purely because more than one dir happens to
// exist. Rank first, refuse only an actual tie. [LAW:no-silent-failure]
function resolveBaselineJsonPath(arg, gitCwd = __dirname) {
  if (arg) {
    const resolved = path.resolve(arg);
    if (!fs.existsSync(resolved)) throw new Error(`--baseline path not found: ${resolved}.`);
    const jsonPath = fs.statSync(resolved).isDirectory() ? path.join(resolved, 'baseline.json') : resolved;
    if (!fs.existsSync(jsonPath)) throw new Error(`No baseline.json at ${jsonPath}.`);
    return jsonPath;
  }
  const root = path.resolve('eval/baseline');
  if (!fs.existsSync(root)) throw new Error(`No baseline dir at ${root} and no --baseline given. Freeze one with eval/baseline.js first.`);
  const dirNames = fs.readdirSync(root, { withFileTypes: true })
    .filter(e => e.isDirectory() && fs.existsSync(path.join(root, e.name, 'baseline.json')))
    .map(e => e.name);
  if (dirNames.length === 0) throw new Error(`No committed baseline (a dir with baseline.json) under ${root}.`);
  const order = commitOrder(gitCwd);
  const rankKey = (rank) => (rank === null ? -1 : rank); // uncommitted (-1) ranks before even the newest real commit (0)
  const candidates = dirNames
    .map((name) => {
      const jsonPath = path.join(root, name, 'baseline.json');
      return { name, jsonPath, rank: lastCommitRank(jsonPath, gitCwd, order) };
    })
    .sort((a, b) => rankKey(a.rank) - rankKey(b.rank)); // ascending: index 0 (most recent) sorts first
  if (candidates.length > 1 && rankKey(candidates[0].rank) === rankKey(candidates[1].rank)) {
    const shallowHint = isShallowRepo(gitCwd)
      ? `this is a shallow git clone, so the commit-history tie-break has no real history to rank them by — run 'git fetch --unshallow' first, or `
      : '';
    throw new Error(`Cannot pick the newest committed baseline under ${root}: '${candidates[0].name}' and '${candidates[1].name}' tie (${shallowHint}name --baseline explicitly to disambiguate).`);
  }
  return candidates[0].jsonPath;
}

// Spawn a dev CLI (freeze-suite.js / score.js) with stdio inherited so its progress streams live, and abort the
// whole gate if it fails — a partial or errored candidate must never be silently scored. [LAW:no-silent-failure]
function runCli(scriptPath, args, label) {
  const res = spawnSync('node', [scriptPath, ...args], { stdio: 'inherit', env: process.env });
  if (res.error) throw new Error(`${label} failed to spawn: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`${label} exited ${res.status === null ? `on signal ${res.signal}` : `with code ${res.status}`}.`);
}

// A tree as a phrase, for the refusal below: the reader must see BOTH sides to know which to fix.
function describeTree(candidate) {
  if (candidate === null) return 'no recorded identity';
  return `${candidate.dirty ? 'a dirty tree at ' : ''}commit ${candidate.sha.slice(0, 7)}`;
}

// [LAW:effects-at-boundaries] Pure: which runs under --out cannot be this candidate's. A run is the
// candidate's own only when both carry the SAME identity — one clean commit (treeIdentity); a dirty tree
// on either side has none, so nothing can be proven and everything is foreign. Every foreign run is named
// with both trees, so the operator knows whether to move the runs or commit the tree.
function foreignRuns(current, runs) {
  const identity = treeIdentity(current);
  return runs
    .filter(({ candidate }) => identity === null || candidate === null || treeIdentity(candidate) !== identity)
    .map(({ dir, candidate }) => ({ dir, reason: `was replayed on ${describeTree(candidate)}; the tree under gate is ${describeTree(current)}` }));
}

// Every completed run already under the candidate root for the gated cases, with the tree that produced
// it. "Completed" is score.js's own predicate (listRunDirs) — the same census freeze-suite.js will take,
// so what this accepts is exactly what the replay will count. A run whose record names a different case
// than the directory it sits in is refused here, before the spend, with the check score.js would make
// after it. [LAW:one-source-of-truth] [LAW:parse-dont-validate]
function readPriorRuns(candidateRoot, caseNames) {
  return caseNames.flatMap(name => listRunDirs(path.join(candidateRoot, name)).map(dir => {
    const metaPath = path.join(dir, 'meta.json');
    const meta = parseMeta(fs.readFileSync(metaPath, 'utf8'), metaPath);
    if (meta.case !== name) throw new Error(`${metaPath} names case '${meta.case}' but lives under '${name}' — a misplaced run; move or remove it.`);
    return { case: name, dir, candidate: meta.candidate };
  }));
}

// The spend the ENGINE reported for every completed run under the root, folded to one figure with its
// basis. Reads through score.js's parseUsage — the single parser for a usage record — rather than
// reaching into the JSON here. [LAW:single-enforcer]
function readCandidateSpend(candidateRoot, caseNames) {
  return foldSpend(caseNames.flatMap(name => listRunDirs(path.join(candidateRoot, name)).map((dir) => {
    const usagePath = path.join(dir, 'usage.json');
    return fs.existsSync(usagePath) ? parseUsage(fs.readFileSync(usagePath, 'utf8'), usagePath).cost : null;
  })));
}

// The longest wave this candidate has actually cost — the price the next one is quoted at.
//
// [LAW:no-silent-failure] Zero legs after a replay is refused rather than defaulted, and the reason is that
// the innocent-looking default is the dangerous one: a missing measurement folded to 0 reads as "the next
// wave is free", which affords every remaining wave and spends the whole ceiling — the exact overrun the
// budget exists to prevent. A budget derived from an artifact must fail loudly when the artifact is absent.
function measuredWaveMs(candidateRoot) {
  const { legs } = readSuiteTiming(candidateRoot);
  if (legs.length === 0) {
    throw new Error(`No suite timing leg under ${candidateRoot} after a replay — the wall clock the budget is derived from was never written, so the next wave cannot be priced. Refusing to size it by guess.`);
  }
  return legs.reduce((longest, leg) => Math.max(longest, leg.elapsedMs), 0);
}

// The candidate suite AS IT NOW STANDS on disk: every gated case's scored summary + its pinned engine,
// reduced by the SAME buildBaseline the frozen baseline was built with, so producer and comparator cannot
// drift. [LAW:one-source-of-truth] Called once per rung — the ladder re-reads rather than accumulating in
// memory, so what it judges is always what was actually written.
function reduceCandidateSuite(candidateRoot, caseNames, casesDir, produced) {
  const candidateCases = caseNames.map((name) => {
    const summaryPath = path.join(candidateRoot, name, 'scorecard-summary.json');
    if (!fs.existsSync(summaryPath)) throw new Error(`No candidate summary for case '${name}' at ${summaryPath}. The replay/score step did not produce it.`);
    const summary = parseCaseSummary(fs.readFileSync(summaryPath, 'utf8'), summaryPath);
    if (summary.case !== name) throw new Error(`${summaryPath} names case '${summary.case}' but lives under '${name}'.`);
    const caseJsonPath = path.join(casesDir, name, 'case.json');
    return { summary, engine: parseCaseEngine(fs.readFileSync(caseJsonPath, 'utf8'), caseJsonPath) };
  });
  return buildBaseline({
    cases: candidateCases,
    provenance: { sha: produced === null ? null : produced.sha, date: new Date().toISOString().slice(0, 10) },
  });
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  // 0. THE INVOCATION'S CLOCK, read once and never again. Everything the budget is judged on is elapsed
  //    time from here — including baseline resolution, scoring, and judging, not just the replays — so
  //    the budget bounds what the operator actually waits for. [LAW:no-ambient-temporal-coupling]
  const startedMs = Date.now();
  const budgetMs = opts.budgetMinutes * MS_PER_MINUTE;

  // 1. Flag combinations that contradict each other were refused in parseArgs, before any IO.

  // 2. Load the frozen baseline. Parse the raw object once for the cost preview (parseBaseline is a lossy
  //    GATE SUBSET that deliberately drops cost — do not widen it), and parseBaseline for the gate contract.
  const baselineJsonPath = resolveBaselineJsonPath(opts.baseline);
  const rawBaselineText = fs.readFileSync(baselineJsonPath, 'utf8');
  const baseline = parseBaseline(rawBaselineText, baselineJsonPath);
  const rawBaselineSuite = JSON.parse(rawBaselineText).suite;
  const repeats = baseline.repeats;

  const casesDir = path.resolve(opts.casesDir);
  const freezeSuiteScript = path.join(__dirname, 'freeze-suite.js');
  const scoreScript = path.join(__dirname, 'score.js');
  const caseNames = baseline.cases.map(({ case: name }) => name);

  // 3. Candidate artifact root — isolated from the baseline's own eval/out/<case> runs so score.js never
  //    pools baseline + candidate run dirs together. Under eval/out/ (git-ignored) by default. Resolved
  //    BEFORE any refusal below, because the first thing done under it must be undoing the last thing an
  //    earlier invocation left there: a verdict is the product of ONE invocation over the WHOLE suite, and
  //    one left under this root would be read as this run's if this run stopped before writing its own —
  //    at a refusal below or an abort later (eval.yml publishes verdict.md from the root, whatever exit
  //    it sees). Gone first, unconditionally, in both modes — a fresh root has nothing to remove and the
  //    same operation runs. [LAW:dataflow-not-control-flow] [LAW:no-silent-failure]
  const candidateRoot = opts.reuseCandidate
    ? path.resolve(opts.reuseCandidate)
    : path.resolve(opts.out || path.join('eval', 'out', `candidate-${new Date().toISOString().replace(/[:.]/g, '-')}`));
  for (const file of ['verdict.md', 'verdict.json']) fs.rmSync(path.join(candidateRoot, file), { force: true });

  // The pre-spend guards below (4-4c) all share one shape: refuse BEFORE any replay when the thing they
  // check is knowable without running the candidate engine at all. None of them apply under
  // --reuse-candidate, which replays nothing — compareVerdict's own checks (matcher, engine, pooled
  // opportunities), reading the reused summaries' ACTUAL recorded values, are the universal backstop for
  // that path. [LAW:no-silent-failure]
  if (!opts.reuseCandidate) {
    // 4. Fail BEFORE spending an hour on a matcher that can't be compared: the candidate is scored with
    //    opts.matcher, which must yield the baseline's exact matcher label.
    if (baseline.matcher) {
      const wouldBe = expectedMatcherLabel(opts.matcher);
      if (wouldBe !== baseline.matcher) {
        throw new Error(`Matcher mismatch: --matcher ${opts.matcher} scores as '${wouldBe}' but the baseline used '${baseline.matcher}'. Pass the matcher the baseline was built with.`);
      }
    }

    // 4a. Fail BEFORE spending if the 'llm' matcher's credential is missing — score.js's makeLlmJudge
    //     would otherwise throw only once a case's replay is already complete and its OWN score.js
    //     invocation runs, wasting that case's real spend on a run this file was never going to be able
    //     to score.
    if (opts.matcher === 'llm') requireLlmJudgeCredential();

    // 4b. Fail BEFORE spending on a denominator that's already known to mismatch: each case's pooled
    //     inventory opportunity count is a PURE function of its current expected.json (findings annotated
    //     must-find, any round) — it does not depend on what the candidate engine produces, so it costs
    //     nothing to check here.
    const mustFindCountsByCase = {};
    for (const { case: name } of baseline.cases) {
      const expectedPath = path.join(casesDir, name, 'expected.json');
      if (!fs.existsSync(expectedPath)) throw new Error(`Baseline case '${name}' has no frozen case at ${path.join(casesDir, name)} — cannot replay it.`);
      const expected = parseExpected(fs.readFileSync(expectedPath, 'utf8'), expectedPath);
      mustFindCountsByCase[name] = expected.findings.filter(f => f.annotation === 'must-find').length;
    }
    const currentOpportunities = computeExpectedOpportunities(mustFindCountsByCase, repeats);
    if (currentOpportunities !== baseline.pooledInventoryMustFind.opportunities) {
      throw new Error(`Incomparable: the golden suite's current pooled inventory opportunities (${currentOpportunities}) differ from the baseline's (${baseline.pooledInventoryMustFind.opportunities}) — expected.json changed since the baseline was frozen. Re-freeze the baseline before gating against this expected.json.`);
    }

    // 4c. Fail BEFORE spending on engine drift — a FULL pass over every case, not a check folded into the
    //     replay loop below: if only a LATER case's engine pin had drifted, folding it into that loop would
    //     let every EARLIER case fully replay and score (real spend) before the mismatch is even reached.
    //     run-case.js's own assertConfigMatchesPin only verifies the resolved config against THIS
    //     case.json's own pin — never against baseline.engine, the pin frozen at baseline-freeze time — so
    //     a drifted pin would otherwise only be caught by compareVerdict's sameEngine check, after the
    //     ENTIRE suite has replayed and scored.
    if (baseline.engine) {
      for (const { case: name } of baseline.cases) {
        const caseJsonPath = path.join(casesDir, name, 'case.json');
        if (!fs.existsSync(caseJsonPath)) throw new Error(`Baseline case '${name}' has no frozen case at ${path.join(casesDir, name)} — cannot replay it.`);
        const casePinEngine = parseCaseEngine(fs.readFileSync(caseJsonPath, 'utf8'), caseJsonPath);
        if (!sameEngine(casePinEngine, baseline.engine)) {
          throw new Error(`Incomparable: case '${name}' pins engine ${JSON.stringify(casePinEngine)} but the baseline pins ${JSON.stringify(baseline.engine)} — the case's pin drifted since the baseline was frozen. Re-freeze the baseline, or fix the case's pin, before gating.`);
        }
      }
    }
  }

  process.stderr.write(`\nBaseline: ${baselineJsonPath}\n`);
  process.stderr.write(`  ${baseline.mainSha.slice(0, 7)} · engine ${baseline.engine ? `${baseline.engine.provider}/${baseline.engine.model}` : '(unpinned)'} · N=${repeats} · matcher ${baseline.matcher || '(none)'}\n`);
  process.stderr.write(`  gate floor ${pct(baseline.pooledInventoryMustFind.gateFloor)} (baseline pooled ${pct(baseline.pooledInventoryMustFind.rate)}, ${baseline.pooledInventoryMustFind.found}/${baseline.pooledInventoryMustFind.opportunities})\n`);

  // ONE ASSESSMENT, wherever the runs came from: re-read the root, name the tree that produced it, fold
  // the suite with the baseline's own reducer, and ask decideLadder where it stands. The ladder calls this
  // once per rung and the reuse path calls it once; there is no second reduction anywhere to disagree
  // with it. [LAW:one-source-of-truth]
  const assess = () => {
    const runs = readPriorRuns(candidateRoot, caseNames);
    const tree = producedTree(runs);
    const suite = reduceCandidateSuite(candidateRoot, caseNames, casesDir, tree);
    return { tree, suite, verdict: compareVerdict(baseline, suite) };
  };

  let assessment;
  if (opts.reuseCandidate) {
    // --matcher (default 'llm' even when never passed) has no effect in this branch: no scoring runs here,
    // and compareVerdict checks the reused summaries' ACTUAL recorded matcher, not opts.matcher. Loud about
    // it rather than a silent no-op, the same reasoning that made --out + --reuse-candidate an outright
    // refusal above — except here there's a principled winner (the reused data), just not the flag's value.
    process.stderr.write(`\nReusing candidate artifacts under ${candidateRoot} (no replay, no spend). --matcher is ignored in this mode — the reused summaries' own recorded matcher is what's checked.\n`);
    assessment = assess();
  } else {
    // 5. An --out that already holds runs is either this candidate's own partial suite — an earlier gate
    //    invocation on the same clean commit that walled, timed out, or stopped UNDECIDED at a rung, which
    //    freeze-suite.js's census then tops up (the whole reason a hosted gate can outlive a quota wall:
    //    eval.yml carries the root across dispatches) — or someone else's. run-case.js is append-only and
    //    score.js pools EVERY run dir under a case into one summary, so one foreign run would blend two
    //    trees into a single candidate with no error. Every prior run must therefore carry the identity of
    //    the tree under gate, and any that cannot is refused by name, before any spend.
    //    [LAW:no-silent-failure] [LAW:parse-dont-validate]
    // The tree under gate, snapshotted once before any replay: the census here and the drift check below
    // both compare against it. [LAW:one-source-of-truth]
    const candidate = workingTree();
    const prior = readPriorRuns(candidateRoot, caseNames);
    const foreign = foreignRuns(candidate, prior);
    if (foreign.length > 0) {
      throw new Error(`--out ${candidateRoot} holds ${foreign.length} run(s) that are not this candidate's:\n${foreign.map(f => `  ${f.dir} ${f.reason}`).join('\n')}\nPick a fresh --out, or remove them first.`);
    }
    // The ceiling, not a target: a case holding more runs than the baseline's N is past the top rung, and
    // a suite pooled over unequal depth measures an unequal mixture.
    const excess = excessRuns(caseNames, prior, repeats);
    if (excess.length > 0) {
      throw new Error(`--out ${candidateRoot} holds more runs than the baseline's ceiling N=${repeats} for ${excess.map(c => `'${c.case}' (${c.completed})`).join(', ')} — a suite scored past the top rung is not comparable. Remove the surplus runs, or pick a fresh --out.`);
    }
    for (const name of caseNames) {
      process.stderr.write(`  ${name}: ${prior.filter(r => r.case === name).length}/${repeats} run(s) of this candidate already under --out\n`);
    }

    // 6. SPEND GUARDRAIL, stated as the ladder's shape rather than as one number: the gate buys one wave
    //    at a time and stops at the first that decides, so the figure that matters up front is what a wave
    //    costs and what the ceiling would cost if every rung were bought. [LAW:verifiable-goals]
    const perWaveUsd = estimateCandidateCostUsd(rawBaselineSuite, 1);
    const startDepth = Math.max(1, resumeDepth(caseNames, prior));
    process.stderr.write(`\nWalking the ladder from wave ${startDepth} to at most ${repeats}: ${caseNames.length} replay(s) per wave against the WORKING TREE, scored and judged after each, stopping at the first wave that decides.\n`);
    process.stderr.write(`Budget ${opts.budgetMinutes} minute(s) for this invocation. Estimated cost ${perWaveUsd === null ? 'unknown (the baseline recorded no per-run cost — its engine bills quota, not dollars)' : `≈ $${perWaveUsd.toFixed(2)} per wave, ≤ $${(perWaveUsd * repeats).toFixed(2)} if every rung is bought`}.\n\n`);

    // 7. THE LADDER. Bounded by the ceiling in the loop header, so it terminates structurally and needs no
    //    guard against running away; decideLadder independently guarantees the top rung always decides, so
    //    the bound is never actually the thing that stops it. [LAW:dataflow-not-control-flow]
    for (let depth = startDepth; depth <= repeats; depth++) {
      process.stderr.write(`\n─── wave ${depth}/${repeats}: replaying ${caseNames.length} case(s) to depth ${depth} ───\n`);
      const jobTimeout = jobTimeoutMinutes({ elapsedMs: Date.now() - startedMs, budgetMs });
      runCli(freezeSuiteScript, replayArgs({ repeats: depth, candidateRoot, casesDir, caseNames, credentials: opts.credentials, jobTimeout }), 'freeze-suite');

      // 7a. Every run now under --out — inherited and just produced — must record the tree snapshotted
      //     above: each replay wrote the tree it ran on, so a working tree that moved mid-invocation shows
      //     up here, refused by name before it can be pooled into a verdict that names the snapshot.
      //     [LAW:verifiable-goals] [LAW:one-source-of-truth]
      const drifted = driftedRuns(candidate, readPriorRuns(candidateRoot, caseNames));
      if (drifted.length > 0) {
        throw new Error(`The working tree changed while the suite replayed: ${drifted.length} run(s) under ${candidateRoot} carry a different identity:\n${drifted.map(f => `  ${f.dir} ${f.reason}`).join('\n')}\nNo verdict written — it would name a tree that produced none of these runs.`);
      }

      // 7b. Score each case at this rung. The judge is one credential and cheap; it needs no lanes, and
      //     its content-keyed cache means re-scoring the earlier waves consults no judge again.
      for (const name of caseNames) {
        process.stderr.write(`\n─── ${name}: scoring at depth ${depth} ───\n`);
        runCli(scoreScript, [path.join(candidateRoot, name), '--matcher', opts.matcher, '--cases-dir', casesDir, '--cache', path.resolve(opts.cache)], `score (${name})`);
      }

      assessment = assess();
      const { status, basis, pooled, interval } = assessment.verdict;
      process.stderr.write(`\nwave ${depth}/${repeats}: pooled ${pooled.candidate.found}/${pooled.candidate.opportunities} = ${pct(pooled.candidate.rate)} (~2σ ${pct(interval.lower)}–${pct(interval.upper)}) vs floor ${pct(pooled.gateFloor)} → ${status}${basis ? ` (${basis})` : ''}\n`);
      if (status !== 'UNDECIDED') break;

      // The next wave is priced at the most expensive one this candidate has actually cost — measured,
      // never modelled. A wave that will not fit is not started: an overrun gate is killed mid-suite with
      // real quota spent and no verdict, which reads as infrastructure failure rather than as a gate that
      // could not finish. [LAW:no-silent-failure]
      const nextWaveMs = measuredWaveMs(candidateRoot);
      const elapsedMs = Date.now() - startedMs;
      if (!affordsAnotherWave({ elapsedMs, longestWaveMs: nextWaveMs, budgetMs })) {
        process.stderr.write(`\nStopping at wave ${depth}: ${formatDuration(elapsedMs)} spent of the ${formatDuration(budgetMs)} budget, and the next wave costs about ${formatDuration(nextWaveMs)}. Reporting UNDECIDED rather than overrunning.\n`);
        break;
      }
    }
  }

  // 8. THE VERDICT RECORD — one object, written to verdict.json and rendered to verdict.md, so the machine
  //    map and the human map carry the same facts including what the run cost. [LAW:one-source-of-truth]
  const timing = readSuiteTiming(candidateRoot);
  const cost = {
    baselinePerRun: rawBaselineSuite ? rawBaselineSuite.costPerFullRunUsd ?? null : null,
    candidatePerRun: assessment.suite.suite.costPerFullRunUsd,
    delta: null,
  };
  if (typeof cost.baselinePerRun === 'number' && typeof cost.candidatePerRun === 'number') cost.delta = cost.candidatePerRun - cost.baselinePerRun;
  const record = {
    ...assessment.verdict,
    candidate: assessment.tree,
    baselineSha: baseline.mainSha,
    cost,
    run: {
      elapsedMs: Date.now() - startedMs,
      budgetMs,
      waves: timing.legs.map(leg => ({ startedAt: leg.startedAt, elapsedMs: leg.elapsedMs, replays: leg.replays.length })),
      spend: readCandidateSpend(candidateRoot, caseNames),
    },
  };
  const md = renderVerdictMarkdown(record);

  // Write the verdict alongside the candidate artifacts (eval.yml reads verdict.md into a Step Summary),
  // and print it to stdout so it's pasteable straight into a PR body.
  try {
    fs.mkdirSync(candidateRoot, { recursive: true });
    fs.writeFileSync(path.join(candidateRoot, 'verdict.md'), md);
    fs.writeFileSync(path.join(candidateRoot, 'verdict.json'), JSON.stringify(record, null, 2) + '\n');
  } catch (e) {
    process.stderr.write(`(warning: could not write verdict artifacts under ${candidateRoot}: ${e.message})\n`);
  }
  process.stdout.write('\n' + md);
  process.stderr.write(`\nVerdict artifacts → ${candidateRoot}/verdict.{md,json}\n`);

  // The exit code is the gate's contract, and UNDECIDED needs its own: it is neither a pass (nothing was
  // proven) nor a degradation (nothing was disproven), and collapsing it onto either is the lie this
  // verdict exists to avoid. 0 = OK/IMPROVED, 1 = DEGRADED, 2 = the gate could not run, 3 = UNDECIDED.
  return { OK: 0, IMPROVED: 0, DEGRADED: 1, UNDECIDED: 3 }[record.status];
}

if (require.main === module) {
  try {
    process.exit(main());
  } catch (err) {
    process.stderr.write(`compare: ${err.message}\n`);
    process.exit(2); // 2 = the gate could not run (distinct from 1 = ran and DEGRADED).
  }
}

module.exports = {
  parseArgs, replayArgs, jobTimeoutMinutes, expectedMatcherLabel, estimateCandidateCostUsd,
  compareVerdict, renderVerdictMarkdown, resolveBaselineJsonPath, computeExpectedOpportunities,
  foreignRuns, readPriorRuns, excessRuns, driftedRuns, producedTree,
  resumeDepth, affordsAnotherWave, foldSpend,
};
