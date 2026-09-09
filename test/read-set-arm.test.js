'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { buildPrMaterial, planScopes, runMultiScopePass } = require('../src/multiscope');
const { defaultEffortProfile } = require('../src/effort');

// The read-set axis is an A/B instrument (copirate-measurement-2mg.2): the shipped engine splits the
// full-file reads across the plan ('assigned' — each worker opens only its own scope), and the arm under
// measurement restores the pre-split behavior ('changed' — every worker opens the whole changed set).
// The lever shipped on COST evidence with no verdict on finding quality, and this file is what makes the
// missing verdict obtainable at all.
//
// The unit tests in effort.test.js prove the projection; these prove it is REACHED. An axis that resolved
// correctly and then never touched the prompt would leave every unit test green while both arms of a
// four-hour, real-provider suite replayed the SAME behavior — and the A/B would report "no difference"
// and be believed. That is the specific failure this file exists to make impossible: the two arms must be
// observably different IN THE PROMPT, and identical everywhere else. [LAW:verifiable-goals]

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

// Two scopes over two files, so 'assigned' and 'changed' genuinely disagree: with one scope owning
// everything the arms would coincide, and a test that cannot fail on the wrong arm proves nothing.
const SCOPES = [
  { name: 'auth', focus: 'the auth change', files: ['src/auth.js'] },
  { name: 'io', focus: 'the io change', files: ['src/io.js'] },
];

// One pass over the material at one arm, returning what the engine actually saw: every worker prompt,
// plus the plan the pass reviewed. The adapter's first spawn is the scout; the rest are workers.
async function passAtArm(readSet) {
  const material = buildPrMaterial({ files: FILES, maxDiffChars: 0, reviewedRepoRoot: REPO_ROOT });
  const workerPrompts = [];
  let spawn = 0;
  const adapter = {
    async produceReview({ buildPromptFor }) {
      const prompt = buildPromptFor(TOOL_NAMES);
      if (spawn++ === 0) return { summary: 'ctx', findings: [], assessments: [], scopes: SCOPES, usage: null };
      workerPrompts.push(prompt);
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
    readSet,
    log: () => {},
    sleepFn: async () => {},
  });
  return { workerPrompts, review };
}

const promptFor = (prompts, scopeName) => prompts.find(p => p.includes(`${scopeName} — the`));

describe('the read-set arm reaches the worker prompt — the A/B is expressible end to end', () => {
  test("'assigned' tells each worker to read ITS OWN files, and to leave the neighbours to their owner", async () => {
    const { workerPrompts } = await passAtArm('assigned');
    const auth = promptFor(workerPrompts, 'auth');
    assert.ok(auth, 'the auth worker never ran');
    assert.match(auth, /Read the complete content of THESE files — this scope's assigned changed files: src\/auth\.js/);
    // The cost cut is this sentence, not the file list: without it a worker that reads its neighbour
    // anyway would make the two arms converge in behavior while still differing on paper.
    assert.match(auth, /Another scope's worker reads the other changed files, so do NOT read them in full/);
    assert.ok(!auth.includes('assigned changed files: src/auth.js, src/io.js'), 'the split did not hold');
  });

  test("'changed' tells every worker to read the whole changed set — the pre-split behavior under measurement", async () => {
    const { workerPrompts } = await passAtArm('changed');
    for (const name of ['auth', 'io']) {
      const prompt = promptFor(workerPrompts, name);
      assert.ok(prompt, `the ${name} worker never ran`);
      assert.match(prompt, /Read the complete content of every changed file that contains code/);
      // The arm is the ABSENCE of the split, so the split's two sentences must both be gone: an arm that
      // said "read everything" while still saying "do NOT read the others" would be incoherent to the
      // model and would measure neither behavior.
      assert.ok(!prompt.includes("this scope's assigned changed files"), 'the assigned-files instruction survived');
      assert.ok(!prompt.includes('do NOT read them in full'), 'the do-not-duplicate instruction survived');
    }
  });

  test('the two arms differ ONLY in the read instruction — the same review, varied by one value', async () => {
    // [LAW:behavior-not-structure] The comparison is over the prompts the engine received, so any future
    // implementation that flips the read instruction by another route still passes.
    const assigned = promptFor((await passAtArm('assigned')).workerPrompts, 'auth');
    const changed = promptFor((await passAtArm('changed')).workerPrompts, 'auth');
    assert.notEqual(assigned, changed);
    // Everything a finding's validity rests on is untouched: the same whole diff, the same anchors, the
    // same focus. If the arms differed in the DIFF as well, a recall delta could not be attributed to the
    // read set — which is the only thing the A/B is trying to price.
    for (const shared of ['src/auth.js', 'src/io.js', 'auth — the auth change']) {
      assert.ok(assigned.includes(shared) && changed.includes(shared), `both arms should carry ${shared}`);
    }
  });

  test('the arm changes what a worker READS, never what the plan claims to COVER', async () => {
    // scope.files is the coverage record — planScopes checks the plan against the changed set by exact
    // set membership, and the exclusion strip edits it. The projection deliberately does not touch it, so
    // an arm cannot silently turn a covered file into an unreviewed one and flatter its own recall.
    const both = await Promise.all([passAtArm('assigned'), passAtArm('changed')]);
    // The review's OWN coverage claim — the line the posted summary carries — plus the scope count the
    // schedule records. Both arms must state the same coverage, because both reviewed the same plan.
    const claims = both.map(({ review }) => review.summary);
    assert.equal(claims[0], claims[1]);
    assert.match(claims[0], /Reviewed 2 scope\(s\): auth, io\./);
    assert.deepEqual(both.map(({ review }) => review.schedule.scopeCount), [2, 2]);
    assert.deepEqual(both.map(({ review }) => review.unreviewedScopes), [[], []]);
    // The plan boundary itself is arm-blind: it sees the scout's plan, which no arm alters.
    const { scopes, withheldAssignments } = planScopes(SCOPES, ['src/auth.js', 'src/io.js'], []);
    assert.deepEqual(scopes.map(s => s.files), [['src/auth.js'], ['src/io.js']]);
    assert.deepEqual(withheldAssignments, []);
  });

  test('the default profile replays the shipped arm — an omitted arm cannot silently become the other one', async () => {
    const { workerPrompts } = await passAtArm(defaultEffortProfile().readSet);
    assert.match(promptFor(workerPrompts, 'auth'), /this scope's assigned changed files: src\/auth\.js/);
  });

  test('an arm outside the vocabulary is refused BEFORE the scout spawns — a bad arm costs nothing', async () => {
    let spawns = 0;
    const adapter = { async produceReview() { spawns++; return { summary: '', findings: [], assessments: [], scopes: SCOPES, usage: null }; } };
    await assert.rejects(runMultiScopePass({
      config: { engine: 'fake', name: 'c1' },
      material: buildPrMaterial({ files: FILES, maxDiffChars: 0, reviewedRepoRoot: REPO_ROOT }),
      registry: { get: () => adapter },
      instructionsPath: 'x',
      laneCeiling: 4,
      sweepCap: 0,
      readSet: 'all',
      log: () => {},
      sleepFn: async () => {},
    }), /Unknown read set "all"\. Known read sets: assigned, changed/);
    // The position is the load-bearing part: resolved per worker instead of once at the boundary, this
    // would refuse only after a scout spawn had already been paid for.
    assert.equal(spawns, 0, 'a malformed arm reached the engine');
  });
});
