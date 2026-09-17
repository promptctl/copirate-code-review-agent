'use strict';
// THE ARM — what a run was produced BY, as a discriminated union keyed on the schema already written
// beside every effort profile on disk.
//
// A scored run belongs to an arm, and recall from two arms is not one number. While every producer was
// the copirate engine, "the arm" and "the engine's effort profile" were the same fact, so score.js read
// the profile's axes directly. A second producer — Claude Code's built-in `/code-review`, which has no
// roundCap and no sweepCap, but does have a level and a model — makes them two facts. The union is how
// they stay one comparison: every arm renders to a string, the comparison is string equality, and an arm
// this tree does not know refuses rather than averaging into another. [LAW:types-are-the-program]
//
// The discriminator is `effortSchema`, which already exists on the wire (src/effort.js) and already means
// "which shape is this profile". Inventing a second tag beside it would be two maps of one fact.
// [LAW:one-source-of-truth]
//
// [LAW:effects-at-boundaries] Module load is PURE: only src/effort.js's pure profile helpers.

const { completeEffort, EFFORT_SCHEMA_BACKFILL, UNVERSIONED_EFFORT_SCHEMA } = require('../src/effort');

// The arm of a run produced by Claude Code's built-in `/code-review` skill. Versioned on the same
// principle as `copirate-effort/*`: the record states the theorem that was true at its writing, so a
// stored run stays classifiable after the skill's own shape moves. [FRAMING:representation]
const CC_REVIEW_SCHEMA = 'claude-code-review/v1';

// The levels the skill itself accepts. A level outside this set is a typo that would otherwise run at the
// skill's fallback and be recorded as the level nobody ran. [LAW:no-silent-failure]
const CC_REVIEW_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

// [LAW:one-type-per-behavior] An arm is a PARSE and a RENDER — the two things every arm does, differing
// only in the shape they accept. Two arms are two values in this table, never two code paths at the sites
// below. [LAW:dataflow-not-control-flow]

const ENGINE_ARM = {
  // The engine's profile, complete: `completeEffort` is still the sole owner of the axis set and its
  // back-fill, reached here rather than re-implemented, so the eval and the shipped action can only ever
  // agree about what an axis means. [LAW:single-enforcer]
  parse(raw, effortSchema, label) {
    const ok = typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      && Number.isInteger(raw.roundCap) && raw.roundCap >= 0
      && Number.isInteger(raw.sweepCap) && raw.sweepCap >= 0
      && (raw.reasoningTier === null || typeof raw.reasoningTier === 'string');
    if (!ok) {
      throw new Error(
        `${label} 'effort' must be {roundCap: <int ≥0>, sweepCap: <int ≥0>, reasoningTier: <string|null>} at schema ${effortSchema}, got ${JSON.stringify(raw)}.`,
      );
    }
    return completeEffort({ effort: raw, effortSchema });
  },
  // Unchanged from the rendering score.js has always produced, so every message and every stored
  // comparison the gate machinery makes reads exactly as it did. Only reasoningTier spells its null, and
  // it spells it as a REAL value ('none' = no raise proposed), never as an absence.
  describe(effort) {
    return `roundCap=${effort.roundCap} sweepCap=${effort.sweepCap} reasoningTier=${effort.reasoningTier ?? 'none'}`;
  },
};

const CC_REVIEW_ARM = {
  // Both facts are required because both vary the review and neither is recoverable later: the level is
  // what an operator typed, the model is what actually served it — and the CLI's default model is a
  // moving target this harness does not pin, so a run that did not record it could not be reproduced or
  // compared. [LAW:no-silent-failure]
  parse(raw, effortSchema, label) {
    const ok = typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      && CC_REVIEW_LEVELS.includes(raw.level)
      && typeof raw.model === 'string' && raw.model.trim() !== '';
    if (!ok) {
      throw new Error(
        `${label} 'effort' must be {level: one of ${CC_REVIEW_LEVELS.join('|')}, model: <non-empty string>} at schema ${effortSchema}, got ${JSON.stringify(raw)}.`,
      );
    }
    return { level: raw.level, model: raw.model };
  },
  // Named by its MECHANISM, not just its values: this string is what a report calls the arm and what the
  // comparison tests for equality, and `level=high` alone would read as an engine axis to anyone holding
  // the other rendering. [LAW:one-source-of-truth] one rendering, used to compare and to name.
  describe(effort) {
    return `/code-review level=${effort.level} model=${effort.model}`;
  },
};

// [LAW:one-source-of-truth] The engine's schema versions are read OFF src/effort.js's back-fill table
// rather than listed again here — a version added there joins this union automatically, which is what
// keeps "the engine arm" from meaning one set of versions to the profile owner and another to the arm
// reader.
const ARMS = {
  ...Object.fromEntries(Object.keys(EFFORT_SCHEMA_BACKFILL).map(schema => [schema, ENGINE_ARM])),
  [CC_REVIEW_SCHEMA]: CC_REVIEW_ARM,
};

// [LAW:parse-dont-validate] Which arm a value belongs to, as ONE rule read by both the parser and the
// renderer — so a profile can never be parsed as one arm and described as another.
//
// Three spellings, because a profile reaches this module along three paths and all three are real:
//   - beside its `effortSchema` sibling, which is how meta.json writes it (src/effort.js's recordEffort);
//   - carrying the stamp this module put on it, which is how score.js's scorecard-summary.json writes it
//     back — that writer persists the PROFILE alone, so an arm not carried inside the profile would be
//     lost on every round-trip and a `/code-review` summary would re-read as an engine one;
//   - bare, as freeze-suite.js and compare.js hand `defaultEffortProfile()` straight to describeEffort.
// A bare profile is the engine's, and that is not a guess: `copirate-effort/unversioned` already MEANS
// "written in the era before the version existed", and that era had exactly one producer.
function schemaOf(effortSchema, effort) {
  return effortSchema ?? (effort && effort.effortSchema) ?? UNVERSIONED_EFFORT_SCHEMA;
}

function armFor(schema, label) {
  const arm = ARMS[schema];
  if (!arm) {
    throw new Error(
      `Unknown effort schema ${JSON.stringify(schema)} in ${label} — this tree has no arm for it. ` +
      `Known arms: ${Object.keys(ARMS).join(', ')}.`,
    );
  }
  return arm;
}

// [LAW:parse-dont-validate] The crossing from a stored record to an ARM-STAMPED profile: in goes a
// meta.json or a scorecard-summary.json as its era wrote it, out comes a profile every reader downstream
// can describe without re-deriving which shape it is. The stamp is DERIVED from the schema on every
// parse and never trusted from the wire, so it cannot drift from the fact it names.
//
// [LAW:no-silent-failure] A wholly absent effort stays a typed absence (null) — unlike a missing AXIS,
// which the schema's back-fill resolves, a record with no profile at all names no version and fixes no
// value, so what it ran at is genuinely unknown and guessing it is how two arms get averaged into one
// number. That absence has ONE meaning and two spellings on the wire, and this parser reads both: a
// missing key (a legacy meta.json) and an explicit null (what score.js's aggregateRuns itself writes for
// such a run, since JSON has no `undefined`). A reader that took only the first could not read back what
// its own writer emits. Anything else is a malformed record, refused.
function parseEffort(record, label) {
  const raw = record.effort;
  if (raw === undefined || raw === null) return null;
  const schema = schemaOf(record.effortSchema, raw);
  return { ...armFor(schema, label).parse(raw, schema, label), effortSchema: schema };
}

// [LAW:one-source-of-truth] ONE rendering of an effort, used both to COMPARE two runs' arms and to name
// them in the refusal — so the message can never describe a difference the comparison did not make.
function describeEffort(effort) {
  if (effort === null) return 'unrecorded';
  const schema = schemaOf(null, effort);
  return armFor(schema, 'This effort profile').describe(effort);
}

module.exports = { parseEffort, describeEffort, CC_REVIEW_SCHEMA, CC_REVIEW_LEVELS };
