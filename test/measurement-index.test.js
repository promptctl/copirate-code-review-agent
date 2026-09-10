'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { measurementFields, measurementKey, differingFields, measurementOf, lookupMeasurement, renderConsultation, collectMeasurements } = require('../eval/measurement-index');
const { parseMeta } = require('../eval/score');
const { treeIdentity } = require('../eval/run-case');
const { defaultEffortProfile, EFFORT_SCHEMA } = require('../src/effort');

// The contract these tests hold is the ANSWER to "has this already been measured?" — what counts as the
// same measurement, what a miss names, and which runs are unmatchable. Nothing here replays anything.
// [LAW:behavior-not-structure]

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

// A run record as run-case.js writes one, at the CURRENT schema.
function meta({ caseName = 'case-a', sha = SHA, dirty = false, effort = defaultEffortProfile(), schema = EFFORT_SCHEMA } = {}) {
  return { case: caseName, candidate: { sha, dirty }, effort, effortSchema: schema, findingCount: 1 };
}

// Write a corpus of run dirs on disk in the two shapes eval/out really holds: case dirs directly under
// the root, and case dirs one level deeper under a named root.
function writeCorpus(layout) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'measurement-index-'));
  for (const [runPath, record] of Object.entries(layout)) {
    const runDir = path.join(dir, runPath);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'findings.json'), '[]');
    // `null` means a torn record: findings.json written, meta.json missing.
    if (record !== null) fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify(record));
  }
  return dir;
}

const collect = corpusRoot => collectMeasurements({ corpusRoot, parseMeta, treeIdentity });

test('a run at the same case, sha and arm is a hit; the whole comparison is one fold', () => {
  const wanted = measurementFields({ caseName: 'case-a', sha: SHA, effort: defaultEffortProfile() });
  const same = measurementFields({ caseName: 'case-a', sha: SHA, effort: defaultEffortProfile() });
  assert.deepEqual(differingFields(wanted, same), []);
  // Every field of the identity participates: subject AND conditions.
  assert.deepEqual(differingFields(wanted, measurementFields({ caseName: 'case-b', sha: SHA, effort: defaultEffortProfile() })), ['case']);
  assert.deepEqual(differingFields(wanted, measurementFields({ caseName: 'case-a', sha: OTHER_SHA, effort: defaultEffortProfile() })), ['sha']);
  assert.deepEqual(differingFields(wanted, measurementFields({ caseName: 'case-a', sha: SHA, effort: defaultEffortProfile({ sweepCap: 0 }) })), ['sweepCap']);
  assert.deepEqual(differingFields(wanted, measurementFields({ caseName: 'case-a', sha: SHA, effort: defaultEffortProfile({ readSet: 'changed' }) })), ['readSet']);
});

// The ticket's load-bearing requirement: key on the COMPLETED profile, never on the raw meta.json. A
// record written before the readSet axis existed and a record written after it, at the SHIPPED arm, are
// one measurement — otherwise the index holds one row per era instead of one per arm, and every stored
// run on disk today (all of which predate the field) matches nothing.
test('an era record and a current record at the same arm are ONE measurement, not two', () => {
  const era = { case: 'case-a', candidate: { sha: SHA, dirty: false }, effort: { roundCap: 0, sweepCap: 2, reasoningTier: null } };
  const current = meta({ effort: defaultEffortProfile({ sweepCap: 2 }) });
  const of = record => measurementOf({ dir: 'd', root: 'r', meta: parseMeta(JSON.stringify(record), 'm'), treeIdentity }).fields;
  assert.deepEqual(of(era), of(current));
  assert.equal(measurementKey(of(era)), `case=case-a sha=${SHA} roundCap=0 sweepCap=2 reasoningTier=none readSet=assigned`);
});

test('the corpus walk finds run dirs at both depths and names each run its poolable root', () => {
  const dir = writeCorpus({
    'case-a/run1': meta(),                       // the default shape: case dirs directly under the root
    'ab-sweep2/case-a/run1': meta(),             // a named root, one level deeper
    'ab-sweep2/case-a/run2': meta(),
  });
  const corpus = collect(dir);
  assert.equal(corpus.measurements.length, 3);
  // The root is what baseline.js pools as one arm — the run's grandparent in both shapes.
  assert.deepEqual(corpus.measurements.map(m => m.root).sort(), [dir, path.join(dir, 'ab-sweep2'), path.join(dir, 'ab-sweep2')].sort());
  fs.rmSync(dir, { recursive: true });
});

test('an existing measurement is found and located; a differing sha is a MISS naming the field', () => {
  const dir = writeCorpus({
    'ab-sweep2/case-a/run1': meta(),
    'ab-sweep2/case-a/run2': meta(),
    'ab-sweep0/case-a/run1': meta({ sha: OTHER_SHA }),
  });
  const corpus = collect(dir);

  const hit = lookupMeasurement(corpus, measurementFields({ caseName: 'case-a', sha: SHA, effort: defaultEffortProfile() }));
  assert.equal(hit.hits.length, 2);
  assert.deepEqual([...new Set(hit.hits.map(h => h.root))], [path.join(dir, 'ab-sweep2')]);

  // A run at a different sha is a different measurement. It is reported as a miss NAMING sha — never
  // counted as a match, and never reported as a bare absence. [LAW:no-silent-failure]
  const miss = lookupMeasurement(corpus, measurementFields({ caseName: 'case-a', sha: 'c'.repeat(40), effort: defaultEffortProfile() }));
  assert.equal(miss.hits.length, 0);
  assert.ok(miss.nearest.length > 0);
  assert.ok(miss.nearest.every(n => n.differing.length === 1 && n.differing[0] === 'sha'));

  const rendered = renderConsultation({ consultations: [miss], unidentified: corpus.unidentified });
  assert.match(rendered, /MISS .*sha: has [a]{40}, wants [c]{40}/);
  assert.doesNotMatch(rendered, /HIT/);
  fs.rmSync(dir, { recursive: true });
});

test('a differing ARM is a miss naming that axis, so two arms are never counted as one measurement', () => {
  const dir = writeCorpus({ 'ab-sweep2/case-a/run1': meta({ effort: defaultEffortProfile({ readSet: 'changed' }) }) });
  const miss = lookupMeasurement(collect(dir), measurementFields({ caseName: 'case-a', sha: SHA, effort: defaultEffortProfile() }));
  assert.equal(miss.hits.length, 0);
  assert.deepEqual(miss.nearest.map(n => n.differing), [['readSet']]);
  assert.match(renderConsultation({ consultations: [miss], unidentified: [] }), /readSet: has changed, wants assigned/);
  fs.rmSync(dir, { recursive: true });
});

// A run that can never match anything is still a run somebody paid for. Dropping it silently is the exact
// shape of the defect this module closes, so it is carried through and reported with its reason.
test('runs with no provable identity are counted and explained, never dropped', () => {
  const dir = writeCorpus({
    'a/case-a/run1': meta({ dirty: true }),
    'a/case-a/run2': { case: 'case-a', effort: defaultEffortProfile(), effortSchema: EFFORT_SCHEMA },   // no candidate
    'a/case-a/run3': { case: 'case-a', candidate: { sha: SHA, dirty: false } },                          // no effort
  });
  const corpus = collect(dir);
  assert.equal(corpus.measurements.length, 0);
  assert.equal(corpus.unidentified.length, 3);
  const rendered = renderConsultation({ consultations: [], unidentified: corpus.unidentified });
  assert.match(rendered, /dirty tree/);
  assert.match(rendered, /no candidate tree/);
  assert.match(rendered, /no effort profile/);
  fs.rmSync(dir, { recursive: true });
});

test('a torn run record is refused by name, never indexed around', () => {
  const dir = writeCorpus({ 'a/case-a/run1': null });
  assert.throws(() => collect(dir), /has findings.json but no meta.json/);
  fs.rmSync(dir, { recursive: true });
});

test('an absent corpus is an empty corpus, not a crash', () => {
  const corpus = collect(path.join(os.tmpdir(), 'measurement-index-nonexistent'));
  assert.deepEqual(corpus, { measurements: [], unidentified: [] });
});
