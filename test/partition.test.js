'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { partitionByDirectory, MIN_SCOPE_FILES, LOPSIDED_RATIO, SCOPE_CHURN_CAP, SCOPE_CHURN_FLOOR, ROOT_SCOPE_NAME } = require('../src/partition');
const { parseUnifiedDiff, fileChurn } = require('../src/diff');

// The four frozen golden cases' changed-file lists (eval/cases/*/change.diff, post EXCLUDE_PATTERNS).
// These are the inputs the LLM scout re-rolled into 1-5 scopes per replay; the partition must give each
// exactly one structure, and this file states which. [LAW:verifiable-goals]
// The structure tests size every file at 0 churn — rule 4 never fires, so they state rules 1-3 alone.
// The size tests size the same lists from the frozen diffs themselves (churnOf), so the numbers rule 4
// acts on are the ones a real run of that case computes. [LAW:one-source-of-truth]
const sized = (paths, churn = {}) => paths.map(filename => ({ filename, churn: churn[filename] ?? 0 }));
const churnOf = (caseName) => {
  const diff = fs.readFileSync(path.join(__dirname, '..', 'eval', 'cases', caseName, 'change.diff'), 'utf8');
  return Object.fromEntries(parseUnifiedDiff(diff).files.map(f => [f.filename, fileChurn(f)]));
};
const scopeChurn = (scope, churn) => scope.files.reduce((sum, f) => sum + churn[f], 0);
const LINKS_317 = [
  'go.mod', 'go.sum',
  ...['.gitignore', 'LICENSE', 'README.lit-patch.md', 'README.md', 'config.go', 'conn.go', 'connector.go',
    'data_source.go', 'data_source_test.go', 'driver.go', 'errors.go', 'errors_test.go', 'example/main.go',
    'go.mod', 'go.sum', 'gorm_test.go', 'openconnector_retry_test.go', 'parse_dsn.go', 'parse_dsn_test.go',
    'query_splitter.go', 'query_splitter_test.go', 'relative_path_test.go', 'result.go', 'retryable_open_err.go',
    'rows.go', 'smoke_test.go', 'statement.go', 'transaction.go'].map(f => `internal/vendor/dolthub-driver/${f}`),
];
const COPIRATE_93 = [
  'README.md', 'action.yml', 'package.json',
  'src/dependency-diff.js', 'src/multiscope.js', 'src/prompt.js', 'src/run.js',
  'test/dependency-diff-wiring.test.js', 'test/dependency-diff.test.js',
];
const CC_CANDYBAR_150 = [
  'CLAUDE.md', 'package.json', 'scripts/daemon-load-harness.ts',
  'src/daemon/cache/session-usage-store.ts', 'src/segments/metrics.ts', 'src/segments/session.ts',
  'src/utils/claude.ts', 'src/utils/transcript-fs.ts',
  'test/metrics.test.ts', 'test/session-provider.test.ts', 'test/transcript-incremental.test.ts',
];
const LAWS_4 = [
  'evals/tasks/README.md', 'evals/tasks/check-task.sh', 'evals/tasks/lib.sh', 'evals/tasks/validate-task.sh', 'evals/tasks/verify-tasks.sh',
  ...['check.sh', 'manifest.sh', 'prompt.md', 'setup.sh'].map(f => `evals/tasks/go-template-add-fix/${f}`),
  ...['check.sh', 'manifest.sh', 'prompt.md', 'setup.sh'].map(f => `evals/tasks/laws-scripts-parse/${f}`),
];

const byName = (scopes) => Object.fromEntries(scopes.map(s => [s.name, s.files]));

describe('partitionByDirectory — one structure per input', () => {
  test('links-317: the dependency bump and the vendored driver, the example dir folded into the driver', () => {
    const { scopes, context } = partitionByDirectory(sized(LINKS_317));
    assert.deepEqual(byName(scopes), {
      [ROOT_SCOPE_NAME]: ['go.mod', 'go.sum'],
      'internal/vendor/dolthub-driver': LINKS_317.filter(p => p.startsWith('internal/')).sort(),
    });
    assert.equal(context, 'This pull request changes 30 files in 2 areas: top-level (2 files), internal/vendor/dolthub-driver (28 files).');
  });

  test('copirate-93: src with the test that names a changed source; root with the manifest, docs, and the orphan test', () => {
    assert.deepEqual(byName(partitionByDirectory(sized(COPIRATE_93)).scopes), {
      src: ['src/dependency-diff.js', 'test/dependency-diff.test.js', 'src/multiscope.js', 'src/prompt.js', 'src/run.js'],
      [ROOT_SCOPE_NAME]: ['README.md', 'action.yml', 'package.json', 'test/dependency-diff-wiring.test.js'],
    });
  });

  test('cc-candybar-150: four areas; lone files walk up to the root', () => {
    assert.deepEqual(byName(partitionByDirectory(sized(CC_CANDYBAR_150)).scopes), {
      [ROOT_SCOPE_NAME]: ['CLAUDE.md', 'package.json', 'scripts/daemon-load-harness.ts', 'src/daemon/cache/session-usage-store.ts'],
      'src/segments': ['src/segments/metrics.ts', 'test/metrics.test.ts', 'src/segments/session.ts'],
      'src/utils': ['src/utils/claude.ts', 'src/utils/transcript-fs.ts'],
      test: ['test/session-provider.test.ts', 'test/transcript-incremental.test.ts'],
    });
  });

  test('laws-4: three directories, three scopes — the structure the scout happened to agree on in 10 of 10 replays', () => {
    const { scopes } = partitionByDirectory(sized(LAWS_4));
    assert.deepEqual(scopes.map(s => [s.name, s.files.length]), [
      ['evals/tasks', 5], ['evals/tasks/go-template-add-fix', 4], ['evals/tasks/laws-scripts-parse', 4],
    ]);
  });
});

describe('partitionByDirectory — the theorem every output satisfies', () => {
  // Both unsized (rules 1-3 alone) and sized from the frozen diffs (rule 4 live): the theorem holds
  // whether or not a cut fires. The sized links-317 is the one input the cut fires on.
  const CASES = {
    LINKS_317: sized(LINKS_317), COPIRATE_93: sized(COPIRATE_93), CC_CANDYBAR_150: sized(CC_CANDYBAR_150), LAWS_4: sized(LAWS_4),
    'LINKS_317 sized': sized(LINKS_317, churnOf('links-317-dolt-telemetry')),
    'COPIRATE_93 sized': sized(COPIRATE_93, churnOf('copirate-93-dependency-diff')),
    'CC_CANDYBAR_150 sized': sized(CC_CANDYBAR_150, churnOf('cc-candybar-150-transcript-perf')),
    'LAWS_4 sized': sized(LAWS_4, churnOf('laws-4-eval-tasks')),
  };
  for (const [label, changed] of Object.entries(CASES)) {
    const paths = changed.map(f => f.filename);
    test(`${label}: every changed path is OWNED by exactly one scope`, () => {
      const assigned = partitionByDirectory(changed).scopes.flatMap(s => s.files);
      assert.deepEqual([...assigned].sort(), [...paths].sort());
      assert.equal(new Set(assigned).size, assigned.length);
    });
    test(`${label}: a scope never reads a file it owns, and reads only files the change contains`, () => {
      for (const s of partitionByDirectory(changed).scopes) {
        assert.deepEqual(s.reads.filter(f => s.files.includes(f)), []);
        assert.deepEqual(s.reads.filter(f => !paths.includes(f)), []);
      }
    });
    test(`${label}: input order is not part of the structure`, () => {
      const reversed = partitionByDirectory([...changed].reverse());
      assert.deepEqual(reversed, partitionByDirectory(changed));
    });
    test(`${label}: no scope is smaller than MIN_SCOPE_FILES unless it is the root or a part of a cut concern`, () => {
      for (const s of partitionByDirectory(changed).scopes) {
        assert.ok(s.files.length >= MIN_SCOPE_FILES || s.name === ROOT_SCOPE_NAME || s.reads.length > 0, `${s.name} has ${s.files.length} file(s)`);
      }
    });
  }

  test('a scope is the same stamped value a scout or a pinned plan produces: name, focus, files, reads, nothing else', () => {
    for (const s of partitionByDirectory(sized(COPIRATE_93)).scopes) {
      assert.deepEqual(Object.keys(s).sort(), ['files', 'focus', 'name', 'reads']);
      assert.match(s.focus, /Review the changes to .* Also read the files they import/);
      assert.deepEqual(s.reads, []);
    }
  });

  test('within a scope, a test follows the source it names; everything else is in path order', () => {
    const { scopes } = partitionByDirectory(sized(['src/b.js', 'test/a.test.js', 'src/a.js', 'src/c.js', 'test/c.test.js']));
    assert.deepEqual(byName(scopes), { src: ['src/a.js', 'test/a.test.js', 'src/b.js', 'src/c.js', 'test/c.test.js'] });
  });

  test('a single changed file is one root scope', () => {
    const { scopes, context } = partitionByDirectory(sized(['src/deep/only.js']));
    assert.deepEqual(byName(scopes), { [ROOT_SCOPE_NAME]: ['src/deep/only.js'] });
    assert.equal(context, 'This pull request changes 1 file in 1 area: top-level (1 file).');
  });

  test('a test that names an AMBIGUOUS source (two changed files share the stem) keys on its own directory', () => {
    const { scopes } = partitionByDirectory(sized(['a/util.js', 'b/util.js', 'test/util.test.js', 'test/other.test.js']));
    assert.deepEqual(byName(scopes), {
      [ROOT_SCOPE_NAME]: ['a/util.js', 'b/util.js'],
      test: ['test/other.test.js', 'test/util.test.js'],
    });
  });

  test('a bare-stem file in a test directory names no source: it keys on its own directory, not a same-named coincidence', () => {
    const { scopes } = partitionByDirectory(sized(['src/config.js', 'src/app.js', 'test/config.js', 'test/app.test.js']));
    assert.deepEqual(byName(scopes), {
      src: ['src/app.js', 'test/app.test.js', 'src/config.js'],
      [ROOT_SCOPE_NAME]: ['test/config.js'],
    });
  });

  test('a test directory anywhere in the path marks a test: a nested __tests__ file is never a source a suffixed test can name', () => {
    // Without the nested recognition, __tests__/button.js would be the "source" that button.test.js names,
    // and the real src/ui/button.js would be left unnamed.
    const { scopes } = partitionByDirectory(sized(['src/ui/button.js', 'src/ui/__tests__/button.js', 'e2e/button.test.js', 'src/ui/theme.js']));
    assert.deepEqual(byName(scopes), {
      'src/ui': ['src/ui/__tests__/button.js', 'src/ui/button.js', 'e2e/button.test.js', 'src/ui/theme.js'],
    });
  });

  test('minFiles is the width lever: at 1 nothing merges, at a large value everything is one root scope', () => {
    assert.equal(partitionByDirectory(sized(CC_CANDYBAR_150), { minFiles: 1 }).scopes.length, 6);
    assert.deepEqual(byName(partitionByDirectory(sized(CC_CANDYBAR_150), { minFiles: 100 }).scopes), {
      [ROOT_SCOPE_NAME]: [
        'CLAUDE.md', 'package.json', 'scripts/daemon-load-harness.ts', 'src/daemon/cache/session-usage-store.ts',
        'src/segments/metrics.ts', 'test/metrics.test.ts', 'src/segments/session.ts',
        'src/utils/claude.ts', 'src/utils/transcript-fs.ts', 'test/session-provider.test.ts', 'test/transcript-incremental.test.ts',
      ],
    });
  });

  test('an empty change is refused by name, not passed on as an empty plan', () => {
    assert.throws(() => partitionByDirectory([]), /no changed files to partition/);
  });
});

// Rule 4 — the size dimension (zai-timing-8jk.4). Calibrated on 8jk.3: spawn ≈ 83 s × churn^0.21, the
// largest scope straggles on lopsided plans and not on even ones, and a part under ~100 lines costs a lane
// to save seconds. The frozen cases are sized from their own diffs, so these are the cuts a live run makes.
describe('partitionByDirectory — the size dimension', () => {
  const LINKS_CHURN = churnOf('links-317-dolt-telemetry');
  const DRIVER = 'internal/vendor/dolthub-driver';
  const literal = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

  test('links-317: the 5360-line driver against a 27-line root is lopsided and over the cap, so it is halved', () => {
    const { scopes, context } = partitionByDirectory(sized(LINKS_317, LINKS_CHURN));
    assert.deepEqual(scopes.map(s => s.name), [ROOT_SCOPE_NAME, `${DRIVER} 1/2`, `${DRIVER} 2/2`]);
    assert.equal(context, `This pull request changes 30 files in 3 areas: top-level (2 files), ${DRIVER} 1/2 (15 files), ${DRIVER} 2/2 (13 files).`);
    const [root, first, second] = scopes;
    // Each part owns its half and READS the other's — the concern is seen whole by both workers.
    assert.deepEqual(first.reads, second.files);
    assert.deepEqual(second.reads, first.files);
    assert.deepEqual([...first.files, ...second.files].sort(), LINKS_317.filter(p => p.startsWith(DRIVER)).sort());
    // Near-equal by churn as far as whole files allow (go.sum alone is 1526 lines); both clear the floor.
    assert.deepEqual([scopeChurn(first, LINKS_CHURN), scopeChurn(second, LINKS_CHURN)], [3155, 2205]);
    assert.ok(Math.min(scopeChurn(first, LINKS_CHURN), scopeChurn(second, LINKS_CHURN)) >= SCOPE_CHURN_FLOOR);
    // The straggler the cut is for was ONE scope of 5360 lines; the root is untouched.
    assert.deepEqual(root.reads, []);
  });

  test("links-317: a part's focus names the sibling files, says the seam is its job, and that a defect seen there is recorded", () => {
    const { scopes } = partitionByDirectory(sized(LINKS_317, LINKS_CHURN));
    const [, first] = scopes;
    assert.match(first.focus, new RegExp(`^Review the changes to ${literal(first.files.join(', '))} in ${literal(DRIVER)}\\.`));
    assert.match(first.focus, new RegExp(`This concern is reviewed in parts for size; the rest of it — ${literal(first.reads.join(', '))} — is owned elsewhere in the plan\\.`));
    assert.match(first.focus, /Read those files in full too: the seam between your files and theirs is yours to check, and a defect you notice in one of them is recorded, never left for the worker that owns it\./);
    assert.match(first.focus, /Also read the files they import and check each connection/);
  });

  test('links-317: a test never parts from the source it names, even across the cut', () => {
    const { scopes } = partitionByDirectory(sized(LINKS_317, LINKS_CHURN));
    const owner = new Map(scopes.flatMap(s => s.files.map(f => [f, s.name])));
    for (const stem of ['data_source', 'errors', 'parse_dsn', 'query_splitter']) {
      assert.equal(owner.get(`${DRIVER}/${stem}_test.go`), owner.get(`${DRIVER}/${stem}.go`), stem);
    }
  });

  test('copirate-93: lopsided and over the cap, but the floor bites — the source+test unit is 554 lines and the rest 78, so src stays whole', () => {
    const churn = churnOf('copirate-93-dependency-diff');
    const { scopes } = partitionByDirectory(sized(COPIRATE_93, churn));
    assert.deepEqual(scopes.map(s => [s.name, s.reads.length]), [[ROOT_SCOPE_NAME, 0], ['src', 0]]);
    const src = scopes.find(s => s.name === 'src');
    assert.ok(scopeChurn(src, churn) >= SCOPE_CHURN_CAP);
    assert.ok(scopeChurn(src, churn) >= LOPSIDED_RATIO * scopeChurn(scopes[0], churn));
    assert.equal(churn['src/dependency-diff.js'] + churn['test/dependency-diff.test.js'], 554);
    assert.equal(scopeChurn(src, churn) - 554, 78);
    assert.ok(78 < SCOPE_CHURN_FLOOR);
  });

  test('cc-candybar-150: the largest scope is over the cap but the plan is EVEN (793 vs 410 lines), so nothing is cut', () => {
    const churn = churnOf('cc-candybar-150-transcript-perf');
    const { scopes } = partitionByDirectory(sized(CC_CANDYBAR_150, churn));
    const churns = scopes.map(s => scopeChurn(s, churn)).sort((a, b) => b - a);
    assert.ok(churns[0] >= SCOPE_CHURN_CAP && churns[0] < LOPSIDED_RATIO * churns[1], JSON.stringify(churns));
    assert.deepEqual(scopes.map(s => s.reads), [[], [], [], []]);
    assert.deepEqual(byName(scopes), byName(partitionByDirectory(sized(CC_CANDYBAR_150)).scopes));
  });

  test('laws-4: lopsided (326 vs 47 lines) but under the cap, so nothing is cut', () => {
    const churn = churnOf('laws-4-eval-tasks');
    const { scopes } = partitionByDirectory(sized(LAWS_4, churn));
    const churns = scopes.map(s => scopeChurn(s, churn)).sort((a, b) => b - a);
    assert.ok(churns[0] >= LOPSIDED_RATIO * churns[1] && churns[0] < SCOPE_CHURN_CAP, JSON.stringify(churns));
    assert.deepEqual(scopes.map(s => s.reads), [[], [], []]);
  });

  test('a single-scope change is lopsided against nothing: over the cap it is halved, and the one lane becomes two', () => {
    const { scopes } = partitionByDirectory(sized(['src/a.js', 'src/b.js'], { 'src/a.js': 300, 'src/b.js': 300 }));
    assert.deepEqual(scopes.map(s => [s.name, s.files, s.reads]), [
      ['src 1/2', ['src/a.js'], ['src/b.js']],
      ['src 2/2', ['src/b.js'], ['src/a.js']],
    ]);
  });

  test('the part count is bounded by the read budget: the extra reads never exceed the changed set', () => {
    // A 3000-line group beside 60 lines: the cap alone would ask for 9 parts, each reading all 3000 —
    // the budget allows 1 + floor(3060/3000) = 2.
    const big = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].map(n => `src/${n}.js`);
    const churn = Object.fromEntries([...big.map(f => [f, 300]), ['lib/x.js', 30], ['lib/y.js', 30]]);
    const { scopes } = partitionByDirectory(sized(Object.keys(churn), churn));
    assert.deepEqual(scopes.map(s => s.name), ['lib', 'src 1/2', 'src 2/2']);
    const extraReads = scopes.reduce((sum, s) => sum + s.reads.reduce((a, f) => a + churn[f], 0), 0);
    assert.ok(extraReads <= 3060, `extra reads ${extraReads}`);
    // The same 1000-line group in a 3000-line change may be cut three ways (1 + floor(3000/1000)).
    const wide = Object.fromEntries([...['src/a.js', 'src/b.js', 'src/c.js', 'src/d.js'].map(f => [f, 250]),
      ...[1, 2, 3, 4, 5].flatMap(n => [[`d${n}/x.js`, 200], [`d${n}/y.js`, 200]])]);
    const three = partitionByDirectory(sized(Object.keys(wide), wide)).scopes.filter(s => s.name.startsWith('src'));
    assert.deepEqual(three.map(s => [s.name, s.files]), [
      ['src 1/3', ['src/a.js']], ['src 2/3', ['src/b.js', 'src/c.js']], ['src 3/3', ['src/d.js']],
    ]);
    for (const part of three) assert.deepEqual(part.reads, three.filter(p => p !== part).flatMap(p => p.files));
  });

  test('a companion unit is never parted: two source+test pairs cut as two pairs', () => {
    const churn = { 'src/a.js': 300, 'test/a.test.js': 300, 'src/b.js': 300, 'test/b.test.js': 300 };
    const { scopes } = partitionByDirectory(sized(Object.keys(churn), churn));
    assert.deepEqual(scopes.map(s => [s.name, s.files]), [
      ['src 1/2', ['src/a.js', 'test/a.test.js']],
      ['src 2/2', ['src/b.js', 'test/b.test.js']],
    ]);
  });

  test('the floor: a single file is the indivisible unit — one 900-line file beside crumbs is never cut', () => {
    const churn = { 'src/big.js': 900, 'src/x.js': 10, 'src/y.js': 10, 'src/z.js': 10 };
    const { scopes } = partitionByDirectory(sized(Object.keys(churn), churn));
    assert.deepEqual(scopes.map(s => [s.name, s.reads]), [['src', []]]);
  });

  test('the dials carry the numbers 8jk.3 measured', () => {
    assert.deepEqual([LOPSIDED_RATIO, SCOPE_CHURN_CAP, SCOPE_CHURN_FLOOR], [2, 360, 100]);
  });
});
