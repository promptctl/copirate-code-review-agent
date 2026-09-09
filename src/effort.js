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
//                full" (buildReviewInput's readFiles) — this axis picks which value flows to a seam
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

// [LAW:one-source-of-truth] The version of the RECORDED profile, owned next to the type it versions —
// the discipline eval/baseline.js already applies to the baseline file (copirate-eval-baseline/v2),
// carried one layer down to the run record where it was missing. It names WHICH AXIS SET the profile
// above had when a record was written, which is what lets a stored run still be classified years later:
// the record states the theorem that was true at its writing, so a reader never has to guess whether an
// absent axis was a choice or an era. Bump it whenever defaultEffortProfile's axes change, and give the
// outgoing version its row in the back-fill below — the bump and the row are one edit, never two.
const EFFORT_SCHEMA = 'copirate-effort/v1';

// [LAW:parse-dont-validate] A record carrying no version is NOT versionless: it was written in the era
// before the version existed, and that era had exactly one axis set. So absence is a VALUE here — it gets
// a name and a row of its own rather than a fallthrough. This is load-bearing, not tidiness: every run on
// disk today predates the field, so a table keyed only on versions the records actually carry would
// classify none of them, which is the entire job.
const UNVERSIONED_EFFORT_SCHEMA = 'copirate-effort/unversioned';

// [LAW:dataflow-not-control-flow] The back-fill, as a TABLE from schema version to the axes the CODE
// STRUCTURALLY HAD at that version — values, not an inference each reader re-derives at its own site.
// [LAW:single-enforcer] one rule, read through completeEffort by every comparison site, replacing the
// unanswerable "what arm did this run's missing axis run at?" with an answer this tree owns and can cite.
//   unversioned -> readSet 'assigned': scope-bounded reads shipped in bfcd889 on 2026-07-06, before every
//     stored run, and the axis did not exist to be set otherwise — the behavior was that arm as a matter
//     of code, not of guesswork. Retro-editing the stored meta.json files to add the field would falsify
//     the record; interpreting them through an owned rule is the honest form of the same knowledge.
//     [LAW:one-source-of-truth] the value is spelled out rather than written as DEFAULT_READ_SET: this
//     row is a HISTORICAL fact about code that shipped, and if the shipped default ever moves, what those
//     runs did does not move with it. Binding the two would make the past follow the present.
//   current -> {}: a record written at the current version carries every axis itself, so there is nothing
//     to supply — and an axis still missing is a DEFECT, refused loudly by completeEffort rather than
//     quietly filled.
const EFFORT_SCHEMA_BACKFILL = {
  [UNVERSIONED_EFFORT_SCHEMA]: { readSet: 'assigned' },
  [EFFORT_SCHEMA]: {},
};

// [LAW:one-source-of-truth] The axis set OF THE TYPE, read off the type itself rather than kept as a
// second list a new axis would have to remember to join. Adding a field to defaultEffortProfile widens
// this automatically, which is what turns "added an axis and forgot to record it" from a mistake anyone
// can make into one nobody can: the completeness check below is stated against this, so the new axis
// starts being demanded of every record the moment it exists.
function effortAxes() {
  return Object.keys(defaultEffortProfile());
}

// [LAW:one-source-of-truth] The recorded pair, PRODUCED TOGETHER — the profile and the version saying
// which axis set it was written under. Halves written separately are exactly what drifts, and a record
// stamped with a version it does not match is worse than one carrying no version at all, so there is one
// producer and it emits both. Spread into a record: `{ ...recordEffort(effort), case, ... }`.
// [LAW:effects-at-boundaries] Pure: the caller does the writing.
function recordEffort(profile) {
  return { effort: profile, effortSchema: EFFORT_SCHEMA };
}

// [LAW:parse-dont-validate] The reader of that pair, and the checkpoint this axis was missing: in goes a
// stored record from whatever era wrote it, out comes a COMPLETE profile — every axis of the current type
// present — so no comparison site downstream ever meets an axis-shaped void and has to decide what it
// meant. An axis is supplied only where the table names one for that record's version; an axis the table
// is silent about passes through exactly as recorded, so a value that genuinely varied is never
// overwritten by a default.
// [LAW:no-silent-failure] Two loud refusals, each naming what it saw: a version this tree has no row for
// (a record from a newer or forked schema, which cannot be interpreted and must not be guessed at), and a
// record still missing an axis after back-fill — the recorder having fallen behind the type, which is the
// very defect this function exists to make impossible to ship quietly.
function completeEffort({ effort, effortSchema }) {
  const schema = effortSchema ?? UNVERSIONED_EFFORT_SCHEMA;
  if (!Object.prototype.hasOwnProperty.call(EFFORT_SCHEMA_BACKFILL, schema)) {
    throw new Error(
      `Unknown effort schema ${JSON.stringify(schema)}. Known schemas: ${Object.keys(EFFORT_SCHEMA_BACKFILL).join(', ')}.`,
    );
  }
  const completed = { ...effort };
  for (const [axis, structural] of Object.entries(EFFORT_SCHEMA_BACKFILL[schema])) {
    // The row supplies the axis for a record that does not carry it, in either spelling absence takes on
    // the wire: a missing key, or the explicit null a re-read of an already-parsed profile carries. A
    // recorded reasoningTier of null is untouched, because no row names that axis — the table's silence
    // is what protects a real value from a back-fill.
    completed[axis] = completed[axis] ?? structural;
  }
  const missing = effortAxes().filter(axis => completed[axis] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `Effort record at schema ${schema} is missing ${missing.join(', ')}, and no back-fill row supplies ` +
      `${missing.length === 1 ? 'it' : 'them'}. A record must carry every axis of the profile: ${effortAxes().join(', ')}.`,
    );
  }
  return completed;
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
  EFFORT_SCHEMA,
  UNVERSIONED_EFFORT_SCHEMA,
  EFFORT_SCHEMA_BACKFILL,
  effortAxes,
  recordEffort,
  completeEffort,
  defaultEffortProfile,
  resolveReasoningTier,
  maxTier,
  readSetProjection,
};
