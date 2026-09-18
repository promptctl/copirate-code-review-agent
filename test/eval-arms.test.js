'use strict';
// The arms table. What it must get right is not the markdown — it is that every number in it means one
// thing: one arm, pooled honestly, with its uncertainty beside it and its absences visible.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { pooledRate, meanOf, reduceArm, renderArmsTable, readArm } = require('../eval/arms');
const { CC_REVIEW_SCHEMA } = require('../eval/effort-record');
const { EFFORT_SCHEMA } = require('../src/effort');

describe('a rate carries how much of it is real', () => {
  test('the interval narrows as opportunities accumulate', () => {
    const shallow = pooledRate(10, 20);
    const deep = pooledRate(100, 200);
    assert.equal(shallow.rate, 0.5);
    assert.equal(deep.rate, 0.5);
    assert.ok((deep.high - deep.low) < (shallow.high - shallow.low), 'more opportunities must buy a tighter interval');
    // With 20 must-find opportunities a single pass spans roughly 30–70% — the width that decides whether
    // a gap between two arms is a result or noise, so it is asserted rather than assumed.
    assert.ok(shallow.low > 0.25 && shallow.high < 0.75, `${shallow.low}–${shallow.high}`);
  });

  // THE DEFECT THIS REPLACED, caught by the table's first real run: the textbook normal approximation is
  // p ± z·sqrt(p(1-p)/n), which is exactly 0 at p=0 and p=1 — so a 0-for-2 arm rendered "0% ±0", the
  // least certain measurement in the table claiming to be the most certain one.
  test('a rate at either extreme still carries an interval, never a claim of certainty', () => {
    const none = pooledRate(0, 2);
    assert.equal(none.rate, 0);
    assert.ok(none.high > 0.3, `0/2 must stay wide, got up to ${none.high}`);
    const all = pooledRate(20, 20);
    assert.equal(all.rate, 1);
    assert.ok(all.low < 0.95, `20/20 must stay wide, got from ${all.low}`);
    // The interval never leaves the unit range, whatever the approximation would have done.
    for (const band of [none, all, pooledRate(1, 1)]) {
      assert.ok(band.low >= 0 && band.high <= 1, `${band.low}–${band.high}`);
    }
  });

  // "Nothing was asked" and "nothing was found" are different facts, and a rate of 0 would be the second
  // wearing the first's clothes. [LAW:parse-dont-validate]
  test('a rate over zero opportunities is absent, never zero', () => {
    assert.equal(pooledRate(0, 0).rate, null);
    assert.equal(pooledRate(0, 0).low, null);
    assert.equal(pooledRate(0, 5).rate, 0);
  });
});

describe('a mean says how many figures it is a mean of', () => {
  test('an unrecorded figure is skipped and counted, never averaged in as zero', () => {
    const m = meanOf([2, null, 4, undefined]);
    assert.equal(m.mean, 3);
    assert.equal(m.known, 2);
    assert.equal(m.missing, 2);
    // An unpriced run averaged in as free is how a cost column understates an arm. [LAW:no-silent-failure]
    assert.notEqual(m.mean, 1.5);
  });

  test('nothing recorded at all is an absent mean', () => {
    assert.equal(meanOf([null, null]).mean, null);
  });
});

const perRun = (found, total, over = {}) => ({
  mustFind: { found, total }, inventoryMustFind: { found, total }, niceToFind: { found: 0, total: 2 },
  noise: 3, costUsd: 1.5, ...over,
});

describe('an arm row pools every opportunity once', () => {
  // A mean of per-case rates weights a 2-must-find case the same as a 10-must-find one and reports a
  // number that is no case's rate and no arm's either.
  test('recall pools across cases rather than averaging per-case rates', () => {
    const row = reduceArm({
      label: '/code-review level=medium model=claude-sonnet-5',
      cases: [
        { name: 'small', perRun: [perRun(1, 2)] },
        { name: 'big', perRun: [perRun(2, 10)] },
      ],
      runs: [{ tokens: { inputCacheMiss: 100, inputCacheHit: 900, output: 50 }, wallMinutes: 2 }],
    });
    assert.deepEqual([row.mustFind.found, row.mustFind.total], [3, 12]);
    assert.equal(row.mustFind.rate, 0.25);
    // The per-case average would have been (0.5 + 0.2) / 2 = 0.35 — a number neither case produced.
    assert.notEqual(row.mustFind.rate, 0.35);
    assert.equal(row.runs, 2);
  });

  // Deepening the cheap arm must never require deepening the expensive one — that is most of what makes
  // this eval cheap — so n is a column and arms with different n sit in one table.
  test('arms of different depth render side by side, each with its own n', () => {
    const shallow = reduceArm({ label: 'engine', cases: [{ name: 'a', perRun: [perRun(10, 20)] }], runs: [{ tokens: null, wallMinutes: 12 }] });
    const deep = reduceArm({ label: 'cc', cases: [{ name: 'a', perRun: [perRun(10, 20), perRun(12, 20), perRun(11, 20)] }], runs: [{ tokens: null, wallMinutes: 2 }] });
    const table = renderArmsTable([shallow, deep]);
    assert.match(table, /\| `engine` \| 1 \|/);
    assert.match(table, /\| `cc` \| 3 \|/);
    assert.ok((deep.mustFind.high - deep.mustFind.low) < (shallow.mustFind.high - shallow.mustFind.low));
  });

  // A reader scanning a cost column must be able to see that a run was unpriced rather than free.
  test('an absent figure renders as a dash, never as zero', () => {
    const row = reduceArm({ label: 'cc', cases: [{ name: 'a', perRun: [perRun(1, 2, { costUsd: null, noise: null })] }], runs: [{ tokens: null, wallMinutes: null }] });
    const table = renderArmsTable([row]);
    assert.match(table, /—/);
    assert.doesNotMatch(table, /\$0\.00/);
  });
});

describe('a root that cannot be read honestly is refused, not reduced', () => {
  const summary = (caseName, effort) => JSON.stringify({
    case: caseName, runs: 1, matcher: 'lexical', effort, effortSchema: undefined,
    mustFindRecall: { mean: 0.5, min: 0.5, max: 0.5, n: 1 },
    inventoryMustFindRecall: { mean: 0.5, min: 0.5, max: 0.5, n: 1 },
    niceToFindRecall: { mean: 0, min: 0, max: 0, n: 1 },
    inventoryNiceToFindRecall: { mean: 0, min: 0, max: 0, n: 1 },
    noiseCount: { mean: 3, min: 3, max: 3, n: 1 },
    costUsd: { mean: 1, min: 1, max: 1, n: 1 },
    perRun: [{ mustFind: '1/2', inventoryMustFind: '1/2', niceToFind: '0/2', noise: 3, costUsd: 1 }],
  });
  const ccEffort = { level: 'medium', model: 'claude-sonnet-5', effortSchema: CC_REVIEW_SCHEMA };
  const engineEffort = { roundCap: 0, sweepCap: 2, reasoningTier: null, effortSchema: EFFORT_SCHEMA };

  // A run dir as a producer leaves one: findings.json is what makes it count as a run, usage.json is
  // where the token and wall-clock columns come from.
  const writeRunDir = (dir, caseName, stamp) => {
    const runDir = path.join(dir, caseName, stamp);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'findings.json'), '[]\n');
    fs.writeFileSync(path.join(runDir, 'usage.json'), JSON.stringify({ tokens: { inputCacheMiss: 1, inputCacheHit: 1, output: 1 } }));
  };

  // The summary above reduces exactly one run, so a consistent root holds exactly one run dir per case.
  const root = (cases) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arms-root-'));
    for (const [name, effort] of cases) {
      fs.mkdirSync(path.join(dir, name), { recursive: true });
      fs.writeFileSync(path.join(dir, name, 'scorecard-summary.json'), summary(name, effort));
      writeRunDir(dir, name, '2026-01-01T00-00-00-000Z-run1');
    }
    return dir;
  };

  // THE FAILURE THIS GUARDS: a row pooling two mechanisms reports a rate that is neither, and nothing in
  // the output would show it. [LAW:no-silent-failure]
  test('a root mixing two arms refuses, naming both', () => {
    const dir = root([['alpha', ccEffort], ['beta', engineEffort]]);
    try {
      assert.throws(() => readArm(dir), /mixes arms/);
      assert.throws(() => readArm(dir), /\/code-review level=medium/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an unscored root refuses and says how to score it, rather than reporting an empty arm', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arms-unscored-'));
    try {
      fs.mkdirSync(path.join(dir, 'alpha'));
      assert.throws(() => readArm(dir), /no scorecard-summary\.json/);
      assert.throws(() => readArm(dir), /eval\/score\.js/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // THE MISMATCH: recall and cost come from scorecard-summary.json, tokens and wall clock from a live
  // directory scan. A root extended after scoring — the documented workflow, since run dirs are named by
  // timestamp and scoring is a separate step — renders one row whose left half means N runs and whose
  // right half means M, with no mark on the table saying so. [LAW:no-silent-failure]
  test('a root scored before it was extended refuses, naming the case and both counts', () => {
    const dir = root([['alpha', ccEffort]]);
    try {
      // The summary reduced one run; a second is produced into the root before it is re-scored.
      writeRunDir(dir, 'alpha', '2026-01-01T00-00-01-000Z-run2');
      assert.throws(() => readArm(dir), /holds 2 run dir\(s\) on disk but its scorecard-summary\.json reduced 1/);
      assert.throws(() => readArm(dir), /Re-score the root/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a scored root reads back as one arm', () => {
    const dir = root([['alpha', ccEffort], ['beta', ccEffort]]);
    try {
      const arm = readArm(dir);
      assert.equal(arm.label, '/code-review level=medium model=claude-sonnet-5');
      assert.equal(arm.cases.length, 2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
