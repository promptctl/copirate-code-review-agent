'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { measurementFields, measurementKey, differingFields, measurementOf, lookupMeasurement, renderConsultation, ownedElsewhere, plannedCases, consultCorpus, collectMeasurements } = require('../eval/measurement-index');
const { parseMeta, listRunDirs } = require('../eval/score');
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

const collect = corpusRoot => collectMeasurements({ corpusRoot, parseMeta, treeIdentity, listRunDirs });

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

// A run of another case is not near this measurement at any distance — it answers a different question.
// Reporting it as a near miss buries the line the operator can act on under one row per case in the suite.
test('only runs of the same case can be near; another case is not a near miss', () => {
  const dir = writeCorpus({
    'r/case-a/run1': meta({ caseName: 'case-a', sha: OTHER_SHA }),   // same question, stale conditions
    'r/case-b/run1': meta({ caseName: 'case-b' }),                    // a different question entirely
  });
  const miss = lookupMeasurement(collect(dir), measurementFields({ caseName: 'case-a', sha: SHA, effort: defaultEffortProfile() }));
  assert.deepEqual(miss.nearest.map(n => n.differing), [['sha']]);
  assert.doesNotMatch(renderConsultation({ consultations: [miss], unidentified: [] }), /case: has/);
  fs.rmSync(dir, { recursive: true });
});

// A torn record is a run whose identity cannot be read, which is what `unidentified` means — so it takes a
// row in that vocabulary and is reported by name. It must NOT abort: the scan is the whole corpus, so a
// throw would let one stray dir in an experiment root nobody touches block every future invocation for
// every --out. The strict rule keeps its own enforcer in freeze-suite's priorRunArms, on the root being
// WRITTEN, where the blast radius is the operator's own target.
test('a torn run record is reported by name, and does not abort the corpus around it', () => {
  const dir = writeCorpus({ 'a/case-a/torn': null, 'a/case-a/whole': meta() });
  const corpus = collect(dir);
  assert.equal(corpus.measurements.length, 1);
  assert.deepEqual(corpus.unidentified.map(u => u.unidentified), ['a torn run record: findings.json with no meta.json']);
  assert.match(renderConsultation({ consultations: [], unidentified: corpus.unidentified }), /torn run record/);
  fs.rmSync(dir, { recursive: true });
});

// The judgement the whole feature turns on: a hit inside the root being filled is this suite's own census,
// which planJobs has already counted; only a hit OUTSIDE it is a measurement about to be re-bought.
test('only a hit outside the root being filled is something already owned', () => {
  const here = '/out/here';
  const consultation = hits => [{ key: 'k', wanted: {}, hits, nearest: [] }];
  assert.deepEqual(ownedElsewhere(consultation([{ root: here }]), here), []);
  assert.deepEqual(ownedElsewhere([], here), []);
  assert.deepEqual(ownedElsewhere(consultation([{ root: '/out/elsewhere' }, { root: here }]), here), [{ root: '/out/elsewhere' }]);
});

// The minimum-distance tier is what keeps a large corpus's miss list readable. Every other test builds a
// single tier, so a flipped comparison here would ship green.
test('only the closest tier of misses is reported, not every same-case miss', () => {
  const dir = writeCorpus({
    'r/case-a/one-off': meta({ sha: OTHER_SHA }),                                             // differs in sha alone
    'r/case-a/two-off': meta({ sha: OTHER_SHA, effort: defaultEffortProfile({ readSet: 'changed' }) }),  // sha AND arm
  });
  const miss = lookupMeasurement(collect(dir), measurementFields({ caseName: 'case-a', sha: SHA, effort: defaultEffortProfile() }));
  assert.deepEqual(miss.nearest.map(n => n.differing), [['sha']]);
  assert.deepEqual(miss.nearest.map(n => path.basename(n.dir)), ['one-off']);
  fs.rmSync(dir, { recursive: true });
});

// The derivation that carried a regression once: a case already at target N contributes no subject, so its
// hit in an unrelated root cannot refuse another case's still-pending replays.
test('only a case with a scheduled replay asks the corpus anything', () => {
  const cases = [{ name: 'complete' }, { name: 'short' }];
  const jobs = [{ name: 'short', level: 1 }, { name: 'short', level: 2 }];
  assert.deepEqual(plannedCases(cases, jobs).map(c => c.name), ['short']);
  assert.deepEqual(plannedCases(cases, []), []);
});

// Nothing planned means nothing asked — and asking is what costs a corpus walk. A status re-invocation
// must not pay it; the tree snapshot it would compare against is the caller's, and a caller with nothing
// planned took none (null).
test('a suite with nothing planned reads no corpus', () => {
  const dir = writeCorpus({ 'r/case-a/run1': meta() });
  const answer = consultCorpus({
    planned: [], effort: defaultEffortProfile(), corpusRoot: dir,
    parseMeta, treeIdentity, listRunDirs, tree: null,
  });
  assert.deepEqual(answer, { notice: null, consultations: [], unidentified: [] });
  fs.rmSync(dir, { recursive: true });
});

// A dirty tree names no reproducible content, so no stored run can be proven a replay of it. The notice
// says so rather than leaving the silence to be read as "nothing found".
test('a dirty tree consults nothing and says why', () => {
  const dir = writeCorpus({ 'r/case-a/run1': meta() });
  const answer = consultCorpus({
    planned: [{ name: 'case-a' }], effort: defaultEffortProfile(), corpusRoot: dir,
    parseMeta, treeIdentity, listRunDirs, tree: { sha: SHA, dirty: true },
  });
  assert.match(answer.notice, /DIRTY/);
  assert.deepEqual(answer.consultations, []);
  fs.rmSync(dir, { recursive: true });
});

test('a planned case consults the corpus and reports what it holds', () => {
  const dir = writeCorpus({ 'r/case-a/run1': meta() });
  const answer = consultCorpus({
    planned: [{ name: 'case-a' }], effort: defaultEffortProfile(), corpusRoot: dir,
    parseMeta, treeIdentity, listRunDirs, tree: { sha: SHA, dirty: false },
  });
  assert.match(answer.notice, /1 identified run\(s\) on disk/);
  assert.equal(answer.consultations.length, 1);
  assert.equal(answer.consultations[0].hits.length, 1);
  fs.rmSync(dir, { recursive: true });
});

// Same fact as a missing meta.json — a run whose identity cannot be read — and the same reason it must not
// abort: one unreadable record anywhere would block every invocation for every --out. The likely cause is
// an effortSchema written by a branch that has already bumped the version.
test('a record that cannot be parsed is reported by name, not thrown', () => {
  const dir = writeCorpus({ 'r/case-a/whole': meta(), 'r/case-a/truncated': null, 'r/case-a/future': meta({ schema: 'copirate-effort/v99' }) });
  fs.writeFileSync(path.join(dir, 'r/case-a/truncated', 'meta.json'), '{ "case": "case-a"');
  const corpus = collect(dir);
  assert.equal(corpus.measurements.length, 1);
  assert.deepEqual(corpus.unidentified.map(u => path.basename(u.dir)).sort(), ['future', 'truncated']);
  assert.match(corpus.unidentified.find(u => u.dir.endsWith('future')).unidentified, /Unknown effort schema/);
  fs.rmSync(dir, { recursive: true });
});

test('an absent corpus is an empty corpus, not a crash', () => {
  const corpus = collect(path.join(os.tmpdir(), 'measurement-index-nonexistent'));
  assert.deepEqual(corpus, { measurements: [], unidentified: [] });
});
