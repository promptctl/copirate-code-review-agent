'use strict';

// The pass's PLAN — the partition a review actually ran, as an owned value.
//
// [LAW:one-source-of-truth] The scout decides the STRUCTURE of every review: how many scopes the
// change splits into, which files land in each, and the shared context every worker is shown. That
// decision was previously recoverable only by parsing worker transcripts — schedule.json records
// scopeCount and the per-spawn scope NAMES, which is the plan's shadow, not the plan. A value with
// no authoritative representation cannot be inspected, pinned, replayed, or optimized, and on a
// frozen case this one re-rolls from 1 to 5 scopes across runs with a 26-point recall spread riding
// on it (copirate-determinism-5od). This module gives that value one home, so everything downstream
// — the pinned replay, the paired A/B, any future partitioner — reads THIS and never re-parses prose.
//
// The recorded plan value:
//   { planSchema, provenance, context, scopes, scoutUsage }
// scopes is the post-planScopes list AS THE WORKERS RAN IT — withheld paths stripped, unassigned
// paths swept into the catch-all, names uniquified — each { name, focus, files }, recorded whole
// rather than projected, so a scope field added later cannot be silently dropped on the way to disk.
// context is the scout summary prefixed onto every worker's focus (workerFocusText); it is NOT
// byte-exact recoverable from summary.txt, where composeSummary embeds it inside composed prose, so
// a plan without it could not reconstruct the prompts it claims to describe. [FRAMING:representation]

// [LAW:one-source-of-truth] The version says which field set this record was written under, and it
// is emitted by the same mint that emits the fields — halves written separately are exactly what
// drifts, and a record stamped with a version it does not match is worse than an unstamped one.
// Unlike src/effort.js there is deliberately NO back-fill table: EFFORT_SCHEMA needed one because
// stored records predated the stamp, and no plan.json predates this line. A reader meeting an
// unknown or absent planSchema therefore has nothing to back-fill FROM and must fail loud rather
// than guess at a shape that never existed. [LAW:no-silent-failure]
const PLAN_SCHEMA = 'copirate-plan/v1';

// [LAW:dataflow-not-control-flow] Provenance as a TABLE from each origin's NAME to whether a scout
// spawn PRICED this plan — the vocabulary is the table's keys, so an origin can never exist without
// the fact that decides what its price field may hold. 'scout' is the shipped producer (this run
// planned its own partition); 'pinned' is the replay of a plan decided elsewhere, whose producer
// lands in copirate-determinism-5od.fku. [LAW:parse-dont-validate] provenance is required and closed,
// never optional: a plan whose origin is unknown is an absence that reads like an answer, which is
// the whole defect class this lane exists to close.
const PLAN_PROVENANCE_PRICED = { scout: true, pinned: false };
const PLAN_PROVENANCES = Object.keys(PLAN_PROVENANCE_PRICED);

// [LAW:one-source-of-truth] The field set the record carries, as ONE list: the mint copies these
// fields and demands every one of them, so a field added here is demanded of every producer and
// asserted by the completeness test on the day it is added, with no second hand-kept list to update.
// Same discipline effortAxes() applies to the effort profile's axes (src/effort.js).
const PLAN_FIELDS = ['provenance', 'context', 'scopes', 'scoutUsage'];

// [LAW:parse-dont-validate] The ONE mint of a plan record, and the checkpoint between a live pass and
// a durable artifact: a plan exists only by passing through here, so every reader downstream reads
// the stamp instead of re-checking the shape. [LAW:single-enforcer] the scope INTERIORS are not
// re-checked — every model-authored scope was already stamped single-line by parseScopeValue
// (src/review.js) at the collector boundary, and the catch-all is host-authored — so a second papers
// check here would be a rival definition of what a scope is.
// [LAW:effects-at-boundaries] Pure: the caller does the writing.
function planRecord(fields) {
  const record = { planSchema: PLAN_SCHEMA };
  for (const field of PLAN_FIELDS) {
    // [LAW:no-silent-failure] Every field is a fact the pass observed; an absent one is a broken
    // producer and fails HERE, named, rather than as a `null` a future reader cannot tell from a
    // pass that genuinely recorded nothing.
    if (fields[field] === undefined) {
      throw new Error(`planRecord: ${field} is undefined — a plan cannot record a decision the pass never made.`);
    }
    record[field] = fields[field];
  }
  if (!Object.prototype.hasOwnProperty.call(PLAN_PROVENANCE_PRICED, record.provenance)) {
    throw new Error(
      `planRecord: unknown provenance ${JSON.stringify(record.provenance)}. Known provenances: ${PLAN_PROVENANCES.join(', ')}.`,
    );
  }
  if (typeof record.context !== 'string') {
    throw new Error(`planRecord: context must be the string every worker was shown (got ${JSON.stringify(record.context)})`);
  }
  if (!Array.isArray(record.scopes) || record.scopes.length === 0) {
    throw new Error('planRecord: scopes must be the non-empty list of scopes the workers ran — a pass with no scope has no plan to record');
  }
  // [LAW:types-are-the-program] `null` means two different things across the vocabulary — under
  // 'scout' it is the engine reporting no usage (the same recorded absence spanMs renders
  // 'unclocked'), under 'pinned' it is that no scout ran at all — and `provenance` is the
  // discriminator that pulls them apart. The table decides which reading is legal, so an unpriced
  // origin carrying a price (a pinned plan billed for a spawn that never happened) is unrepresentable.
  if (!PLAN_PROVENANCE_PRICED[record.provenance] && record.scoutUsage !== null) {
    throw new Error(
      `planRecord: provenance '${record.provenance}' plans no scout spawn, so scoutUsage must be null (got ${JSON.stringify(record.scoutUsage)})`,
    );
  }
  return record;
}

module.exports = { PLAN_SCHEMA, PLAN_PROVENANCES, PLAN_FIELDS, planRecord };
