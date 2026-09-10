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
// Changed files carry the content measurement the material requires (measureChangedFiles); the reader
// is injected as empty content, since these tests exercise the prompt's shape, not the window fit.
const { measureChangedFiles } = require('../src/window');
const stamp = (files) => measureChangedFiles(files, REPO_ROOT, () => '');

// Two directories of two files each, so the partition yields two scopes ('src/auth' and 'src/io') and
// 'assigned' and 'changed' genuinely disagree: with one scope owning everything the arms would coincide,
// and a test that cannot fail on the wrong arm proves nothing.
const FILES = stamp([
  { filename: 'src/auth/login.js', status: 'modified', patch: '@@ -1,1 +1,1 @@\n+const a = 1;' },
  { filename: 'src/auth/token.js', status: 'modified', patch: '@@ -1,1 +1,1 @@\n+const t = 1;' },
  { filename: 'src/io/read.js', status: 'modified', patch: '@@ -1,1 +1,1 @@\n+const b = 2;' },
  { filename: 'src/io/write.js', status: 'modified', patch: '@@ -1,1 +1,1 @@\n+const w = 2;' },
]);

// One pass over the material at one arm, returning what the engine actually saw: every worker prompt,
// plus the plan the pass reviewed. A PR pass computes its plan, so every spawn is a worker.
async function passAtArm(readSet, { material = buildPrMaterial({ files: FILES, maxDiffChars: 0, reviewedRepoRoot: REPO_ROOT }) } = {}) {
  const workerPrompts = [];
  const adapter = {
    contextWindow: null, async produceReview({ buildPromptFor }) {
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
const readTargetsOf = (prompt) => prompt.match(/this scope reads in full: (.*?)\. Skip any among them/)?.[1];

describe('the read-set arm reaches the worker prompt — the A/B is expressible end to end', () => {
  test("'assigned' tells each worker to read ITS OWN files, and to leave the neighbours to their owner", async () => {
    const { workerPrompts } = await passAtArm('assigned');
    const auth = promptFor(workerPrompts, 'src/auth');
    assert.ok(auth, 'the src/auth worker never ran');
    assert.match(auth, /Read the complete content of THESE files — the changed files this scope reads in full: src\/auth\/login\.js, src\/auth\/token\.js/);
    // The cost cut is this sentence, not the file list: without it a worker that reads its neighbour
    // anyway would make the two arms converge in behavior while still differing on paper.
    assert.match(auth, /The other changed files in this pull request — src\/io\/read\.js, src\/io\/write\.js — are owned and read by other scopes' workers, so their diffs are not shown here.*Do NOT read them in full/);
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
      assert.ok(!prompt.includes("the changed files this scope reads in full"), 'the assigned-files instruction survived');
      assert.ok(!prompt.includes('do NOT read them in full'), 'the do-not-duplicate instruction survived');
    }
  });

  test('the two arms differ ONLY in the read instruction — the same review, varied by one value', async () => {
    // [LAW:behavior-not-structure] The comparison is over the prompts the engine received, so any future
    // implementation that flips the read instruction by another route still passes.
    const assigned = promptFor((await passAtArm('assigned')).workerPrompts, 'src/auth');
    const changed = promptFor((await passAtArm('changed')).workerPrompts, 'src/auth');
    assert.notEqual(assigned, changed);
    // The arm is ONE value — a worker's eyesight — and everything else is untouched: the same anchors,
    // the same focus, the same plan. Under 'changed' the eyesight is the whole diff; under 'assigned'
    // it is the scope's own files plus its seams, and the rest of the change is named, not shown.
    for (const shared of ['src/auth/login.js', 'src/io/read.js', 'src/auth — Review the changes']) {
      assert.ok(assigned.includes(shared) && changed.includes(shared), `both arms should carry ${shared}`);
    }
    assert.match(changed, /### src\/io\/read\.js \(modified\)/);
    assert.doesNotMatch(assigned, /### src\/io\/read\.js \(modified\)/);
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
    const depFiles = stamp([
      { filename: 'go.mod', status: 'modified', patch: '@@ -1,1 +1,1 @@\n+\tgithub.com/a/b v1.1.0' },
      ...FILES,
    ]);
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
    assert.match(promptFor(workerPrompts, 'src/auth'), /the changed files this scope reads in full: src\/auth\/login\.js/);
  });

  test('an arm outside the vocabulary is refused BEFORE any spawn — a bad arm costs nothing', async () => {
    let spawns = 0;
    const adapter = { contextWindow: null, async produceReview() { spawns++; return { summary: '', findings: [], assessments: [], usage: null }; } };
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

// ── a cut concern: a part reads the sibling the change couples it to (zai-timing-8jk.4, 8jk.5) ──
// One directory of two 300-line files beside a directory of crumbs: lopsided and over the cap, so the
// partition halves it. a.js defines a symbol b.js's change calls, so the two parts have a seam and each
// reads the other's file; the docs couple to nothing and read nothing. This is the worker-facing proof:
// the read-targets line of a part's prompt names the coupled sibling as a full read, under the shipped
// arm; under 'changed' every worker already reads everything and the parts add nothing.
describe('a cut concern reaches the worker as two full-read lists', () => {
  const long = (n, line = '+x') => `@@ -1,${n} +1,${n} @@\n${`${line}\n`.repeat(n)}`;
  const CONTENT = { '/home/runner/work/acme/acme/src/core/a.js': 'function alpha() {}\n', '/home/runner/work/acme/acme/src/core/b.js': 'alpha();\n' };
  const LOPSIDED = measureChangedFiles([
    { filename: 'src/core/a.js', status: 'modified', patch: long(300) },
    { filename: 'src/core/b.js', status: 'modified', patch: long(300, '+alpha();') },
    { filename: 'docs/x.md', status: 'modified', patch: long(5) },
    { filename: 'docs/y.md', status: 'modified', patch: long(5) },
  ], REPO_ROOT, (p) => CONTENT[p] ?? '');
  const material = () => buildPrMaterial({ files: LOPSIDED, maxDiffChars: 0, reviewedRepoRoot: REPO_ROOT });

  test("'assigned': each part reads its own file AND the sibling it is coupled to; the crumbs worker reads only its own", async () => {
    const { workerPrompts, review } = await passAtArm('assigned', { material: material() });
    assert.deepEqual(review.plan.scopes.map(s => [s.name, s.files, s.reads]), [
      ['docs', ['docs/x.md', 'docs/y.md'], []],
      ['src/core 1/2', ['src/core/a.js'], ['src/core/b.js']],
      ['src/core 2/2', ['src/core/b.js'], ['src/core/a.js']],
    ]);
    assert.equal(readTargetsOf(promptFor(workerPrompts, 'src/core 1/2')), 'src/core/a.js, src/core/b.js');
    assert.equal(readTargetsOf(promptFor(workerPrompts, 'src/core 2/2')), 'src/core/a.js, src/core/b.js');
    assert.equal(readTargetsOf(promptFor(workerPrompts, 'docs')), 'docs/x.md, docs/y.md');
    // Eyesight is the grid: a part sees its own hunk and its seam's, never the docs'.
    const first = promptFor(workerPrompts, 'src/core 1/2');
    assert.match(first, /### src\/core\/b\.js \(modified\)/);
    assert.doesNotMatch(first, /### docs\/x\.md/);
  });

  test("'changed': the parts are still two scopes, and every worker reads the whole set as before", async () => {
    const { workerPrompts, review } = await passAtArm('changed', { material: material() });
    assert.equal(review.plan.scopes.length, 3);
    for (const prompt of workerPrompts) {
      assert.equal(readTargetsOf(prompt), undefined);
      assert.match(prompt, /Read the complete content of every changed file that contains code/);
    }
  });
});
