'use strict';
// The corpus of measurements already on disk, answering "has this already been measured?" BEFORE any
// replay is planned.
//
// Why it exists: eval/freeze-suite.js's census is PER-OUTPUT-ROOT. It answers "is this --out dir full?"
// and cannot answer "does this measurement exist anywhere?". On 2026-09-09 twelve completed runs of the
// exact arm about to be generated sat one directory over in eval/out/ab-sweep2, invisible, and a 4-hour
// 40-run plan was launched to re-buy them. It was killed at ~2 minutes by the owner, not by the tool.
//
// [LAW:one-source-of-truth] applied to the CORPUS rather than to any single record: every completed run
// is a purchased fact about (case, candidate tree, effort profile), and until this module there was no
// authoritative index of those facts — so the harness could not tell work not yet done from work already
// paid for.
//
// [LAW:no-silent-failure] This module REPORTS a reusable measurement; it never substitutes one. A run at
// a different sha or a different arm is a different measurement, and the consultation says so by NAME —
// which field differs, what it holds, what was wanted — rather than quietly counting it as a match.
//
// [LAW:effects-at-boundaries] Module load is PURE (the freeze-suite rule, since that file imports this
// one): only stdlib and pure helpers at load. `collectMeasurements` is the single fs-touching function.

const fs = require('fs');
const path = require('path');
// [LAW:one-source-of-truth] The axis set of the effort type, read from its owner. This is the ticket's
// load-bearing requirement: an index keyed on a hand-written axis list holds one row per ERA rather than
// one per ARM, because a record written before an axis existed would key differently from an identical
// run written after. effortAxes() widens the moment the profile does.
const { effortAxes } = require('../src/effort');

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// pure
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

// [LAW:one-source-of-truth] The identity splits into a SUBJECT and its CONDITIONS, and the split is not
// cosmetic — it is what makes "near" mean something.
//
// The SUBJECT is the QUESTION a measurement answers: which golden case was reviewed. The CONDITIONS are
// what the answer is contingent on: which commit of the reviewer produced it, and under which effort
// arm. All of them together are the identity — a differing condition is a different fact and can never
// be counted as a match — but only a run sharing the SUBJECT can be NEAR: "you measured this case, at an
// older sha" is a difference an operator acts on, while a run of another case is not close to this one
// at any distance, it simply answers something else.
const SUBJECT_FIELD = 'case';
const CONDITION_FIELDS = ['sha', ...effortAxes()];

// A condition field and the subject sharing a name would collapse two facts into one key — silently, and
// only for whoever added the axis. The overlap is refused at LOAD, where it cannot reach a measurement.
// [LAW:no-silent-failure] [LAW:types-are-the-program]
const collided = effortAxes().filter(axis => axis === SUBJECT_FIELD || axis === 'sha');
if (collided.length > 0) {
  throw new Error(
    `Effort axis ${collided.join(', ')} collides with a measurement identity field ('${SUBJECT_FIELD}', 'sha'). ` +
    'Rename the axis, or give the identity fields their own namespace — a shared name silently merges two facts.',
  );
}

// [LAW:effects-at-boundaries] Pure. The identity of one measurement, as a FLAT RECORD of named fields
// rather than an opaque string: the string below is derived from it, and so is the differing-field diff,
// so the equality the index tests and the difference the report names can never disagree.
// [LAW:one-source-of-truth]
//
// The effort is PROJECTED onto effortAxes() rather than spread whole: a record from a newer schema may
// carry a key this tree does not know, and letting it into the identity would make an otherwise-matching
// run miss for a reason no reader could see. The projection is also what makes "key on the COMPLETE
// profile" structural — callers hand in what score.js's parseMeta produced, which has already been
// through completeEffort.
function measurementFields({ caseName, sha, effort }) {
  const fields = { [SUBJECT_FIELD]: caseName };
  for (const field of CONDITION_FIELDS) fields[field] = field === 'sha' ? sha : effort[field];
  return fields;
}

// [LAW:one-source-of-truth] The ONE rendering of a measurement's identity, used to name it in every
// report. Deliberately NOT score.js's describeEffort: that renders the four axes it was written against
// as a hand-written template, so a fifth axis would join the index's identity (via effortAxes()) while
// staying invisible in the message — a report describing a difference the comparison did not make. This
// renders exactly the fields the comparison uses, whatever they are.
//
// `null` renders as 'none' because that is what a null axis MEANS here (reasoningTier's "propose no
// raise"), matching describeEffort's spelling of the same value.
function measurementKey(fields) {
  return Object.entries(fields).map(([name, value]) => `${name}=${value === null ? 'none' : value}`).join(' ');
}

// [LAW:effects-at-boundaries] Pure. The names of the fields on which two measurements differ — the whole
// comparison, and the whole miss report, in one fold. A HIT is simply an empty result, so there is no
// second equality rule that could disagree with the difference this names. [LAW:one-source-of-truth]
function differingFields(wanted, found) {
  return Object.keys(wanted).filter(name => wanted[name] !== found[name]);
}

// [LAW:parse-dont-validate] The crossing from a stored run record to an indexable MEASUREMENT: in goes a
// meta.json as score.js's parseMeta returned it, out comes either a measurement (carrying fields that
// could not have existed before this check) or a TYPED ABSENCE naming why the run cannot be one.
//
// [LAW:no-silent-failure] The absence is a value, not a skip. A run that cannot be matched is still a run
// somebody paid for, and dropping it silently is the exact shape of the defect this module exists to
// close — a purchased fact invisible to the harness. It is reported, with its reason, in the consultation.
//
// `treeIdentity` is passed in rather than imported: run-case.js owns the rule "a dirty tree names no
// reproducible content, so nothing can be proven to be a replay of it", and requiring that module here
// would drag its whole engine-facing require graph into this file's load-purity guarantee.
// [LAW:one-source-of-truth] the rule still has exactly one home; this is a call to it.
function measurementOf({ dir, root, meta, treeIdentity }) {
  if (meta.candidate === null) return { dir, root, unidentified: 'the run recorded no candidate tree' };
  const sha = treeIdentity(meta.candidate);
  if (sha === null) return { dir, root, unidentified: `the run was produced from a dirty tree at ${meta.candidate.sha}` };
  // A wholly absent effort is genuinely unknown — unlike a missing AXIS, which the effort schema's
  // back-fill resolves inside parseMeta. Guessing it is how two arms get counted as one measurement.
  if (meta.effort === null) return { dir, root, unidentified: 'the run recorded no effort profile' };
  return { dir, root, fields: measurementFields({ caseName: meta.case, sha, effort: meta.effort }) };
}

// [LAW:effects-at-boundaries] Pure: the collected corpus and one wanted identity in, the corpus's ANSWER
// out. The answer is a census, not a boolean — "what does the corpus hold about this measurement?" has
// two parts, and a hit/miss flag would throw away the one that makes the answer actionable:
//   `hits`    — runs at exactly this identity: the measurement, already purchased.
//   `nearest` — the runs that come CLOSEST, each naming the fields on which it differs and what it holds
//               there. This is what turns "not found" into "found, but at a different sha".
// Both are computed by the SAME fold, so a hit is `differing.length === 0` and nothing else — there is no
// second equality rule that could disagree with the difference the report names. [LAW:one-source-of-truth]
//
// `nearest` is drawn only from runs sharing the SUBJECT, and then keeps only the minimum-difference tier.
// Both narrowings exist because the corpus is large and an unfiltered miss list buries the line that
// matters: runs of another case are not near this measurement at any distance (they answer a different
// question), and among same-case runs the ones differing in a single condition are the ones an operator
// can act on.
//
// The corpus's `unidentified` runs are deliberately NOT part of this result: they are a fact about the
// corpus, not about this identity, and folding them in would reprint the same list once per case.
function lookupMeasurement(corpus, wanted) {
  const scored = corpus.measurements.map(m => ({ ...m, differing: differingFields(wanted, m.fields) }));
  const misses = scored.filter(s => s.differing.length > 0 && s.fields[SUBJECT_FIELD] === wanted[SUBJECT_FIELD]);
  const closest = misses.reduce((min, s) => Math.min(min, s.differing.length), Infinity);
  return {
    key: measurementKey(wanted),
    wanted,
    hits: scored.filter(s => s.differing.length === 0),
    nearest: misses.filter(s => s.differing.length === closest),
  };
}

// [LAW:effects-at-boundaries] Pure. Runs counted under the caption they share, so the report speaks in
// the unit an operator acts on. Hits and misses use the SAME grouping because they are the same question
// asked of different rows — "how many runs, and where" — and two counting rules would eventually render
// the same corpus two different sizes. [LAW:one-source-of-truth] [LAW:one-type-per-behavior]
function tally(items, captionOf) {
  const counts = new Map();
  for (const item of items) {
    const caption = captionOf(item);
    counts.set(caption, (counts.get(caption) ?? 0) + 1);
  }
  return [...counts].map(([caption, count]) => `${count} run(s) ${caption}`);
}

// [LAW:effects-at-boundaries] Pure. The consultation as the operator reads it, before a dollar is spent.
// It names what was found and WHERE, so "you already own this" arrives with the directory to score
// attached — and it names a MISS by the differing FIELD and both values, never as a bare absence.
//
// Hits group by output ROOT because that is the unit that can be acted on: baseline.js pools one root as
// one arm, so "12 run(s) in eval/out/ab-sweep2" is a re-scorable measurement while the same twelve paths
// listed individually are just paths. Misses group by root AND difference, so a whole arm that sits at
// the wrong sha reports as one line stating the sha, not as N identical lines.
//
// The corpus's unmatchable runs are printed ONCE, after the per-identity answers: they belong to no
// identity, but they are runs somebody paid for, and letting them go unmentioned is the very shape of the
// defect this module closes. [LAW:no-silent-failure]
function renderConsultation({ consultations, unidentified }) {
  const lines = [];
  for (const c of consultations) {
    lines.push(`  ${c.key}`);
    for (const line of tally(c.hits, hit => `in ${hit.root}`)) lines.push(`    HIT  ${line}`);
    for (const line of tally(c.nearest, near => {
      const diff = near.differing.map(f => `${f}: has ${near.fields[f] ?? 'none'}, wants ${c.wanted[f] ?? 'none'}`).join('; ');
      return `in ${near.root} — ${diff}`;
    })) lines.push(`    MISS ${line}`);
  }
  for (const line of tally(unidentified, u => `in ${u.root} not matchable: ${u.unidentified}`)) lines.push(`  ????  ${line}`);
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// effects
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

// [LAW:one-source-of-truth] A completed run is "a directory carrying findings.json" — score.js's
// `listRunDirs` predicate, applied recursively here rather than restated, so the index and the scorer
// can never disagree about what exists.
//
// The walk is by PREDICATE and not by depth, because eval/out has two shapes at once: the default root
// holds case dirs directly (eval/out/<case>/<run>) while a named root nests one level deeper
// (eval/out/ab-sweep2/<case>/<run>). A hardcoded depth reads one of them and is blind to the other —
// and the runs that were re-bought lived in the nested shape.
//
// The output ROOT of a run is the directory two levels above it, which is the same value in both shapes:
// the run's parent is its case dir, and that dir's parent is the root baseline.js pools as one arm.
function findRunDirsDeep(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
  // A run dir is a leaf of this walk: it holds findings.json, and its children are the review's own
  // artifacts, never further runs. Descending into one would be a search for measurements inside a
  // measurement. [LAW:dataflow-not-control-flow] the predicate decides what a directory IS; the walk
  // itself is the same operation at every level.
  return entries.flatMap(e => {
    const child = path.join(dir, e.name);
    return fs.existsSync(path.join(child, 'findings.json')) ? [child] : findRunDirsDeep(child);
  });
}

// [LAW:effects-at-boundaries] The one fs-touching function: it reads the corpus and hands back a pure
// value that every function above operates on.
//
// `parseMeta` and `treeIdentity` are injected rather than required at module scope, keeping this file's
// load pure (freeze-suite.js's rule) and its require graph free of the engine — the same lazy-require
// discipline freeze-suite already applies to score.js and run-case.js. [LAW:one-way-deps]
//
// [LAW:no-silent-failure] A counted run WITHOUT meta.json is a TORN record — run-case.js writes meta.json
// first and findings.json last, so the pair can only be broken after the fact. It is refused by name,
// never skipped: a run whose identity cannot be read must not pass through an index whose whole job is
// to prove what has already been measured. Same rule, same reason, as freeze-suite's priorRunArms.
function collectMeasurements({ corpusRoot, parseMeta, treeIdentity }) {
  const runDirs = fs.existsSync(corpusRoot) ? findRunDirsDeep(corpusRoot) : [];
  const records = runDirs.map(dir => {
    const metaPath = path.join(dir, 'meta.json');
    if (!fs.existsSync(metaPath)) {
      throw new Error(`${dir} has findings.json but no meta.json — a torn run record. Remove the run dir, or re-run the case.`);
    }
    const root = path.dirname(path.dirname(dir));
    return measurementOf({ dir, root, meta: parseMeta(fs.readFileSync(metaPath, 'utf8'), metaPath), treeIdentity });
  });
  return {
    measurements: records.filter(r => r.fields !== undefined),
    unidentified: records.filter(r => r.fields === undefined),
  };
}

module.exports = {
  SUBJECT_FIELD,
  CONDITION_FIELDS,
  measurementFields,
  measurementKey,
  differingFields,
  measurementOf,
  tally,
  lookupMeasurement,
  renderConsultation,
  findRunDirsDeep,
  collectMeasurements,
};
