'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { PLAN_SCHEMA, PLAN_PROVENANCES, PLAN_FIELDS, planRecord } = require('../src/plan');
const { buildPrMaterial, runMultiScopePass } = require('../src/multiscope');

// The plan is the review's STRUCTURE, and until this artifact existed it was recoverable only by parsing
// worker transcripts — which is why a variable carrying a 26-point recall spread on a frozen case could
// be re-rolled every run with nobody able to name what it rolled (copirate-determinism-5od).
//
// Two things have to be true for the record to be worth anything, and they are the two halves of this
// file. The mint has to refuse a plan that could mislead a reader (an unknown origin, a price on an
// origin that spawned nothing, a field the pass never produced). And the recorded partition has to be
// the one the WORKERS RAN — not a plausible re-derivation of it. A plan.json that merely parses would
// pass a naive test and still describe a review that never happened. [LAW:verifiable-goals]

const VALID = {
  provenance: 'scout',
  context: 'the scout summary every worker was shown',
  scopes: [{ name: 'auth', focus: 'the auth change', files: ['src/auth.js'] }],
  scoutUsage: { span: { from: '2026-01-01T00:00:00Z', to: '2026-01-01T00:01:00Z' } },
};

describe('the plan mint — a recorded partition a reader can trust', () => {
  test('a minted plan carries the version that says which field set it was written under', () => {
    assert.equal(planRecord(VALID).planSchema, PLAN_SCHEMA);
  });

  // [LAW:one-source-of-truth] The loop is over PLAN_FIELDS, so a field added to the record is demanded
  // of every producer and asserted here on the day it is added, with no edit to this test — the same
  // discipline effortAxes() gives the effort profile's axes (test/effort.test.js).
  test('every field of the record is demanded, and an absent one names itself instead of landing as null', () => {
    for (const field of PLAN_FIELDS) {
      assert.equal(field in planRecord(VALID), true, `${field} must survive the mint`);
      assert.throws(
        () => planRecord({ ...VALID, [field]: undefined }),
        new RegExp(`${field} is undefined`),
        `${field}: a fact the pass never produced must abort the record, not be recorded as an absence`,
      );
    }
  });

  test('provenance is a closed vocabulary — an unknown origin is refused, naming the ones that exist', () => {
    assert.deepEqual(PLAN_PROVENANCES, ['scout', 'pinned']);
    assert.throws(() => planRecord({ ...VALID, provenance: 'guessed' }), /unknown provenance "guessed".*scout, pinned/s);
    // The absent case is the one the epic calls out by name: a plan whose origin is unknown is an
    // absence that reads like an answer, so it can never be spelled as a missing field.
    assert.throws(() => planRecord({ ...VALID, provenance: undefined }), /provenance is undefined/);
  });

  // The two readings of `null` that provenance exists to pull apart: under 'scout' it is the engine
  // reporting no usage (spanMs already spells this 'unclocked'), under 'pinned' it is that no scout ran.
  test("a scout plan may record no price — an engine that reported nothing is a recorded absence, not a broken record", () => {
    assert.equal(planRecord({ ...VALID, scoutUsage: null }).scoutUsage, null);
  });

  test('a pinned plan cannot be billed for a spawn it never made', () => {
    assert.throws(
      () => planRecord({ ...VALID, provenance: 'pinned' }),
      /provenance 'pinned' plans no scout spawn, so scoutUsage must be null/,
    );
    assert.equal(planRecord({ ...VALID, provenance: 'pinned', scoutUsage: null }).provenance, 'pinned');
  });

  test('a plan with no scope is no plan: the empty partition is refused rather than recorded', () => {
    assert.throws(() => planRecord({ ...VALID, scopes: [] }), /non-empty list of scopes/);
    assert.throws(() => planRecord({ ...VALID, scopes: 'auth' }), /non-empty list of scopes/);
  });

  test('context is the string the workers were shown — a structured stand-in is refused', () => {
    assert.equal(planRecord({ ...VALID, context: '' }).context, '', 'a scout that summarised nothing is a real, recordable value');
    assert.throws(() => planRecord({ ...VALID, context: { summary: 'x' } }), /context must be the string/);
  });
});

// ── the ACCEPT criterion: the record IS the partition the workers ran ──────────────────────────────────

const TOOL_NAMES = {
  requestChange: 'mcp__review_collector__request_change',
  finishReview: 'mcp__review_collector__finish_review',
  addScope: 'mcp__review_collector__add_scope',
  assessDependency: 'mcp__review_collector__assess_dependency',
};
const REPO_ROOT = '/home/runner/work/acme/acme';
const FILES = [
  { filename: 'src/auth.js', status: 'modified', patch: '@@ -1,1 +1,1 @@\n+const a = 1;' },
  { filename: 'src/io.js', status: 'modified', patch: '@@ -1,1 +1,1 @@\n+const b = 2;' },
];

// One pass whose material CAPTURES what each worker was handed. The capture sits at material.buildWorkerPrompt
// — the exact seam runScopeWorker hands the assignment to — rather than regexing the rendered prompt, so what
// this test compares against is the argument itself, not a re-reading of its rendering.
async function passRecording(scoutScopes, { withheldPaths = [] } = {}) {
  const pr = buildPrMaterial({ files: FILES, maxDiffChars: 0, reviewedRepoRoot: REPO_ROOT });
  const handed = [];
  const material = {
    ...pr,
    withheldPaths,
    buildWorkerPrompt: (focusText, toolNames, assignment, priorFindings) => {
      handed.push({ focusText, assigned: assignment.assigned });
      return pr.buildWorkerPrompt(focusText, toolNames, assignment, priorFindings);
    },
  };
  let spawn = 0;
  const adapter = {
    async produceReview({ buildPromptFor }) {
      buildPromptFor(TOOL_NAMES);
      if (spawn++ === 0) return { summary: 'planning context', findings: [], assessments: [], scopes: scoutScopes, usage: null };
      return { summary: 'sum', findings: [], assessments: [], usage: null };
    },
  };
  const review = await runMultiScopePass({
    config: { engine: 'fake', name: 'c1' },
    material,
    registry: { get: () => adapter },
    instructionsPath: 'x',
    laneCeiling: 4,
    sweepCap: 0,
    readSet: 'assigned',
    log: () => {},
    sleepFn: async () => {},
  });
  return { handed, plan: review.plan };
}

describe('the recorded plan is the partition the workers actually ran', () => {
  test('every scope the plan claims was handed to a worker, with byte-identical files', async () => {
    const { handed, plan } = await passRecording([
      { name: 'auth', focus: 'the auth change', files: ['src/auth.js'] },
      { name: 'io', focus: 'the io change', files: ['src/io.js'] },
    ]);
    assert.equal(plan.provenance, 'scout');
    // Compared as a SET of (name → files): the plan states the partition, and the pool's lane order is
    // not part of it. [LAW:behavior-not-structure]
    const claimed = new Map(plan.scopes.map(s => [s.name, s.files]));
    const given = new Map(handed.map(h => [h.focusText.split('\n').pop().split(' — ')[0], h.assigned]));
    assert.equal(claimed.size, given.size, 'the plan claims a different number of scopes than ran');
    for (const [name, files] of claimed) {
      assert.deepEqual(given.get(name), files, `scope '${name}': the plan records an assignment no worker was given`);
    }
  });

  test("the plan records the partition AS CORRECTED — the sweep scope the scout never planned is in it, because a worker ran it", async () => {
    // The scout leaves src/io.js unassigned; planScopes sweeps it into a catch-all so some worker reads
    // it. A plan recording the SCOUT's output instead of the pass's would omit that scope entirely and
    // describe a review that covered less than it did. [LAW:one-source-of-truth]
    const { handed, plan } = await passRecording([{ name: 'auth', focus: 'the auth change', files: ['src/auth.js'] }]);
    assert.equal(plan.scopes.length, 2);
    const swept = plan.scopes.find(s => s.files.includes('src/io.js'));
    assert.ok(swept, 'the swept file is in no recorded scope, so the plan under-reports its own coverage');
    assert.ok(handed.some(h => h.assigned.includes('src/io.js')), 'no worker was handed the swept file');
    assert.equal(plan.scopes.filter(s => s.name === 'auth')[0].files.length, 1);
  });

  test('the context the plan records is the one prefixed onto every worker focus', async () => {
    const { handed, plan } = await passRecording([{ name: 'auth', focus: 'the auth change', files: ['src/auth.js', 'src/io.js'] }]);
    assert.equal(plan.context, 'planning context');
    // Not byte-recoverable from summary.txt (composeSummary embeds it in composed prose), which is why
    // the plan carries it: a pinned replay reconstructs workerFocusText from THIS.
    for (const h of handed) assert.ok(h.focusText.includes('planning context'), 'a worker saw a context the plan does not record');
  });
});
