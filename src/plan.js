'use strict';
// [LAW:one-way-deps] plan.js depends on review.js, never the reverse: review.js owns what a SCOPE is
// (parseScopeValue) and knows nothing about the record a pass writes around one. review.js has an empty
// require graph, so this edge points downhill and closes no loop.
const { parseScopeValue } = require('./review');

// The pass's PLAN — the partition a review actually ran, as an owned value.
//
// [LAW:one-source-of-truth] The plan is the STRUCTURE of every review: how many scopes the change
// splits into, which files land in each, and the shared context every worker is shown. That
// decision was previously recoverable only by parsing worker transcripts — schedule.json records
// scopeCount and the per-spawn scope NAMES, which is the plan's shadow, not the plan. A value with
// no authoritative representation cannot be inspected, pinned, replayed, or optimized, and while an
// LLM scout decided it, on a frozen case it re-rolled from 1 to 5 scopes across runs with a 26-point
// recall spread riding on it (copirate-determinism-5od). This module gives that value one home, so
// everything downstream — the pinned replay, the paired A/B, the partition — reads THIS and never
// re-parses prose.
//
// The recorded plan value:
//   { planSchema, provenance, context, scopes, scoutUsage }
// scopes is the list AS THE WORKERS RAN IT — names uniquified — each { name, focus, files, reads }, recorded
// whole rather than projected, so a scope field added later cannot be silently dropped on the way to
// disk. context is the planning text prefixed onto every worker's focus (workerFocusText); it is NOT
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
// the fact that decides what its price field may hold. 'partition' is the shipped PR producer (the
// structure computed from the changed paths, src/partition.js — no spawn); 'scout' is the repo-mode
// producer (a survey spawn, priced); 'pinned' is the replay of a plan decided elsewhere
// (copirate-determinism-5od.fku). [LAW:parse-dont-validate] provenance is required and closed,
// never optional: a plan whose origin is unknown is an absence that reads like an answer, which is
// the whole defect class this lane exists to close.
const PLAN_PROVENANCE_PRICED = { partition: false, scout: true, pinned: false };
const PLAN_PROVENANCES = Object.keys(PLAN_PROVENANCE_PRICED);

// [LAW:one-source-of-truth] The field set the record carries, as ONE list: the mint copies these
// fields and demands every one of them, so a field added here is demanded of every producer and
// asserted by the completeness test on the day it is added, with no second hand-kept list to update.
// Same discipline effortAxes() applies to the effort profile's axes (src/effort.js).
const PLAN_FIELDS = ['provenance', 'context', 'scopes', 'scoutUsage'];

// [LAW:parse-dont-validate] The ONE mint of a plan record, and the checkpoint between a live pass and
// a durable artifact: a plan exists only by passing through here, so every reader downstream reads
// the stamp instead of re-checking the shape. [LAW:single-enforcer] the scope INTERIORS are not
// re-checked — every scope was already stamped single-line by parseScopeValue (src/review.js), at the
// collector boundary for a scout's and at the partition for a computed one — so a second papers check
// here would be a rival definition of what a scope is.
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

// [LAW:parse-dont-validate] The READER side of the mint — the one crossing a plan makes coming BACK
// from disk, and the checkpoint that makes `--plan` possible. What goes in is bytes somebody handed us
// (a recorded plan.json, a hand-edited one, a plan a future partitioner synthesised); what comes out is
// a PlanRecord, which is the same stamped value a live pass mints, because it is minted by the same
// function. Nothing downstream re-checks a plan's shape, exactly as nothing re-checks a scouted one.
// [LAW:effects-at-boundaries] Pure: it takes the TEXT and a label naming where the text came from, so
// the caller owns the read and every failure below can say which file to go look at.
function parsePlanRecord(raw, source) {
  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${source} is not valid JSON: ${e.message}`);
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error(`${source} is not a plan record object (got ${JSON.stringify(json)}).`);
  }
  // [LAW:no-silent-failure] The stamp is checked BEFORE the fields, and an unrecognised one is fatal
  // rather than back-filled — the deliberate difference from EFFORT_SCHEMA, restated at the only
  // boundary where it can bite. There is no era of plan.json without a version to guess a shape from,
  // so a mismatch means the file describes a partition this engine cannot faithfully reconstruct, and
  // replaying it anyway would produce a review that silently is not the one the plan names.
  if (json.planSchema !== PLAN_SCHEMA) {
    throw new Error(
      `${source} declares planSchema ${JSON.stringify(json.planSchema)}, but this engine reads ${JSON.stringify(PLAN_SCHEMA)}. ` +
      'A plan has no back-fill: refusing rather than replaying a shape this engine cannot reconstruct.',
    );
  }
  // [LAW:one-source-of-truth] The fields are lifted BY PLAN_FIELDS, so a field added to the record is
  // read off disk on the same day it is demanded of every producer — the reader can never be the half
  // that forgot. Unknown keys in the file are dropped by the same act: the mint's output is the record.
  return planRecord({
    ...Object.fromEntries(PLAN_FIELDS.map(field => [field, json[field]])),
    scopes: parseScopeList(json.scopes, source),
  });
}

// [LAW:single-enforcer] Scopes off disk never crossed the collector boundary, so for THIS producer this
// is that boundary — the same parseScopeValue, not a second idea of what a scope is. It matters at the
// prompt: a scope's name and focus are model-authored text that lands in a worker's CONCENTRATE block,
// and an unflattened multi-line one puts steerable text at column 0, where a continuation line reads as
// an instruction. planRecord owns "non-empty"; this owns "is a list at all", because it must map over one.
// [LAW:no-silent-failure] The scope's own error names the field and the index; the source is prefixed
// here so an operator holding a directory of plans learns WHICH file to open, not merely that one broke.
function parseScopeList(scopes, source) {
  if (!Array.isArray(scopes)) {
    throw new Error(`${source}: 'scopes' must be the list of scopes the plan partitions the change into (got ${JSON.stringify(scopes)}).`);
  }
  return scopes.map((scope, index) => {
    try {
      return parseScopeValue(scope, index);
    } catch (e) {
      throw new Error(`${source}: ${e.message}`);
    }
  });
}

module.exports = { PLAN_SCHEMA, PLAN_PROVENANCES, PLAN_FIELDS, planRecord, parsePlanRecord };
