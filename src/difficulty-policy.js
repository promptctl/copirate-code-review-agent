'use strict';

const { effectiveRounds, defaultBudgetCandidates } = require('./budget');
const { TIER_RANK } = require('./effort');

// [FRAMING:parts-and-seams] The difficulty POLICY: the part that turns the pure, pre-spend difficulty
// SIGNALS (assessDifficulty in difficulty.js — churn, spread, kind breakdown) into an EffortProfile
// candidate ladder for chooseProfile. It is the deliberate counterpart to difficulty.js: that module
// MEASURES and carries no effort knowledge; this module DECIDES and carries no measurement. [LAW:decomposition]
// The two epics compose at the run() seam — difficulty PROPOSES the ceiling here, budget CAPS within it
// via chooseProfile — so this module depends only on budget.js's ladder machinery
// (defaultBudgetCandidates, effectiveRounds) and the Difficulty value shape, never the reverse. [LAW:one-way-deps]
//
// SCOPE: TWO cost-bearing axes, moving in OPPOSITE directions as difficulty rises. roundCap LOWERS for
// easy changes (cheap reviews for trivial diffs) and never exceeds the user's configured ceiling.
// reasoningTier RAISES for hard changes (thorough reviews for complex diffs — slice zai-difficulty-0ea.3):
// it is priced in budget.js and folded onto each config's own reasoning as a FLOOR at the runMultiScope
// seam, so a raised tier is real spend, never a no-op the profile can't price. [LAW:types-are-the-program]
// The two axes are independent bands over the SAME magnitude, and the candidate set is their cross product
// so budget can cap DOWN either — difficulty proposes the ceiling on both axes; budget picks the
// affordable best. [LAW:dataflow-not-control-flow]

// [LAW:one-source-of-truth] Policy tunables — hand-tuned difficulty thresholds, documented, in this one
// place. Like PRICES_PER_MILLION (usage.js) and CALIBRATION (budget.js) this is a representation with no
// machine source: it encodes a REVIEW-EFFORT judgment ("how much scrutiny does a change of this shape
// warrant"), tuned against this repo's own dogfooded PRs, and is expected to drift and be retuned. It is
// NOT an action input — the only difficulty knob a consumer sees is the on/off DIFFICULTY_SCALING switch;
// everything about HOW difficulty maps to effort lives here. [LAW:no-mode-explosion]
//
//   SPREAD_WEIGHT       Each touched file adds this many churn-EQUIVALENT lines to the effort magnitude:
//                       review cost scales with how many distinct files/contexts must be held, not only
//                       with the raw line count, so a wide change (many files, few lines each — a
//                       cross-cutting rename or signature change) is not "trivial" the way its churn
//                       alone would suggest.
//   NONSOURCE_DISCOUNT  A change touching NO source file (tests-only / docs-only — kinds.source === 0) is
//                       intrinsically lower review-risk per line, so its magnitude is scaled by this
//                       factor. It only SHIFTS the bands (a huge tests-only change still earns real
//                       effort), never a blanket floor. This is the epic's headline signal: a docs typo
//                       and a concurrency refactor must not draw the same effort.
const SPREAD_WEIGHT = 8;
const NONSOURCE_DISCOUNT = 0.4;

// [LAW:dataflow-not-control-flow] The effort ladder as VALUE bands: the band that covers a change's
// magnitude sets its proposed roundCap ceiling. A magnitude above every band proposes NO lowering — the
// user's full configured ceiling stands (a substantial change deserves full effort). Bands are the
// cost-bearing roundCap axis only; each future cost-bearing axis grows its own band table HERE alongside
// this one. [LAW:carrying-cost] Listed low→high only for human readability — selectBand is
// order-INDEPENDENT (it picks the smallest covering band by value), so a reorder cannot change behavior.
const DIFFICULTY_BANDS = [
  { maxMagnitude: 20, roundCap: 1 },   // trivial: a typo, a one-line tweak, a tiny docs edit
  { maxMagnitude: 80, roundCap: 2 },   // small: a focused fix
  { maxMagnitude: 250, roundCap: 3 },  // moderate: a contained feature
  // above 250 → the user's full ceiling (substantial: a large or cross-cutting change)
];

// [LAW:dataflow-not-control-flow] The reasoning-RAISE bands, the counterpart table to DIFFICULTY_BANDS on
// the second cost-bearing axis. Same selectBand semantics (smallest covering maxMagnitude wins), so a
// LARGER magnitude falls through the cheap `null` band into a higher-tier band: difficulty raises
// reasoning only once a change is substantial enough to warrant deeper scrutiny per round. `null` = "no
// raise; the config's own reasoning stands" (the fold's byte-identical floor). The Infinity band makes
// the table TOTAL so a huge change always names a tier (selectBand returns null only for an uncovered
// magnitude — here nothing is uncovered). Thresholds are hand-tuned like DIFFICULTY_BANDS; the raise
// starts at 250, exactly where roundCap stops lowering, so the two axes hand off cleanly at "substantial".
const DIFFICULTY_REASONING_BANDS = [
  { maxMagnitude: 250, tier: null },       // trivial..moderate: no raise (roundCap may still LOWER here)
  { maxMagnitude: 600, tier: 'high' },     // substantial: reason harder each round
  { maxMagnitude: Infinity, tier: 'max' }, // very large / cross-cutting: full reasoning depth
];

// [LAW:effects-at-boundaries] Pure. [LAW:types-are-the-program] The band a magnitude falls in: the one
// with the SMALLEST maxMagnitude that still covers it, selected regardless of array order — so the band
// table is an unordered SET, not a list carrying a fragile ascending-order invariant a reorder could
// silently break. `null` when no band covers the magnitude (it exceeds every band → propose no change).
// [LAW:one-type-per-behavior] The SAME selection serves both cost-bearing axes — the roundCap bands and
// the reasoning-tier bands are one behavior differing only in their cost field. The tie-break is EXPLICIT
// and axis-agnostic via `rankOf`: on equal maxMagnitude the band with the smaller cost rank (the cheaper
// rung) wins, so the result is deterministic and order-independent even for a degenerate table with
// duplicate maxMagnitude — the reduce never silently keeps whichever the array order happened to visit
// first. `rankOf` defaults to `roundCap` (the original behavior); the reasoning axis passes TIER_RANK.
function selectBand(bands, magnitude, rankOf = (b) => b.roundCap) {
  const covering = bands.filter((b) => magnitude <= b.maxMagnitude);
  return covering.length === 0
    ? null
    : covering.reduce((a, b) => {
      if (b.maxMagnitude !== a.maxMagnitude) return b.maxMagnitude < a.maxMagnitude ? b : a;
      return rankOf(b) < rankOf(a) ? b : a;
    });
}

// [LAW:effects-at-boundaries] Pure. The churn-equivalent effort magnitude of a change: its raw churn
// plus a per-file spread surcharge, scaled down when the change touches no source. Deterministic and
// pre-spend — the same Difficulty value always yields the same magnitude. [LAW:dataflow-not-control-flow]
// the source discount is a VALUE multiplier chosen from the signal, never a branch that skips a term.
function effortMagnitude({ churn, kinds }) {
  const spread = kinds.source + kinds.tests + kinds.docs;
  const sourceFactor = kinds.source > 0 ? 1 : NONSOURCE_DISCOUNT;
  return (churn + SPREAD_WEIGHT * spread) * sourceFactor;
}

// [LAW:effects-at-boundaries] Pure. Propose the EffortProfile candidate set for a change of this
// difficulty, given the user's configured `topProfile` (the roundCap ceiling the proposal may never
// exceed). [LAW:composability] It asks only for the difficulty value and the ceiling, and returns a
// candidate set chooseProfile can rank in any order — difficulty proposes, budget (or the no-budget
// identity) caps. The set is the CROSS PRODUCT of two independent bands over the same magnitude:
//
//   roundCap  — LOWERS for easy changes. The banded cap is adopted ONLY when genuinely cheaper than the
//               user's configured cap (compared in effectiveRounds space so the 0="unlimited" sentinel
//               ranks above every finite cap — an unlimited ceiling is lowered to a finite band for an
//               easy change, a small finite user cap is never raised toward a larger band). The settled
//               ceiling feeds the SAME de-rate ladder the budget path uses (defaultBudgetCandidates).
//   reasoningTier — RAISES for hard changes. The banded tier is the proposed CEILING raise (null = none).
//               [LAW:one-source-of-truth] the profile carries only the raise, NOT an absolute tier: the
//               config's own baseline is unknown here (difficultyCandidates runs BEFORE the chain is
//               built) and is reconciled per-config via maxTier at the fold. So each roundCap rung is
//               offered at both the baseline (null) and the proposed raise, and budget — pricing the
//               raise via estimatedCostUsd — picks the affordable best across the whole product.
//
// [LAW:dataflow-not-control-flow] both axes settle to a VALUE (a null band = "no change"), so an easy or
// moderate change proposes reasoningTier=null on every rung → the set collapses to the .2 roundCap ladder
// with a null tier field (byte-identical spend). Only a substantial change adds the raised rungs.
function difficultyCandidates(difficulty, topProfile) {
  const magnitude = effortMagnitude(difficulty);

  const roundBand = selectBand(DIFFICULTY_BANDS, magnitude);
  const proposedCap = roundBand ? roundBand.roundCap : topProfile.roundCap;
  const ceilingCap = effectiveRounds(proposedCap) < effectiveRounds(topProfile.roundCap)
    ? proposedCap
    : topProfile.roundCap;
  const roundRungs = defaultBudgetCandidates({ ...topProfile, roundCap: ceilingCap });

  const reasonBand = selectBand(DIFFICULTY_REASONING_BANDS, magnitude, (b) => TIER_RANK[b.tier] ?? -1);
  const proposedTier = reasonBand ? reasonBand.tier : null;
  // [LAW:dataflow-not-control-flow] the reasoning rungs are the baseline (null) plus the proposed raise —
  // a two-value set that collapses to just [null] when nothing is raised, keeping the easy path identical.
  const reasonRungs = proposedTier === null ? [null] : [null, proposedTier];

  return roundRungs.flatMap((p) => reasonRungs.map((reasoningTier) => ({ ...p, reasoningTier })));
}

// [LAW:no-silent-failure] Parse the DIFFICULTY_SCALING action input at the run boundary. Unset/empty is
// the OFF state — the value false — NOT an error: difficulty scaling is opt-in and its absence is today's
// default path (byte-identical default-profile run, no new mode [LAW:no-mode-explosion], mirroring
// parseDailyBudgetUsd's off state). A present-but-unrecognized value is a config typo that reds the run
// loud, never a silent fall-back to off that would leave a consumer believing the feature is on.
function parseDifficultyScaling(raw) {
  const s = (raw || '').trim().toLowerCase();
  if (s === '' || s === 'false') return false;
  if (s === 'true') return true;
  throw new Error(
    `Invalid DIFFICULTY_SCALING ${JSON.stringify(raw)}: expected 'true' or 'false' `
    + '(unset or false = difficulty scaling off).',
  );
}

module.exports = {
  SPREAD_WEIGHT,
  NONSOURCE_DISCOUNT,
  DIFFICULTY_BANDS,
  DIFFICULTY_REASONING_BANDS,
  selectBand,
  effortMagnitude,
  difficultyCandidates,
  parseDifficultyScaling,
};
