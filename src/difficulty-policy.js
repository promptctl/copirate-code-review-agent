'use strict';

const { effectiveRounds, defaultBudgetCandidates } = require('./budget');

// [FRAMING:parts-and-seams] The difficulty POLICY: the part that turns the pure, pre-spend difficulty
// SIGNALS (assessDifficulty in difficulty.js — churn, spread, kind breakdown) into an EffortProfile
// candidate ladder for chooseProfile. It is the deliberate counterpart to difficulty.js: that module
// MEASURES and carries no effort knowledge; this module DECIDES and carries no measurement. [LAW:decomposition]
// The two epics compose at the run() seam — difficulty PROPOSES the ceiling here, budget CAPS within it
// via chooseProfile — so this module depends only on budget.js's ladder machinery
// (defaultBudgetCandidates, effectiveRounds) and the Difficulty value shape, never the reverse. [LAW:one-way-deps]
//
// SCOPE, bounded by today's type: roundCap is the ONLY cost-bearing axis EffortProfile carries, and the
// candidates must never exceed the user's configured ceiling — so this slice can only LOWER the ceiling
// for easy changes (cheap reviews for trivial diffs). RAISING effort above the ceiling for hard changes
// is impossible until a new cost-bearing axis lands (slice zai-difficulty-0ea.3); a higher roundCap the
// profile can't price would be a no-op, so it is not faked here. [LAW:types-are-the-program]

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

// [LAW:effects-at-boundaries] Pure. [LAW:types-are-the-program] The band a magnitude falls in: the one
// with the SMALLEST maxMagnitude that still covers it, selected regardless of array order — so the band
// table is an unordered SET, not a list carrying a fragile ascending-order invariant a reorder could
// silently break. `null` when no band covers the magnitude (it exceeds every band → propose no lowering).
// The tie-break is EXPLICIT: on equal maxMagnitude the smaller roundCap (the cheaper rung) wins, so the
// result is deterministic and order-independent even for a degenerate table with duplicate maxMagnitude —
// the reduce never silently keeps whichever the array order happened to visit first.
function selectBand(bands, magnitude) {
  const covering = bands.filter((b) => magnitude <= b.maxMagnitude);
  return covering.length === 0
    ? null
    : covering.reduce((a, b) => {
      if (b.maxMagnitude !== a.maxMagnitude) return b.maxMagnitude < a.maxMagnitude ? b : a;
      return b.roundCap < a.roundCap ? b : a;
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

// [LAW:effects-at-boundaries] Pure. Propose the EffortProfile candidate ladder for a change of this
// difficulty, given the user's configured `topProfile` (the ceiling the proposal may never exceed).
// [LAW:composability] It asks only for the difficulty value and the ceiling, and returns a candidate set
// chooseProfile can rank in any order — difficulty proposes, budget (or the no-budget identity) caps.
//
// The proposal only ever LOWERS the ceiling: the banded roundCap is adopted ONLY when it is genuinely
// cheaper than the user's configured cap (compared in effectiveRounds space so the 0="unlimited"
// sentinel ranks above every finite cap — an unlimited ceiling is correctly lowered to a finite band for
// an easy change, and a small finite user cap is never raised toward a larger band). The settled ceiling
// then feeds the SAME de-rate ladder the budget path uses (defaultBudgetCandidates), so budget's cap
// still applies cleanly on top. [LAW:one-source-of-truth] one ladder machinery, two ceilings.
function difficultyCandidates(difficulty, topProfile) {
  const magnitude = effortMagnitude(difficulty);
  const band = selectBand(DIFFICULTY_BANDS, magnitude);
  const proposed = band ? band.roundCap : topProfile.roundCap;
  const ceiling = effectiveRounds(proposed) < effectiveRounds(topProfile.roundCap)
    ? proposed
    : topProfile.roundCap;
  return defaultBudgetCandidates({ ...topProfile, roundCap: ceiling });
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
  selectBand,
  effortMagnitude,
  difficultyCandidates,
  parseDifficultyScaling,
};
