'use strict';

// [FRAMING:parts-and-seams] EffortProfile is the single value answering "how much effort to spend on
// THIS review". Today the levers that set a review's cost are scattered and independently owned —
// reasoning is a per-config field resolved at each adapter, the round cap and diff budget come from
// action inputs, model tier from the failover chain. This module is the ONE owner of the effort
// representation, so the difficulty (propose) and budget (cap) epics constrain a single value here
// instead of reaching into every knob independently. [LAW:single-enforcer] [LAW:no-mode-explosion]
//
// The type carries only the axes it TRULY governs today. [LAW:types-are-the-program] a field that
// nothing derives from would be a false theorem — a knob the profile claims to own while its real
// source is still an input or a per-config value elsewhere. So the profile owns `roundCap` (its
// consumer, the pre-spawn round gate in run.js, reads it here), `sweepCap` (its consumer, the
// convergence chain in runMultiScopePass, reads it here), `reasoningTier` (its consumer is the reasoning fold at the
// runMultiScope seam — the one place the chain and the effort profile meet — which reconciles the
// profile's proposed tier with each config's own reasoning via `maxTier` before the adapter clamps it
// to the engine's range), and `readSet` (its consumer is the read-set projection at runScopeWorker,
// which decides WHICH files each worker opens in full). It GROWS a field as each remaining knob's
// consumer is migrated off its current source: `readBudget` (today MAX_DIFF_CHARS), `modelTier` (today
// per-config on the chain).
// Adding a field to a well-formed producer is cheap [LAW:carrying-cost]; adding it before its consumer
// exists is a lie — so `reasoningTier` lands together with its fold consumer (multiscope.js) and its
// price (budget.js estimatedCostUsd), never as an ungoverned placeholder.
//
// [LAW:one-source-of-truth] `readSet` and the still-unlanded `readBudget` are DIFFERENT axes and the
// names invite conflating them. `readBudget` (MAX_DIFF_CHARS) bounds how much DIFF is rendered into the
// prompt — the same text for every worker. `readSet` decides which changed files a worker OPENS in full
// once it has that diff, which is per-WORKER and is the axis a multi-scope plan can split. Both are read
// cost; only one is partitionable, which is why splitting was a lever at all.
//
// [LAW:one-source-of-truth] `reasoningTier` on the profile is the difficulty-PROPOSED RAISE, NOT a
// review's absolute reasoning tier. The absolute per-config baseline stays `config.reasoning` (each
// config in the failover chain can name its own), because the profile is one value per REVIEW while
// reasoning is genuinely per-CONFIG — a single profile field cannot faithfully represent a chain whose
// configs disagree. So the profile carries only the raise, defaulting to `null` = "propose no raise;
// the config's own tier stands", and the fold resolves the effective tier = maxTier(config baseline,
// proposed raise) PER CONFIG. This makes difficulty a monotonic FLOOR (it can lift an under-specified
// config, never lower an explicit one) and keeps a default-profile run byte-identical.
//
// `roundCap` is the profile's first COST-BEARING axis. Measured cost is cleanly ADDITIVE across
// rounds, so the cap is a clean linear multiplier — the budget epic's most trustworthy estimate axis.
// The value's meaning is unchanged from MAX_REVIEW_ROUNDS: 0 = the "unlimited" sentinel.
//
// Lane count is deliberately NOT an axis. How many scope workers run at once is cost-neutral —
// parallelism trades runner load for wall time, never spend — so it was never effort; the profile
// carried it as `scopeConcurrency = 4` for a while and that misfiling is what made every ready scope
// queue behind a constant (zai-timing-ptp). The count now derives from the plan itself, under a
// machine-capacity ceiling owned by the pool (laneCeilingFromMemory, src/multiscope.js).

// [LAW:one-source-of-truth] The default convergence-sweep bound: after a scope's initial review, up
// to this many further sweeps re-review that scope hunting only for findings NOT yet recorded,
// stopping early when a sweep adds nothing new (zai-recall-upr.2). The push-round dribble this
// replaces converged in ~5-8 rounds WITHOUT showing each round the prior findings; a sweep IS shown
// them, so convergence is expected in fewer passes — 2 bounds the worst case at 3 spawns per scope
// per round. 0 = no sweeps, the pre-convergence single-pass behavior. Unlike roundCap there is NO
// "unlimited" sentinel: termination inside one action run must be guaranteed by the bound, so the cap
// is always finite. [LAW:types-are-the-program]
const DEFAULT_SWEEP_CAP = 2;

// [LAW:dataflow-not-control-flow] The read-set axis, as a table from each arm's NAME to the projection
// that produces the files a worker opens in full. The vocabulary is the table's KEYS (READ_SETS below),
// so a name can never exist without the meaning it selects — the pair that would drift if the two were
// written separately. [LAW:one-source-of-truth]
//   'assigned' — the worker reads only the scope it was assigned. N workers cost ~1× the read of the
//                changed set (split), not N× (duplicated): the shipped cost cut.
//   'changed'  — the worker reads the whole changed set, the pre-split behavior. It projects to the
//                EMPTY list because that is already prompt.js's value for "read every changed file in
//                full" (buildReviewInput's scopeFiles) — this axis picks which value flows to a seam
//                that was always value-driven, and adds no second prompt path. [LAW:composability]
// The projection takes the scope's assigned files and returns the read set, so the two arms are one
// signature — never a caller-side branch on the arm. It is deliberately NOT keyed to scope IDENTITY:
// `scope.files` remains the coverage record either way (planScopes' set-membership check, and the
// exclusion strip in withoutWithheldFiles), so an arm changes what a worker READS and nothing about
// what the plan CLAIMS to cover. Those are two facts, and only one of them is effort.
const READ_SET_PROJECTION = {
  assigned: (scopeFiles) => scopeFiles,
  changed: () => [],
};

// [LAW:one-source-of-truth] The arm vocabulary, derived from the projection table rather than listed a
// second time: the CLIs validate against this and the error messages name it, so a new arm is one entry
// in one table. [LAW:types-are-the-program]
const READ_SETS = Object.keys(READ_SET_PROJECTION);

// [LAW:one-source-of-truth] The default read set: the behavior the engine ships (each worker reads its
// own scope). Unlike a cap there is no numeric "off" — the axis is a closed two-value vocabulary, so the
// non-default arm is named, not spelled as a magic number. [LAW:no-mode-explosion] this is an A/B AXIS,
// not a user knob: no action input sets it, and its non-default arm exists to be MEASURED
// (copirate-measurement-2mg.2) — the shipped lever was priced on cost evidence with no recall verdict.
const DEFAULT_READ_SET = 'assigned';

// [LAW:dataflow-not-control-flow] The abstract reasoning-tier ladder, low→high, keyed to an ordinal
// RANK. It is the union of every engine's declared reasoning-effort vocabulary: claude-code exposes
// low..max, codex minimal..xhigh, opencode none. `xhigh` (codex's ceiling) and `max` (claude-code's
// ceiling) are the SAME rung — each engine's maximum — so both rank 4; that is what makes clamping a
// tier to an engine that names its ceiling differently resolve top→top instead of dropping a rung.
const TIER_RANK = { minimal: 0, low: 1, medium: 2, high: 3, xhigh: 4, max: 4 };

// The single representation of review effort. Produced at one seam (a default in simple mode,
// overridable via the config file later) and consumed uniformly by the engine.
// @typedef {{ roundCap: number, sweepCap: number, reasoningTier: (string|null), readSet: string }} EffortProfile

// [LAW:effects-at-boundaries] Pure. The default profile — its values ARE the engine's default
// behavior (which, since zai-recall-upr.2, includes convergence sweeps: sweepCap > 0). An OPTIONS
// object (not positional args) because the profile GROWS axes: each future knob is a new named key,
// so no call site is re-threaded when the shape widens. [LAW:carrying-cost]
//
// `roundCap` is SOURCED, not owned: its production default (action.yml's MAX_REVIEW_ROUNDS = "5")
// lives at the action boundary and flows in through run()'s parsed input, so it is not duplicated
// here. [LAW:one-source-of-truth] The fallback is the neutral `0` = "unlimited" sentinel — the honest
// value for "no cap was decided here" (a bare call in a test or an omitted-effort default), never a
// second copy of the production default.
//
// `reasoningTier` defaults to `null` = "propose no raise". It is the difficulty-proposed RAISE, not an
// absolute tier (see the header): a null profile leaves each config's own `config.reasoning` untouched
// at the fold, so a default profile is byte-identical. Only difficultyCandidates ever sets it non-null.
// `sweepCap` is a further cost-bearing axis (zai-recall-upr.2, after roundCap and reasoningTier): its consumer is the
// convergence-sweep loop in runMultiScopePass, its price the sweep multiplicand in budget.js's
// estimatedCostUsd — both land together with the axis, per this module's header. It is OWNED here
// (DEFAULT_SWEEP_CAP), not sourced from an action input: the sweep bound is engine policy, not a
// consumer knob. [LAW:no-mode-explosion]
// `readSet` is the profile's read-partitioning axis (copirate-measurement-2mg.2): its consumer is the
// projection at runScopeWorker, its price the read multiplicand in budget.js's estimatedCostUsd — both
// land with the axis, per this module's header. It is OWNED here (DEFAULT_READ_SET), not sourced from an
// action input: how a plan splits its reads is engine policy, not a consumer knob. [LAW:no-mode-explosion]
function defaultEffortProfile({ roundCap = 0, sweepCap = DEFAULT_SWEEP_CAP, reasoningTier = null, readSet = DEFAULT_READ_SET } = {}) {
  return { roundCap, sweepCap, reasoningTier, readSet };
}

// [LAW:parse-dont-validate] Resolve the arm NAME to the projection it selects — the axis's one checkpoint,
// and the only place its vocabulary is checked. It returns something that could not exist before the check
// (the projection itself), so a caller holding one holds a proven arm: there is nothing left inland to
// re-check, and no way to reach a worker with a name the table has no meaning for. [LAW:single-enforcer]
// Callers resolve ONCE at a pass boundary rather than per worker, which is what puts the refusal BEFORE the
// scout spawn instead of after it — a malformed arm costs nothing rather than a round of spend.
// [LAW:no-silent-failure] an unknown arm is a caller bug, not something to coalesce to the default:
// silently reading the shipped arm would make an A/B report the DEFAULT behavior under the other arm's
// name — a measurement that lies rather than fails. Throw, naming the known arms.
function readSetProjection(readSet) {
  if (!Object.prototype.hasOwnProperty.call(READ_SET_PROJECTION, readSet)) {
    throw new Error(
      `Unknown read set ${JSON.stringify(readSet)}. Known read sets: ${READ_SETS.join(', ')}.`,
    );
  }
  return READ_SET_PROJECTION[readSet];
}

// [LAW:effects-at-boundaries] Pure. The higher of two abstract reasoning tiers by TIER_RANK — the
// per-config FLOOR reconciliation between a config's own `reasoning` and the profile's proposed raise.
// [LAW:dataflow-not-control-flow] every branch is over VALUES: a `null`/`undefined` operand contributes
// nothing (both null → null, the byte-identical no-raise case), and on equal rank the FIRST operand
// wins so the caller can pass the config's own (already engine-valid) tier first and keep it on a tie
// (e.g. an engine that names its ceiling `max` is not swapped for the abstract `xhigh` of the same rank).
// [LAW:no-silent-failure] an unknown tier string is a caller bug (a proposal outside the vocabulary),
// not a value to coalesce — throw naming the known tiers rather than silently dropping the higher rung.
function maxTier(a, b) {
  for (const t of [a, b]) {
    if (t !== null && t !== undefined && !Object.prototype.hasOwnProperty.call(TIER_RANK, t)) {
      throw new Error(
        `Unknown reasoning tier ${JSON.stringify(t)}. Known tiers: ${Object.keys(TIER_RANK).join(', ')}.`,
      );
    }
  }
  if (a === null || a === undefined) return b ?? null;
  if (b === null || b === undefined) return a;
  return TIER_RANK[b] > TIER_RANK[a] ? b : a;
}

// Resolve an ABSTRACT reasoning tier to the concrete value a specific engine supports, given that
// engine's declared reasoning-effort range (the adapter's `capabilities.reasoningEfforts`). This is
// the per-engine resolution the epic names: the profile speaks one abstract tier; each engine offers
// a different range, so the tier clamps to what the engine actually supports.
// [LAW:dataflow-not-control-flow] Every branch is over VALUES, not modes:
//   - `null`/`undefined` tier  → null: "leave the engine's own default" (today's unset behavior).
//   - empty engine range       → null: the engine exposes no reasoning axis (opencode), so it is
//                                 ignored — not an error.
//   - tier the engine supports → that exact tier (identity; the common case today).
//   - a supported-elsewhere tier → the nearest rung the engine DOES offer, ties broken toward the
//                                   LOWER (cheaper) rung, since this substrate feeds a cost-bounding
//                                   budget epic and rounding effort down is the safe default.
// [LAW:no-silent-failure] an unknown tier string is a caller bug, not a value to clamp — throw,
// naming the known tiers, rather than silently picking a rung.
function resolveReasoningTier(tier, engineEfforts) {
  // [LAW:no-silent-failure] Validate BOTH inputs against the one tier vocabulary, symmetrically. An
  // engine range carrying a rung TIER_RANK doesn't know is a programmer error — an adapter added an
  // effort level without teaching the ladder. Left unchecked it poisons the clamp below (a NaN
  // distance never wins `dist < bestDist`, so the rung is skipped and the axis silently drops to
  // null). Catch it loudly here so the clamp loop can trust every `TIER_RANK[e]`. This runs on every
  // call, including a null tier, so a malformed adapter range reds the run rather than degrading it.
  for (const e of engineEfforts) {
    if (!Object.prototype.hasOwnProperty.call(TIER_RANK, e)) {
      throw new Error(
        `Engine declares reasoning effort ${JSON.stringify(e)} unknown to the tier ladder ` +
        `(range: ${engineEfforts.join(', ')}). Known tiers: ${Object.keys(TIER_RANK).join(', ')}.`,
      );
    }
  }
  if (tier === null || tier === undefined) return null;
  if (!Object.prototype.hasOwnProperty.call(TIER_RANK, tier)) {
    throw new Error(
      `Unknown reasoning tier ${JSON.stringify(tier)}. Known tiers: ${Object.keys(TIER_RANK).join(', ')}.`,
    );
  }
  if (engineEfforts.length === 0) return null;
  if (engineEfforts.includes(tier)) return tier;

  const target = TIER_RANK[tier];
  let best = null;
  let bestDist = Infinity;
  for (const e of engineEfforts) {
    const dist = Math.abs(TIER_RANK[e] - target);
    // Strictly-nearer wins; on a tie keep the LOWER-ranked (cheaper) rung already chosen, since the
    // loop visits the engine's range low→high as it is declared.
    if (dist < bestDist) {
      best = e;
      bestDist = dist;
    }
  }
  return best;
}

module.exports = {
  DEFAULT_SWEEP_CAP,
  DEFAULT_READ_SET,
  READ_SETS,
  TIER_RANK,
  defaultEffortProfile,
  resolveReasoningTier,
  maxTier,
  readSetProjection,
};
