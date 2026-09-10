'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { filterFiles, NO_EXCLUSIONS, excludedPathList } = require('../src/diff');
const { buildPrMaterial, runMultiScopePass } = require('../src/multiscope');
const { DEFAULT_READ_SET } = require('../src/effort');

// EXCLUDE_PATTERNS removes changed files from the reviewed diff, and the reviewer used to be told
// nothing about it — so a file it EXPECTED to change was absent, and absence-by-configuration was
// indistinguishable from absence-by-omission. Observed on PR #117: a confident, release-blocking
// "the build output was never regenerated" finding against a PR that regenerated it in every commit.
// The contract asserted here is the fix: what the filter removed reaches every worker prompt of the
// pass, as a value carried from the filter — never re-globbed downstream. (zai-review-prompt-2tx)

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

const FILES = stamp([
  { filename: 'src/a.js', status: 'modified', patch: '@@ -1,1 +1,1 @@\n+const x = 1;' },
  { filename: 'build/out.js', status: 'modified', patch: '@@ -1,1 +1,1 @@\n+bundled' },
  { filename: 'deps.lock', status: 'modified', patch: '@@ -1,1 +1,1 @@\n+pinned' },
]);

describe('filterFiles — the cut and the record of the cut are one value', () => {
  test('records the paths it removed, paired with the patterns that removed them', () => {
    const { reviewed, excluded } = filterFiles(FILES, ['build/**', '*.lock']);
    assert.deepEqual(reviewed.map(f => f.filename), ['src/a.js']);
    assert.deepEqual(excluded, { patterns: ['build/**', '*.lock'], paths: ['build/out.js', 'deps.lock'] });
  });

  test('no patterns: every file is reviewed and nothing is recorded as hidden', () => {
    const { reviewed, excluded } = filterFiles(FILES, []);
    assert.deepEqual(reviewed, FILES);
    assert.deepEqual(excluded.paths, []);
  });

  // The patterns are carried whether or not they bit; `paths` alone answers "was anything hidden?".
  test('a pattern that matched nothing hid nothing', () => {
    const { reviewed, excluded } = filterFiles(FILES, ['vendor/**']);
    assert.deepEqual(reviewed, FILES);
    assert.deepEqual(excluded, { patterns: ['vendor/**'], paths: [] });
  });
});

describe('the reviewer is told what was removed from its view', () => {
  const { reviewed, excluded } = filterFiles(FILES, ['build/**', '*.lock']);
  const material = buildPrMaterial({ files: reviewed, maxDiffChars: 0, reviewedRepoRoot: REPO_ROOT, excluded });

  // Naming the PATHS, not only the patterns, is the contract: a predicate about a file the model was
  // never shown asks it to infer from an absence, and that measurably lost — delivered verbatim to all
  // 15 spawns of a real run, the patterns-only note still drew the finding it forbade.
  test('the worker prompt names the withheld paths as changed, plus the patterns and the count', () => {
    const prompt = material.buildWorkerPrompt('code — src/a.js', TOOL_NAMES, { assigned: ['src/a.js'], read: ['src/a.js'] });
    assert.match(prompt, /Withheld from this diff — changed in this pull request:\*\* build\/out\.js, deps\.lock/);
    assert.match(prompt, /These 2 file\(s\) are part of this change and were modified by it/);
    assert.match(prompt, /EXCLUDE_PATTERNS \(build\/\*\*, \*\.lock\) removed them from your view/);
  });

  // The escape route the model actually took: it had read the repo's own rule demanding these files
  // change, and a note that only forbade the conclusion lost to it. The claim is not that the files are
  // fine — it is that compliance is unobservable from this material, in either direction.
  test('the worker prompt forecloses a repo rule about the withheld files, and is not a route back to reading them', () => {
    const prompt = material.buildWorkerPrompt('code — src/a.js', TOOL_NAMES, { assigned: ['src/a.js'], read: ['src/a.js'] });
    assert.match(prompt, /holds equally for a repository rule you have read requiring that they change/);
    assert.match(prompt, /cannot check compliance in either direction/);
    assert.match(prompt, /Do not read these paths, and record no finding that rests on one of them/);
  });

  // Bounded: this list is paid on every engine spawn, so a PR excluding a large vendored tree must not
  // inflate it — and a truncated list that lied about its own length would be the same withheld-
  // information defect one level down.
  test('a large withheld set is capped, and says how many it did not name', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ filename: `build/f${i}.js`, status: 'modified', patch: '@@ -1,1 +1,1 @@\n+x' }));
    const { reviewed, excluded } = filterFiles([...FILES, ...many], ['build/**']);
    const prompt = buildPrMaterial({ files: stamp(reviewed), maxDiffChars: 0, reviewedRepoRoot: REPO_ROOT, excluded })
      .buildWorkerPrompt('code', TOOL_NAMES, { assigned: ['src/a.js'], read: ['src/a.js'] });
    assert.match(prompt, /\(and 6 more\)/);          // 1 build/out.js + 25 = 26 withheld, 20 named
    assert.match(prompt, /These 26 file\(s\) are part of this change/);
    assert.ok(!prompt.includes('build/f24.js'), 'the cap did not bound the list');
  });

  // A convergence sweep is a fresh hunt over the same material, so it needs the same confession —
  // otherwise the false finding simply reappears one pass later.
  test('a convergence sweep prompt carries it too', () => {
    const priorFindings = [{ path: 'src/a.js', line: 1, body: 'something', severity: 3 }];
    const prompt = material.buildWorkerPrompt('code — src/a.js', TOOL_NAMES, { assigned: ['src/a.js'], read: ['src/a.js'] }, priorFindings);
    assert.match(prompt, /THIS IS A CONVERGENCE SWEEP/);
    assert.match(prompt, /Withheld from this diff — changed in this pull request:\*\* build\/out\.js, deps\.lock/);
  });
});

// A withheld path surviving into a scope would reach buildReviewInput's scopeFiles and render as "Read
// the complete content of THESE files" — the literal opposite of the same prompt's "Do not read these
// paths". The partition is computed from the files that SURVIVED the filter, so a withheld path cannot
// be assigned at all: the guarantee is the producer's input type, not a strip downstream.
// [LAW:types-are-the-program] This proves it is reached end to end — material → plan → worker prompt.
describe('a withheld path is never a read target — the partition is over what survived the filter', () => {
  test('the worker prompt names the withheld path only in the note, never on its read-targets line', async () => {
    const { reviewed, excluded } = filterFiles(FILES, ['build/**']);
    const material = buildPrMaterial({ files: reviewed, maxDiffChars: 0, reviewedRepoRoot: REPO_ROOT, excluded });
    const workerPrompts = [];
    const adapter = {
      contextWindow: null, async produceReview({ buildPromptFor }) {
        workerPrompts.push(buildPromptFor({}));
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
      readSet: DEFAULT_READ_SET,
      log: () => {},
      sleepFn: async () => {},
    });
    assert.ok(review.plan.scopes.every(s => !s.files.includes('build/out.js')), 'the plan assigned a withheld path');
    // Anchored on the read-targets sentence specifically: the withheld NOTE names build/out.js elsewhere
    // in this same prompt on purpose, so a bare "does not include" would pass against nothing.
    for (const prompt of workerPrompts) {
      assert.match(prompt, /Withheld from this diff — changed in this pull request:\*\* build\/out\.js/);
      const readTargets = prompt.match(/this scope reads in full: (.*?)\. Skip any among them/);
      assert.ok(readTargets, 'the worker was given no read-targets line to check');
      assert.ok(!readTargets[1].includes('build/out.js'), `a withheld path is a read target: ${readTargets[1]}`);
    }
  });
});

// One renderer for every sink that shows a withheld set — the prompts, the operator log, and the plan
// boundary's warning. Two sinks rendering the same set their own way is two truncation contracts.
describe('excludedPathList — the one bounded rendering', () => {
  test('names a short list in full and adds no tail', () => {
    assert.equal(excludedPathList(['a.js', 'b.js']), 'a.js, b.js');
  });

  test('caps a long list and states the remainder rather than dropping it', () => {
    const rendered = excludedPathList(Array.from({ length: 23 }, (_, i) => `f${i}.js`));
    assert.match(rendered, /^f0\.js, /);
    assert.match(rendered, /f19\.js \(and 3 more\)$/);
    assert.ok(!rendered.includes('f20.js'));
  });
});

describe('a run that hid nothing says nothing', () => {
  const unfiltered = buildPrMaterial({ files: FILES, maxDiffChars: 0, reviewedRepoRoot: REPO_ROOT });

  test('the prompt does not mention exclusion when no patterns are configured', () => {
    assert.ok(!unfiltered.buildWorkerPrompt('all', TOOL_NAMES).includes('EXCLUDE_PATTERNS'));
  });

  test('NO_EXCLUSIONS is the same material as omitting the value', () => {
    const explicit = buildPrMaterial({ files: FILES, maxDiffChars: 0, reviewedRepoRoot: REPO_ROOT, excluded: NO_EXCLUSIONS });
    assert.equal(explicit.buildWorkerPrompt('all', TOOL_NAMES), unfiltered.buildWorkerPrompt('all', TOOL_NAMES));
  });

  // Configured-but-unmatched is the case a length-subtracting or pattern-re-globbing implementation
  // gets wrong: it would announce a filtering that never happened. Byte-identical, or it is lying.
  test('patterns that matched nothing leave the prompt byte-identical to an unconfigured run', () => {
    const { reviewed, excluded } = filterFiles(FILES, ['vendor/**']);
    const material = buildPrMaterial({ files: reviewed, maxDiffChars: 0, reviewedRepoRoot: REPO_ROOT, excluded });
    assert.equal(material.buildWorkerPrompt('all', TOOL_NAMES), unfiltered.buildWorkerPrompt('all', TOOL_NAMES));
  });
});
