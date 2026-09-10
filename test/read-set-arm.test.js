'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { buildPrMaterial, runMultiScopePass } = require('../src/multiscope');
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

// Two directories of two files each, so the partition yields two scopes ('src/auth' and 'src/io') and
// 'assigned' and 'changed' genuinely disagree: with one scope owning everything the arms would coincide,
// and a test that cannot fail on the wrong arm proves nothing.
const FILES = [
  { filename: 'src/auth/login.js', status: 'modified', patch: '@@ -1,1 +1,1 @@\n+const a = 1;' },
  { filename: 'src/auth/token.js', status: 'modified', patch: '@@ -1,1 +1,1 @@\n+const t = 1;' },
  { filename: 'src/io/read.js', status: 'modified', patch: '@@ -1,1 +1,1 @@\n+const b = 2;' },
  { filename: 'src/io/write.js', status: 'modified', patch: '@@ -1,1 +1,1 @@\n+const w = 2;' },
];

// One pass over the material at one arm, returning what the engine actually saw: every worker prompt,
// plus the plan the pass reviewed. A PR pass computes its plan, so every spawn is a worker.
async function passAtArm(readSet, { material = buildPrMaterial({ files: FILES, maxDiffChars: 0, reviewedRepoRoot: REPO_ROOT }) } = {}) {
  const workerPrompts = [];
  const adapter = {
    async produceReview({ buildPromptFor }) {
      workerPrompts.push(buildPromptFor(TOOL_NAMES));
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

// A worker's prompt is found by its scope's focus line: `${name} — ${focus}`, where the partition's focus
// opens with the same directive for every scope.
const promptFor = (prompts, scopeName) => prompts.find(p => p.includes(`${scopeName} — Review the changes`));
const readTargetsOf = (prompt) => prompt.match(/assigned changed files: (.*?)\. Skip any among them/)?.[1];

describe('the read-set arm reaches the worker prompt — the A/B is expressible end to end', () => {
  test("'assigned' tells each worker to read ITS OWN files, and to leave the neighbours to their owner", async () => {
    const { workerPrompts } = await passAtArm('assigned');
    const auth = promptFor(workerPrompts, 'src/auth');
    assert.ok(auth, 'the src/auth worker never ran');
    assert.match(auth, /Read the complete content of THESE files — this scope's assigned changed files: src\/auth\/login\.js, src\/auth\/token\.js/);
    // The cost cut is this sentence, not the file list: without it a worker that reads its neighbour
    // anyway would make the two arms converge in behavior while still differing on paper.
    assert.match(auth, /Another scope's worker reads the other changed files, so do NOT read them in full/);
    assert.equal(readTargetsOf(auth), 'src/auth/login.js, src/auth/token.js', 'the split did not hold');
  });

  test("'changed' tells every worker to read the whole changed set — the pre-split behavior under measurement", async () => {
    const { workerPrompts } = await passAtArm('changed');
    for (const name of ['src/auth', 'src/io']) {
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
    const assigned = promptFor((await passAtArm('assigned')).workerPrompts, 'src/auth');
    const changed = promptFor((await passAtArm('changed')).workerPrompts, 'src/auth');
    assert.notEqual(assigned, changed);
    // Everything a finding's validity rests on is untouched: the same whole diff, the same anchors, the
    // same focus. If the arms differed in the DIFF as well, a recall delta could not be attributed to the
    // read set — which is the only thing the A/B is trying to price.
    for (const shared of ['src/auth/login.js', 'src/io/read.js', 'src/auth — Review the changes']) {
      assert.ok(assigned.includes(shared) && changed.includes(shared), `both arms should carry ${shared}`);
    }
  });

  test('the arm changes what a worker READS, never what the plan claims to COVER', async () => {
    // scope.files is the coverage record — the partition assigns every changed path exactly once, and the
    // pinned producer checks a replayed plan against the changed set by exact membership. The projection
    // deliberately does not touch it, so an arm cannot silently turn a covered file into an unreviewed
    // one and flatter its own recall.
    const both = await Promise.all([passAtArm('assigned'), passAtArm('changed')]);
    // The review's OWN coverage claim — the line the posted summary carries — plus the scope count the
    // schedule records. Both arms must state the same coverage, because both reviewed the same plan.
    const claims = both.map(({ review }) => review.summary);
    assert.equal(claims[0], claims[1]);
    assert.match(claims[0], /Reviewed 2 scope\(s\): src\/auth, src\/io\./);
    assert.deepEqual(both.map(({ review }) => review.schedule.scopeCount), [2, 2]);
    assert.deepEqual(both.map(({ review }) => review.unreviewedScopes), [[], []]);
    // The plan itself is arm-blind: the partition is a function of the changed paths, which no arm alters.
    assert.deepEqual(both[0].review.plan, both[1].review.plan);
    assert.deepEqual(both[0].review.plan.scopes.map(s => s.files), [['src/auth/login.js', 'src/auth/token.js'], ['src/io/read.js', 'src/io/write.js']]);
  });

  // The bug this guards: `scopeFiles` once carried BOTH what a worker opens and what it was assigned, and
  // the two coincided until this axis existed. Projected to [] under 'changed', the ownership test would
  // find no go.mod on ANY worker and a bumped dependency would produce ZERO assessments — a silent quality
  // difference between the arms that has nothing to do with the read set, contaminating the very A/B this
  // file exists to make trustworthy. Ownership is an identical-everywhere-else fact. [LAW:one-source-of-truth]
  test('exactly one worker owns the go.mod bump under BOTH arms — the arm never moves ownership', async () => {
    // go.mod sits at the repository root, which the partition never merges: it is its own 'top-level' scope.
    const depFiles = [
      { filename: 'go.mod', status: 'modified', patch: '@@ -1,1 +1,1 @@\n+\tgithub.com/a/b v1.1.0' },
      ...FILES,
    ];
    const dependencySummaries = [{
      modulePath: 'github.com/a/b', from: 'v1.0.0', to: 'v1.1.0', resolved: true, owner: 'a', repoName: 'b',
      compareUrl: 'https://github.com/a/b/compare/v1.0.0...v1.1.0', totalCommits: 1,
      commits: [{ sha: 'x'.repeat(12), message: 'm' }], totalFiles: 0, files: [],
    }];
    for (const arm of ['assigned', 'changed']) {
      const material = buildPrMaterial({ files: depFiles, maxDiffChars: 0, reviewedRepoRoot: REPO_ROOT, dependencySummaries });
      const { workerPrompts } = await passAtArm(arm, { material });
      const owners = workerPrompts.filter(p => p.includes("You own this PR's go.mod bump"));
      assert.equal(owners.length, 1, `${arm}: expected exactly one go.mod owner, got ${owners.length}`);
      assert.equal(owners[0], promptFor(workerPrompts, 'top-level'), `${arm}: the wrong worker owns the bump`);
      assert.match(owners[0], /VERBATIM: github\.com\/a\/b/);
    }
  });

  test('the default profile replays the shipped arm — an omitted arm cannot silently become the other one', async () => {
    const { workerPrompts } = await passAtArm(defaultEffortProfile().readSet);
    assert.match(promptFor(workerPrompts, 'src/auth'), /this scope's assigned changed files: src\/auth\/login\.js/);
  });

  test('an arm outside the vocabulary is refused BEFORE any spawn — a bad arm costs nothing', async () => {
    let spawns = 0;
    const adapter = { async produceReview() { spawns++; return { summary: '', findings: [], assessments: [], usage: null }; } };
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
    // would refuse only after a worker spawn had already been paid for.
    assert.equal(spawns, 0, 'a malformed arm reached the engine');
  });
});
