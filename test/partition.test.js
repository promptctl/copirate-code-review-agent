'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { partitionByDirectory, MIN_SCOPE_FILES, ROOT_SCOPE_NAME } = require('../src/partition');

// The four frozen golden cases' changed-file lists (eval/cases/*/change.diff, post EXCLUDE_PATTERNS).
// These are the inputs the LLM scout re-rolled into 1-5 scopes per replay; the partition must give each
// exactly one structure, and this file states which. [LAW:verifiable-goals]
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
    const { scopes, context } = partitionByDirectory(LINKS_317);
    assert.deepEqual(byName(scopes), {
      [ROOT_SCOPE_NAME]: ['go.mod', 'go.sum'],
      'internal/vendor/dolthub-driver': LINKS_317.filter(p => p.startsWith('internal/')).sort(),
    });
    assert.equal(context, 'This pull request changes 30 files in 2 areas: top-level (2 files), internal/vendor/dolthub-driver (28 files).');
  });

  test('copirate-93: src with the test that names a changed source; root with the manifest, docs, and the orphan test', () => {
    assert.deepEqual(byName(partitionByDirectory(COPIRATE_93).scopes), {
      src: ['src/dependency-diff.js', 'src/multiscope.js', 'src/prompt.js', 'src/run.js', 'test/dependency-diff.test.js'],
      [ROOT_SCOPE_NAME]: ['README.md', 'action.yml', 'package.json', 'test/dependency-diff-wiring.test.js'],
    });
  });

  test('cc-candybar-150: four areas; lone files walk up to the root', () => {
    assert.deepEqual(byName(partitionByDirectory(CC_CANDYBAR_150).scopes), {
      [ROOT_SCOPE_NAME]: ['CLAUDE.md', 'package.json', 'scripts/daemon-load-harness.ts', 'src/daemon/cache/session-usage-store.ts'],
      'src/segments': ['src/segments/metrics.ts', 'src/segments/session.ts', 'test/metrics.test.ts'],
      'src/utils': ['src/utils/claude.ts', 'src/utils/transcript-fs.ts'],
      test: ['test/session-provider.test.ts', 'test/transcript-incremental.test.ts'],
    });
  });

  test('laws-4: three directories, three scopes — the structure the scout happened to agree on in 10 of 10 replays', () => {
    const { scopes } = partitionByDirectory(LAWS_4);
    assert.deepEqual(scopes.map(s => [s.name, s.files.length]), [
      ['evals/tasks', 5], ['evals/tasks/go-template-add-fix', 4], ['evals/tasks/laws-scripts-parse', 4],
    ]);
  });
});

describe('partitionByDirectory — the theorem every output satisfies', () => {
  const CASES = { LINKS_317, COPIRATE_93, CC_CANDYBAR_150, LAWS_4 };
  for (const [label, paths] of Object.entries(CASES)) {
    test(`${label}: every changed path is in exactly one scope`, () => {
      const assigned = partitionByDirectory(paths).scopes.flatMap(s => s.files);
      assert.deepEqual([...assigned].sort(), [...paths].sort());
      assert.equal(new Set(assigned).size, assigned.length);
    });
    test(`${label}: input order is not part of the structure`, () => {
      const reversed = partitionByDirectory([...paths].reverse());
      assert.deepEqual(reversed, partitionByDirectory(paths));
    });
    test(`${label}: no scope is smaller than MIN_SCOPE_FILES unless it is the root`, () => {
      for (const s of partitionByDirectory(paths).scopes) {
        assert.ok(s.files.length >= MIN_SCOPE_FILES || s.name === ROOT_SCOPE_NAME, `${s.name} has ${s.files.length} file(s)`);
      }
    });
  }

  test('a scope is the same stamped value a scout or a pinned plan produces: name, focus, files, nothing else', () => {
    for (const s of partitionByDirectory(COPIRATE_93).scopes) {
      assert.deepEqual(Object.keys(s).sort(), ['files', 'focus', 'name']);
      assert.match(s.focus, /Review the changes to .* Also read the files they import/);
    }
  });

  test('a single changed file is one root scope', () => {
    const { scopes, context } = partitionByDirectory(['src/deep/only.js']);
    assert.deepEqual(byName(scopes), { [ROOT_SCOPE_NAME]: ['src/deep/only.js'] });
    assert.equal(context, 'This pull request changes 1 file in 1 area: top-level (1 file).');
  });

  test('a test that names an AMBIGUOUS source (two changed files share the stem) keys on its own directory', () => {
    const { scopes } = partitionByDirectory(['a/util.js', 'b/util.js', 'test/util.test.js', 'test/other.test.js']);
    assert.deepEqual(byName(scopes), {
      [ROOT_SCOPE_NAME]: ['a/util.js', 'b/util.js'],
      test: ['test/other.test.js', 'test/util.test.js'],
    });
  });

  test('minFiles is the width lever: at 1 nothing merges, at a large value everything is one root scope', () => {
    assert.equal(partitionByDirectory(CC_CANDYBAR_150, { minFiles: 1 }).scopes.length, 6);
    assert.deepEqual(byName(partitionByDirectory(CC_CANDYBAR_150, { minFiles: 100 }).scopes), {
      [ROOT_SCOPE_NAME]: [...CC_CANDYBAR_150].sort(),
    });
  });

  test('an empty change is refused by name, not passed on as an empty plan', () => {
    assert.throws(() => partitionByDirectory([]), /no changed paths to partition/);
  });
});
