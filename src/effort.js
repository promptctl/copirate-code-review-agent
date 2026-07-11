'use strict';

// [FRAMING:parts-and-seams] EffortProfile is the single value answering "how much effort to spend on
// THIS review". Today the levers that set a review's cost are scattered and independently owned —
// scope concurrency was a module constant in multiscope.js, reasoning is a per-config field resolved
// at each adapter, the round cap and diff budget come from action inputs, model tier from the failover
// chain. This module is the ONE owner of the effort representation, so the difficulty (propose) and
// budget (cap) epics constrain a single value here instead of reaching into every knob independently.
// [LAW:single-enforcer] [LAW:no-mode-explosion]
//
// The type carries only the axes it TRULY governs today. [LAW:types-are-the-program] a field that
// nothing derives from would be a false theorem — a knob the profile claims to own while its real
// source is still an input or a per-config value elsewhere. So the profile owns `scopeConcurrency`
// now (its consumer, the worker pool, reads it here), and it GROWS a field as each remaining knob's
// consumer is migrated off its current source: `roundCap` (today the MAX_REVIEW_ROUNDS input),
// `readBudget` (today MAX_DIFF_CHARS), `reasoningTier`/`modelTier` (today per-config on the chain).
// Adding a field to a well-formed producer is cheap [LAW:carrying-cost]; adding it before its
// consumer exists is a lie. The reasoning AXIS lives here already as a resolver (below) — the
// vocabulary and per-engine clamping the difficulty/budget epics will feed a profile field through —
// even though no profile field sources it yet.

// [LAW:one-source-of-truth] The default scope-worker concurrency. Quality is identical at any
// concurrency; this only trades runner load for wall time. It lived as DEFAULT_SCOPE_CONCURRENCY in
// multiscope.js; it is the profile's value now, and the worker pool reads it FROM the profile.
const DEFAULT_SCOPE_CONCURRENCY = 4;

// [LAW:dataflow-not-control-flow] The abstract reasoning-tier ladder, low→high, keyed to an ordinal
// RANK. It is the union of every engine's declared reasoning-effort vocabulary: claude-code exposes
// low..max, codex minimal..xhigh, opencode none. `xhigh` (codex's ceiling) and `max` (claude-code's
// ceiling) are the SAME rung — each engine's maximum — so both rank 4; that is what makes clamping a
// tier to an engine that names its ceiling differently resolve top→top instead of dropping a rung.
const TIER_RANK = { minimal: 0, low: 1, medium: 2, high: 3, xhigh: 4, max: 4 };

// The single representation of review effort. Produced at one seam (a default in simple mode,
// overridable via the config file later) and consumed uniformly by the engine.
// @typedef {{ scopeConcurrency: number }} EffortProfile

// [LAW:effects-at-boundaries] Pure. The default profile — its values ARE today's behavior, so a
// default-profile run is byte-identical to the pre-profile engine.
function defaultEffortProfile() {
  return { scopeConcurrency: DEFAULT_SCOPE_CONCURRENCY };
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
  DEFAULT_SCOPE_CONCURRENCY,
  TIER_RANK,
  defaultEffortProfile,
  resolveReasoningTier,
};
