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
// A file's read cost is sized as its churn here: the structure tests run at 0 (nothing to spend, nothing
// coupled), and the seam tests state their own lines. `partition` is the producer with NO seams — the
// loosely coupled change, where rules 1-4 alone decide the plan and every reads list is empty.
const sized = (paths, churn = {}) => paths.map(filename => ({ filename, churn: churn[filename] ?? 0, lines: churn[filename] ?? 0 }));
const partition = (changed, opts) => partitionByDirectory(changed, [], opts);
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
    const { scopes, context } = partition(sized(LINKS_317));
    assert.deepEqual(byName(scopes), {
      [ROOT_SCOPE_NAME]: ['go.mod', 'go.sum'],
      'internal/vendor/dolthub-driver': LINKS_317.filter(p => p.startsWith('internal/')).sort(),
    });
    assert.equal(context, 'This pull request changes 30 files in 2 areas: top-level (2 files), internal/vendor/dolthub-driver (28 files).');
  });

  test('copirate-93: src with the test that names a changed source; root with the manifest, docs, and the orphan test', () => {
    assert.deepEqual(byName(partition(sized(COPIRATE_93)).scopes), {
      src: ['src/dependency-diff.js', 'test/dependency-diff.test.js', 'src/multiscope.js', 'src/prompt.js', 'src/run.js'],
      [ROOT_SCOPE_NAME]: ['README.md', 'action.yml', 'package.json', 'test/dependency-diff-wiring.test.js'],
    });
  });

  test('cc-candybar-150: four areas; lone files walk up to the root', () => {
    assert.deepEqual(byName(partition(sized(CC_CANDYBAR_150)).scopes), {
      [ROOT_SCOPE_NAME]: ['CLAUDE.md', 'package.json', 'scripts/daemon-load-harness.ts', 'src/daemon/cache/session-usage-store.ts'],
      'src/segments': ['src/segments/metrics.ts', 'test/metrics.test.ts', 'src/segments/session.ts'],
      'src/utils': ['src/utils/claude.ts', 'src/utils/transcript-fs.ts'],
      test: ['test/session-provider.test.ts', 'test/transcript-incremental.test.ts'],
    });
  });

  test('laws-4: three directories, three scopes — the structure the scout happened to agree on in 10 of 10 replays', () => {
    const { scopes } = partition(sized(LAWS_4));
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
      const assigned = partition(changed).scopes.flatMap(s => s.files);
      assert.deepEqual([...assigned].sort(), [...paths].sort());
      assert.equal(new Set(assigned).size, assigned.length);
    });
    test(`${label}: a scope never reads a file it owns, and reads only files the change contains`, () => {
      for (const s of partition(changed).scopes) {
        assert.deepEqual(s.reads.filter(f => s.files.includes(f)), []);
        assert.deepEqual(s.reads.filter(f => !paths.includes(f)), []);
      }
    });
    test(`${label}: input order is not part of the structure`, () => {
      const reversed = partition([...changed].reverse());
      assert.deepEqual(reversed, partition(changed));
    });
    test(`${label}: no scope is smaller than MIN_SCOPE_FILES unless it is the root or a part of a cut concern`, () => {
      for (const s of partition(changed).scopes) {
        assert.ok(s.files.length >= MIN_SCOPE_FILES || s.name === ROOT_SCOPE_NAME || /\d+\/\d+$/.test(s.name), `${s.name} has ${s.files.length} file(s)`);
      }
    });
  }

  test('a scope is the same stamped value a scout or a pinned plan produces: name, focus, files, reads, nothing else', () => {
    for (const s of partition(sized(COPIRATE_93)).scopes) {
      assert.deepEqual(Object.keys(s).sort(), ['files', 'focus', 'name', 'reads']);
      assert.match(s.focus, /Review the changes to .* Also read the files they import/);
      assert.deepEqual(s.reads, []);
    }
  });

  test('within a scope, a test follows the source it names; everything else is in path order', () => {
    const { scopes } = partition(sized(['src/b.js', 'test/a.test.js', 'src/a.js', 'src/c.js', 'test/c.test.js']));
    assert.deepEqual(byName(scopes), { src: ['src/a.js', 'test/a.test.js', 'src/b.js', 'src/c.js', 'test/c.test.js'] });
  });

  test('a single changed file is one root scope', () => {
    const { scopes, context } = partition(sized(['src/deep/only.js']));
    assert.deepEqual(byName(scopes), { [ROOT_SCOPE_NAME]: ['src/deep/only.js'] });
    assert.equal(context, 'This pull request changes 1 file in 1 area: top-level (1 file).');
  });

  test('a test that names an AMBIGUOUS source (two changed files share the stem) keys on its own directory', () => {
    const { scopes } = partition(sized(['a/util.js', 'b/util.js', 'test/util.test.js', 'test/other.test.js']));
    assert.deepEqual(byName(scopes), {
      [ROOT_SCOPE_NAME]: ['a/util.js', 'b/util.js'],
      test: ['test/other.test.js', 'test/util.test.js'],
    });
  });

  test('a bare-stem file in a test directory names no source: it keys on its own directory, not a same-named coincidence', () => {
    const { scopes } = partition(sized(['src/config.js', 'src/app.js', 'test/config.js', 'test/app.test.js']));
    assert.deepEqual(byName(scopes), {
      src: ['src/app.js', 'test/app.test.js', 'src/config.js'],
      [ROOT_SCOPE_NAME]: ['test/config.js'],
    });
  });

  test('a test directory anywhere in the path marks a test: a nested __tests__ file is never a source a suffixed test can name', () => {
    // Without the nested recognition, __tests__/button.js would be the "source" that button.test.js names,
    // and the real src/ui/button.js would be left unnamed.
    const { scopes } = partition(sized(['src/ui/button.js', 'src/ui/__tests__/button.js', 'e2e/button.test.js', 'src/ui/theme.js']));
    assert.deepEqual(byName(scopes), {
      'src/ui': ['src/ui/__tests__/button.js', 'src/ui/button.js', 'e2e/button.test.js', 'src/ui/theme.js'],
    });
  });

  test('minFiles is the width lever: at 1 nothing merges, at a large value everything is one root scope', () => {
    assert.equal(partition(sized(CC_CANDYBAR_150), { minFiles: 1 }).scopes.length, 6);
    assert.deepEqual(byName(partition(sized(CC_CANDYBAR_150), { minFiles: 100 }).scopes), {
      [ROOT_SCOPE_NAME]: [
        'CLAUDE.md', 'package.json', 'scripts/daemon-load-harness.ts', 'src/daemon/cache/session-usage-store.ts',
        'src/segments/metrics.ts', 'test/metrics.test.ts', 'src/segments/session.ts',
        'src/utils/claude.ts', 'src/utils/transcript-fs.ts', 'test/session-provider.test.ts', 'test/transcript-incremental.test.ts',
      ],
    });
  });

  test('an empty change is refused by name, not passed on as an empty plan', () => {
    assert.throws(() => partitionByDirectory([], []), /no changed files to partition/);
  });
});

// Rule 4 — the size dimension (zai-timing-8jk.4). Calibrated on 8jk.3: spawn ≈ 83 s × churn^0.21, the
// largest scope straggles on lopsided plans and not on even ones, and a part under ~100 lines costs a lane
// to save seconds. The frozen cases are sized from their own diffs, so these are the cuts a live run makes.
describe('partitionByDirectory — the size dimension', () => {
  const LINKS_CHURN = churnOf('links-317-dolt-telemetry');
  const DRIVER = 'internal/vendor/dolthub-driver';
  const literal = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

  test('links-317: the 5360-line driver against a 27-line root is lopsided and over the cap, so it is cut as fine as the cap and the floor allow — eight parts', () => {
    const { scopes, context } = partition(sized(LINKS_317, LINKS_CHURN));
    const parts = scopes.slice(1);
    assert.deepEqual(scopes.map(s => s.name), [ROOT_SCOPE_NAME, ...parts.map((_, i) => `${DRIVER} ${i + 1}/8`)]);
    assert.match(context, /^This pull request changes 30 files in 9 areas: top-level \(2 files\), /);
    assert.deepEqual(parts.flatMap(p => p.files).sort(), LINKS_317.filter(p => p.startsWith(DRIVER)).sort());
    // Every part clears the floor; the 1526-line go.sum is a part of its own (a single file is never cut).
    for (const part of parts) assert.ok(scopeChurn(part, LINKS_CHURN) >= SCOPE_CHURN_FLOOR, part.name);
    assert.deepEqual(parts.find(p => p.files.length === 1 && p.files[0].endsWith('/go.sum')).files, [`${DRIVER}/go.sum`]);
    // With no seams handed in, no part reads beyond what it owns: the whole-concern second read is gone.
    assert.deepEqual(scopes.map(s => s.reads), scopes.map(() => []));
  });

  test("a scope's focus names the files the change couples to it, says the seam is its job, and that a defect seen there is recorded", () => {
    const churn = { 'src/a.js': 20, 'src/b.js': 20, 'lib/c.js': 20, 'lib/d.js': 20 };
    const { scopes } = partitionByDirectory(sized(Object.keys(churn), churn), [{ a: 'lib/c.js', b: 'src/a.js', weight: 1 }]);
    const src = scopes.find(s => s.name === 'src');
    assert.deepEqual(src.reads, ['lib/c.js']);
    assert.match(src.focus, new RegExp(`^Review the changes to src/a\\.js, src/b\\.js in src\\.`));
    assert.match(src.focus, /The change couples these files to yours — lib\/c\.js — and other scopes own them\./);
    assert.match(src.focus, /Read them in full too: the seam between your files and theirs is yours to check, and a defect you notice in one of them is recorded, never left for the worker that owns it\./);
    assert.match(src.focus, /Also read the files they import and check each connection/);
    // The seam is unordered: lib reads src/a.js by the same seam, and its focus says so.
    assert.deepEqual(scopes.find(s => s.name === 'lib').reads, ['src/a.js']);
    assert.match(scopes.find(s => s.name === 'lib').focus, /The change couples these files to yours — src\/a\.js —/);
  });

  test('links-317: a test never parts from the source it names, even across the cut', () => {
    const { scopes } = partition(sized(LINKS_317, LINKS_CHURN));
    const owner = new Map(scopes.flatMap(s => s.files.map(f => [f, s.name])));
    for (const stem of ['data_source', 'errors', 'parse_dsn', 'query_splitter']) {
      assert.equal(owner.get(`${DRIVER}/${stem}_test.go`), owner.get(`${DRIVER}/${stem}.go`), stem);
    }
  });

  test('copirate-93: lopsided and over the cap, but the floor bites — the source+test unit is 554 lines and the rest 78, so src stays whole', () => {
    const churn = churnOf('copirate-93-dependency-diff');
    const { scopes } = partition(sized(COPIRATE_93, churn));
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
    const { scopes } = partition(sized(CC_CANDYBAR_150, churn));
    const churns = scopes.map(s => scopeChurn(s, churn)).sort((a, b) => b - a);
    assert.ok(churns[0] >= SCOPE_CHURN_CAP && churns[0] < LOPSIDED_RATIO * churns[1], JSON.stringify(churns));
    assert.deepEqual(scopes.map(s => s.reads), [[], [], [], []]);
    assert.deepEqual(byName(scopes), byName(partition(sized(CC_CANDYBAR_150)).scopes));
  });

  test('laws-4: lopsided (326 vs 47 lines) but under the cap, so nothing is cut', () => {
    const churn = churnOf('laws-4-eval-tasks');
    const { scopes } = partition(sized(LAWS_4, churn));
    const churns = scopes.map(s => scopeChurn(s, churn)).sort((a, b) => b - a);
    assert.ok(churns[0] >= LOPSIDED_RATIO * churns[1] && churns[0] < SCOPE_CHURN_CAP, JSON.stringify(churns));
    assert.deepEqual(scopes.map(s => s.reads), [[], [], []]);
  });

  test('the cap is a fit, not a trigger: a lopsided group of exactly SCOPE_CHURN_CAP lines fills one part and stays whole; one line more is halved', () => {
    const at = { 'src/a.js': 180, 'src/b.js': SCOPE_CHURN_CAP - 180 };
    assert.deepEqual(partition(sized(['src/a.js', 'src/b.js'], at)).scopes.map(s => [s.name, s.reads]), [['src', []]]);
    const over = { 'src/a.js': 180, 'src/b.js': SCOPE_CHURN_CAP - 180 + 1 };
    assert.deepEqual(partition(sized(['src/a.js', 'src/b.js'], over)).scopes.map(s => s.name), ['src 1/2', 'src 2/2']);
  });

  test('a single-scope change is lopsided against nothing: over the cap it is halved, and the one lane becomes two', () => {
    const { scopes } = partition(sized(['src/a.js', 'src/b.js'], { 'src/a.js': 300, 'src/b.js': 300 }));
    assert.deepEqual(scopes.map(s => [s.name, s.files, s.reads]), [
      ['src 1/2', ['src/a.js'], []],
      ['src 2/2', ['src/b.js'], []],
    ]);
  });

  test('the cut goes as fine as the cap asks: a part reads its seams, not the whole group, so the read budget no longer bounds the part count', () => {
    // A 3000-line group beside 60 lines: nine cap-sized parts (the 8jk.4 rule allowed two, because each
    // part then read the whole group).
    const big = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].map(n => `src/${n}.js`);
    const churn = Object.fromEntries([...big.map(f => [f, 300]), ['lib/x.js', 30], ['lib/y.js', 30]]);
    const { scopes } = partition(sized(Object.keys(churn), churn));
    assert.deepEqual(scopes.map(s => s.name), ['lib', ...Array.from({ length: 9 }, (_, i) => `src ${i + 1}/9`)]);
    for (const s of scopes.slice(1)) assert.ok(s.files.reduce((a, f) => a + churn[f], 0) >= SCOPE_CHURN_FLOOR, s.name);
  });

  test('a companion unit is never parted: two source+test pairs cut as two pairs', () => {
    const churn = { 'src/a.js': 300, 'test/a.test.js': 300, 'src/b.js': 300, 'test/b.test.js': 300 };
    const { scopes } = partition(sized(Object.keys(churn), churn));
    assert.deepEqual(scopes.map(s => [s.name, s.files]), [
      ['src 1/2', ['src/a.js', 'test/a.test.js']],
      ['src 2/2', ['src/b.js', 'test/b.test.js']],
    ]);
  });

  test('the floor: a single file is the indivisible unit — one 900-line file beside crumbs is never cut', () => {
    const churn = { 'src/big.js': 900, 'src/x.js': 10, 'src/y.js': 10, 'src/z.js': 10 };
    const { scopes } = partition(sized(Object.keys(churn), churn));
    assert.deepEqual(scopes.map(s => [s.name, s.reads]), [['src', []]]);
  });

  test('the dials carry the numbers 8jk.3 measured', () => {
    assert.deepEqual([LOPSIDED_RATIO, SCOPE_CHURN_CAP, SCOPE_CHURN_FLOOR], [2, 360, 100]);
  });
});

// Rule 5 — the seam reads (zai-timing-8jk.5). The budget is one further read of the changed set, in
// lines; candidates are spent heaviest coupling first; a change with no seams spends nothing; a seam the
// budget cannot cover is named in the plan's context.
describe('partitionByDirectory — the seam reads', () => {
  const FOUR = { 'src/a.js': 100, 'src/b.js': 100, 'lib/c.js': 100, 'lib/d.js': 100 };
  const readsOf = (scopes) => Object.fromEntries(scopes.map(s => [s.name, s.reads]));

  test('a loosely coupled change spends nothing: no seams, no reads, no note', () => {
    const { scopes, context } = partitionByDirectory(sized(Object.keys(FOUR), FOUR), []);
    assert.deepEqual(readsOf(scopes), { lib: [], src: [] });
    assert.doesNotMatch(context, /read ceiling/);
  });

  test('a seam between two scopes gives each a second read of the other side, and a seam inside one scope gives nothing', () => {
    const seams = [{ a: 'lib/c.js', b: 'src/a.js', weight: 2 }, { a: 'src/a.js', b: 'src/b.js', weight: 5 }];
    const { scopes } = partitionByDirectory(sized(Object.keys(FOUR), FOUR), seams);
    assert.deepEqual(readsOf(scopes), { lib: ['src/a.js'], src: ['lib/c.js'] });
  });

  test("reads are handed out heaviest coupling first, and a scope's coupling to a file sums the seams of every file it owns", () => {
    const seams = [
      { a: 'lib/c.js', b: 'src/a.js', weight: 1 }, { a: 'lib/d.js', b: 'src/a.js', weight: 1 }, // src ↔ a.js: coupling 2
      { a: 'lib/c.js', b: 'src/b.js', weight: 1.5 },                                            // src ↔ b.js... via c.js: lib ↔ b.js 1.5
    ];
    const { scopes } = partitionByDirectory(sized(Object.keys(FOUR), FOUR), seams);
    // lib's candidates: src/a.js (1+1 = 2) then src/b.js (1.5); src's: lib/c.js (1+1.5 = 2.5) then lib/d.js (1).
    assert.deepEqual(readsOf(scopes), { lib: ['src/a.js', 'src/b.js'], src: ['lib/c.js', 'lib/d.js'] });
  });

  test('the budget is one further read of the changed set, in lines: aggregate reads never exceed it, and what it cannot cover is named', () => {
    // Four directories of two 50-line files (400 lines, so a 400-line budget); every x.js couples to
    // every other, asking for 4 scopes × 3 reads of 50 = 600. The heaviest eight fit; four are named.
    const dirs = ['a', 'b', 'c', 'd'];
    const lines = Object.fromEntries(dirs.flatMap(d => [[`${d}/x.js`, 50], [`${d}/y.js`, 50]]));
    const seams = [];
    for (let i = 0; i < dirs.length; i++) for (let j = i + 1; j < dirs.length; j++) seams.push({ a: `${dirs[i]}/x.js`, b: `${dirs[j]}/x.js`, weight: 6 - i - j });
    const { scopes, context } = partitionByDirectory(sized(Object.keys(lines), lines), seams);
    const spent = scopes.reduce((sum, s) => sum + s.reads.reduce((a, f) => a + lines[f], 0), 0);
    assert.equal(spent, 400);
    // a↔b weighs 5, a↔c 4, then a↔d, b↔c 3, b↔d 2, c↔d 1: the eight reads are the heaviest eight candidates.
    assert.deepEqual(readsOf(scopes), { a: ['b/x.js', 'c/x.js', 'd/x.js'], b: ['a/x.js', 'c/x.js'], c: ['a/x.js', 'b/x.js'], d: ['a/x.js'] });
    assert.match(context, /The read ceiling \(one further read of the changed set, 400 lines\) covered 8 of 12 coupled reads; 4 left unread beyond their owner, heaviest first: d\/x\.js \(for b\), b\/x\.js \(for d\), d\/x\.js \(for c\), c\/x\.js \(for d\)\.$/);
  });

  test('a read that no longer fits is passed over for a lighter one that does: the budget is spent, not stopped at', () => {
    // 540 lines of change, so a 540-line budget. Candidates by coupling: src ↔ lib/big.js 8 (300 lines),
    // lib ↔ src/b.js 7 (100), lib ↔ src/a.js 5 (100), src ↔ lib/small.js 4 (20) — 520 spent — then
    // doc ↔ lib/big.js 2 (300: does not fit, passed over) and lib ↔ doc/x.md 2 (10: fits).
    const lines = { 'src/a.js': 100, 'src/b.js': 100, 'lib/big.js': 300, 'lib/small.js': 20, 'doc/x.md': 10, 'doc/y.md': 10 };
    const seams = [
      { a: 'lib/big.js', b: 'src/a.js', weight: 5 }, { a: 'lib/small.js', b: 'src/b.js', weight: 4 },
      { a: 'lib/big.js', b: 'src/b.js', weight: 3 }, { a: 'doc/x.md', b: 'lib/big.js', weight: 2 },
    ];
    const { scopes, context } = partitionByDirectory(sized(Object.keys(lines), lines), seams);
    assert.deepEqual(readsOf(scopes), { doc: [], lib: ['src/b.js', 'src/a.js', 'doc/x.md'], src: ['lib/big.js', 'lib/small.js'] });
    assert.match(context, /covered 5 of 6 coupled reads; 1 left unread beyond their owner, heaviest first: lib\/big\.js \(for doc\)\.$/);
  });

  test('a scope never reads a file it owns, whatever the seams say, and reads are listed in coupling order', () => {
    const seams = [{ a: 'src/a.js', b: 'src/b.js', weight: 9 }, { a: 'lib/d.js', b: 'src/b.js', weight: 1 }, { a: 'lib/c.js', b: 'src/a.js', weight: 2 }];
    const { scopes } = partitionByDirectory(sized(Object.keys(FOUR), FOUR), seams);
    assert.deepEqual(readsOf(scopes), { lib: ['src/a.js', 'src/b.js'], src: ['lib/c.js', 'lib/d.js'] });
  });
});
