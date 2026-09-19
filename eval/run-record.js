'use strict';
// THE RUN-DIR CONTRACT — the one writer of a scored run's record on disk, shared by every producer.
//
// A producer turns a frozen case into a run dir; the scorer (eval/score.js) reduces run dirs and never
// learns which producer wrote one. That seam is what lets this harness price two entirely different
// review mechanisms against one hand-annotated ground truth. While there was exactly one producer the
// seam was implicit — the writer lived inside eval/run-case.js — and an implicit seam is one a second
// producer copies rather than calls. [LAW:decomposition] [LAW:one-source-of-truth]
//
// [LAW:effects-at-boundaries] Module load is PURE: stdlib only. The fs writes here ARE the boundary this
// module exists to own, so they are gathered in one function rather than spread across producers.

const fs = require('fs');
const path = require('path');

// [LAW:parse-dont-validate] The crossing between a live value and a durable artifact. `JSON.stringify`
// answers the VALUE `undefined` for an absent input, and `undefined + '\n'` coerces to the literal text
// "undefined" — a file that reports as an artifact and parses as nothing. Every field of a run record is a
// fact the producer observed, so an absent one is a broken producer and fails HERE, named, rather than as
// a parse crash in whatever reads the artifact months later. Substituting `null` would be worse than
// either: a reader could no longer tell a pass that genuinely recorded nothing from a producer that broke.
// [LAW:no-silent-failure]
//
// The check is lifted out of the rendering because summary.txt is raw text, cannot go through `jsonBytes`,
// and corrupts identically — so the rule is stated once for every field the record carries, in both
// renderings. [LAW:single-enforcer]
function present(field, value) {
  if (value === undefined) {
    throw new Error(`writeRunRecord: ${field} is undefined — a run record cannot record a fact the replay never produced.`);
  }
  return value;
}

function jsonBytes(field, value) {
  return JSON.stringify(present(field, value), null, 2) + '\n';
}

// [LAW:parse-dont-validate] An artifact's NAME is a filename this module is about to join to a directory
// path, and producers name their own artifacts — so the name crosses from producer-supplied data into a
// path here, and here is where it is checked. A name carrying a separator or a `..` would write outside
// the run dir; a name colliding with a contract file would let a producer's extra silently displace the
// record the scorer reads. Both refuse by name. [LAW:no-silent-failure]
const CONTRACT_FILES = ['meta.json', 'summary.txt', 'usage.json', 'findings.json'];

function artifactFilename(name) {
  if (name !== path.basename(name) || name === '.' || name === '..') {
    throw new Error(`writeRunRecord: artifact name ${JSON.stringify(name)} must be a plain filename — it is joined to the run dir.`);
  }
  if (CONTRACT_FILES.includes(name)) {
    throw new Error(`writeRunRecord: artifact ${JSON.stringify(name)} collides with a contract file (${CONTRACT_FILES.join(', ')}).`);
  }
  return name;
}

// One run's record on disk. findings.json is what makes a run dir COMPLETE to every reader (score.js's
// listRunDirs, the suite census, the gate's resume), so it lands last and atomically — written beside,
// then renamed — after every file those readers go on to open. A producer killed or failing at any instant
// leaves a dir that is either complete or ignored, never one that is counted and then unreadable.
// [LAW:no-ambient-temporal-coupling]
//
// `meta`, `summary`, `usage` and `findings` are the CONTRACT — what score.js reads, identical for every
// producer. `artifacts` is everything a producer records BESIDE the contract, as a map from filename to
// JSON value: the engine's `schedule.json` (its own host-stamped wall clock, src/schedule.js) and
// `plan.json` (the partition its workers actually ran, src/plan.js); a `/code-review` producer's result
// envelope. They are DATA crossing one boundary, never a branch in this writer over which producer called
// it — a third producer with a fourth artifact needs no edit here. [LAW:dataflow-not-control-flow]
//
// Every artifact lands BEFORE the findings rename, so a dir that counts as complete always carries the
// artifacts that explain its findings. [LAW:no-ambient-temporal-coupling]
function writeRunRecord(runDir, { meta, summary, usage, findings, artifacts = {} }) {
  fs.writeFileSync(path.join(runDir, 'meta.json'), jsonBytes('meta', meta));
  fs.writeFileSync(path.join(runDir, 'summary.txt'), `${present('summary', summary)}\n`);
  fs.writeFileSync(path.join(runDir, 'usage.json'), jsonBytes('usage', usage));
  for (const [name, value] of Object.entries(artifacts)) {
    fs.writeFileSync(path.join(runDir, artifactFilename(name)), jsonBytes(`artifact ${name}`, value));
  }
  const findingsPath = path.join(runDir, 'findings.json');
  fs.writeFileSync(`${findingsPath}.partial`, jsonBytes('findings', findings));
  fs.renameSync(`${findingsPath}.partial`, findingsPath);
}

module.exports = { writeRunRecord, CONTRACT_FILES };
