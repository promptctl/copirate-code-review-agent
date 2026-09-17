'use strict';
// THE ARM as a union of two producers. What these assert is the property the whole comparison rests on:
// two arms can be told apart, and a run of one can never be pooled into the other's number.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseEffort, describeEffort, CC_REVIEW_SCHEMA, CC_REVIEW_LEVELS } = require('../eval/effort-record');
const { EFFORT_SCHEMA } = require('../src/effort');

const cc = (over = {}) => ({ effort: { level: 'medium', model: 'claude-sonnet-5', ...over }, effortSchema: CC_REVIEW_SCHEMA });
const engine = { effort: { roundCap: 0, sweepCap: 2, reasoningTier: null }, effortSchema: EFFORT_SCHEMA };

describe('the /code-review arm', () => {
  test('a run records what an operator typed and what actually served it', () => {
    const effort = parseEffort(cc(), 'meta.json');
    assert.equal(effort.level, 'medium');
    assert.equal(effort.model, 'claude-sonnet-5');
    assert.match(describeEffort(effort), /^\/code-review level=medium model=claude-sonnet-5$/);
  });

  // The rendering is what the comparison tests for equality AND what a refusal prints, so a level alone
  // would read as an engine axis to anyone holding the other rendering.
  test('the two arms never render alike, so neither can be pooled into the other', () => {
    assert.notEqual(describeEffort(parseEffort(cc(), 'm')), describeEffort(parseEffort(engine, 'm')));
    assert.match(describeEffort(parseEffort(engine, 'm')), /^roundCap=/);
  });

  test('every level the skill accepts is an arm, and nothing else is', () => {
    for (const level of CC_REVIEW_LEVELS) {
      assert.equal(parseEffort(cc({ level }), 'm').level, level);
    }
    // A typo would otherwise run at the skill's fallback and be recorded as the level nobody ran.
    assert.throws(() => parseEffort(cc({ level: 'thorough' }), 'meta.json'), /'effort' must be \{level: one of/);
    assert.throws(() => parseEffort(cc({ model: '' }), 'meta.json'), /model: <non-empty string>/);
  });

  // THE ROUND TRIP that makes the stamp load-bearing: score.js's aggregateRuns persists the PROFILE
  // ALONE into scorecard-summary.json — no `effortSchema` sibling — and eval/arms.js reads it straight
  // back. A profile that did not carry its own arm would re-read as the engine's and pool two mechanisms
  // into one row. [LAW:one-source-of-truth]
  test('a parsed arm survives being persisted alone and read back', () => {
    const stored = JSON.parse(JSON.stringify({ effort: parseEffort(cc(), 'meta.json') }));
    assert.equal(describeEffort(parseEffort(stored, 'scorecard-summary.json')), '/code-review level=medium model=claude-sonnet-5');
  });

  test('an engine profile handed over bare is still the engine — that era had one producer', () => {
    assert.equal(describeEffort({ roundCap: 0, sweepCap: 2, reasoningTier: null }), 'roundCap=0 sweepCap=2 reasoningTier=none');
  });

  test('a schema no arm claims is refused, never interpreted through another arm\'s rules', () => {
    assert.throws(() => parseEffort({ ...cc(), effortSchema: 'claude-code-review/v9' }, 'meta.json'), /Unknown effort schema/);
  });
});

// [LAW:verifiable-goals] The gate machinery is engine-vs-engine by construction. A foreign run reaching
// it would compare this repo's engine against a different reviewer and call the difference a regression.
// The producer records `candidate: null` — truthfully, since no tree of this repo produced the run — and
// these assert that null is what keeps the gate closed to it.
describe('a /code-review run cannot blend into an engine gate', () => {
  const writeRun = (root, caseName, meta) => {
    const dir = path.join(root, caseName, '2026-01-01T00-00-00-000Z-run1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'meta.json'), `${JSON.stringify({ case: caseName, ...meta })}\n`);
    fs.writeFileSync(path.join(dir, 'findings.json'), '[]\n');
    return dir;
  };

  test('compare.js sees it as foreign, by name, rather than averaging it into the candidate', () => {
    const { foreignRuns } = require('../eval/run-case');
    const runs = [{ dir: '/out/cc/run1', candidate: null }];
    const foreign = foreignRuns({ sha: 'abc', dirty: false }, runs);
    assert.deepEqual(foreign.map(f => f.dir), ['/out/cc/run1']);
    assert.match(foreign[0].reason, /no reproducible tree|was replayed on/);
  });

  test('the measurement index refuses to index it, and says why instead of dropping it', () => {
    const { measurementOf } = require('../eval/measurement-index');
    const { treeIdentity } = require('../eval/run-case');
    const out = measurementOf({ dir: '/out/cc/run1', root: '/out/cc', meta: { case: 'alpha', candidate: null, effort: parseEffort(cc(), 'm') }, treeIdentity });
    assert.equal(out.fields, undefined);
    assert.match(out.unidentified, /no candidate tree/);
  });

  test('a scorer pooling a dir refuses the moment two arms share it', () => {
    const { misarmedRuns } = require('../eval/score');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-arm-'));
    try {
      writeRun(root, 'alpha', cc());
      const misarmed = misarmedRuns(parseEffort(engine, 'm'), [{ dir: 'r1', effort: parseEffort(cc(), 'm') }]);
      assert.equal(misarmed.length, 1);
      assert.match(misarmed[0].reason, /\/code-review level=medium/);
      assert.match(misarmed[0].reason, /roundCap=0/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
