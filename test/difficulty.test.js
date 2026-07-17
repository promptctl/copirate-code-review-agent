'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert');

const { classifyFile, assessDifficulty } = require('../src/difficulty');
const { diffChurn } = require('../src/diff');

// A one-line patch = one added content line under one hunk header. Churn counts only +/- lines, so
// each of these fixtures contributes exactly its added/deleted line count and 0 for the hunk header.
const patch1 = '@@ -1,1 +1,1 @@\n+const x = 1;';
const patch3 = '@@ -0,0 +1,3 @@\n+a\n+b\n+c';

describe('classifyFile — closed, total partition of a path into one risk kind', () => {
  test('test trees and test-file conventions classify as tests', () => {
    for (const p of [
      'test/difficulty.test.js',
      'src/__tests__/thing.js',
      'a/b/spec/foo.js',
      'pkg/thing_test.go',
      'app/test_widget.py',
      'ui/Button.spec.ts',
    ]) {
      assert.equal(classifyFile(p), 'tests', p);
    }
  });

  test('prose/markup, docs trees, and conventional project notes classify as docs', () => {
    for (const p of [
      'README.md',
      'docs/guide.mdx',
      'CHANGELOG',
      'LICENSE',
      'notes/design.rst',
      'x/y/overview.txt',
    ]) {
      assert.equal(classifyFile(p), 'docs', p);
    }
  });

  test('everything else classifies as source (the conservative default)', () => {
    for (const p of ['src/run.js', 'lib/thing.go', 'action.yml', 'assets/logo.png', 'Makefile']) {
      assert.equal(classifyFile(p), 'source', p);
    }
  });

  test('a test tree wins over a doc extension (documented precedence)', () => {
    // A markdown fixture living under a test tree is test infrastructure, not documentation.
    assert.equal(classifyFile('test/fixtures/sample.md'), 'tests');
  });
});

describe('assessDifficulty — pure pre-spend signals over the reviewed set', () => {
  test('churn equals diffChurn over the same set (one source of truth, not a second counter)', () => {
    const files = [
      { filename: 'src/a.js', status: 'modified', patch: patch1 },
      { filename: 'src/b.js', status: 'modified', patch: patch3 },
    ];
    assert.equal(assessDifficulty(files).churn, diffChurn(files));
    assert.equal(assessDifficulty(files).churn, 4); // 1 + 3 added lines
  });

  test('is reproducible — the same files always yield a deep-equal value', () => {
    const files = [
      { filename: 'src/a.js', status: 'modified', patch: patch1 },
      { filename: 'README.md', status: 'modified', patch: patch1 },
      { filename: 'test/a.test.js', status: 'added', patch: patch3 },
    ];
    assert.deepEqual(assessDifficulty(files), assessDifficulty(files));
  });

  test('kind counts partition every touched file (they sum to the file count)', () => {
    const files = [
      { filename: 'src/a.js', status: 'modified', patch: patch1 },
      { filename: 'src/b.js', status: 'modified', patch: patch1 },
      { filename: 'README.md', status: 'modified', patch: patch1 },
      { filename: 'test/a.test.js', status: 'added', patch: patch1 },
    ];
    const { kinds } = assessDifficulty(files);
    assert.deepEqual(kinds, { source: 2, tests: 1, docs: 1 });
    assert.equal(kinds.source + kinds.tests + kinds.docs, files.length);
  });

  test('an all-tests change touches no source (kinds.source === 0)', () => {
    const files = [
      { filename: 'test/a.test.js', status: 'added', patch: patch1 },
      { filename: 'src/__tests__/b.js', status: 'modified', patch: patch3 },
    ];
    assert.deepEqual(assessDifficulty(files).kinds, { source: 0, tests: 2, docs: 0 });
  });

  test('an all-docs change touches no source', () => {
    const files = [
      { filename: 'README.md', status: 'modified', patch: patch1 },
      { filename: 'docs/guide.md', status: 'added', patch: patch3 },
    ];
    assert.deepEqual(assessDifficulty(files).kinds, { source: 0, tests: 0, docs: 2 });
  });

  test('the empty set is zero churn and zero of every kind', () => {
    assert.deepEqual(assessDifficulty([]), { churn: 0, kinds: { source: 0, tests: 0, docs: 0 } });
  });

  test('a patch-less file (binary/rename-only) adds 0 churn but still widens spread', () => {
    // Consistent with diffChurn: no patch → 0 churn; yet the file is still counted in its kind, so a
    // rename or binary asset registers as touched spread, not an invisible change.
    const files = [
      { filename: 'assets/logo.png', status: 'added' }, // no `patch`
      { filename: 'src/a.js', status: 'modified', patch: patch1 },
    ];
    const d = assessDifficulty(files);
    assert.equal(d.churn, diffChurn(files));
    assert.equal(d.churn, 1);
    assert.deepEqual(d.kinds, { source: 2, tests: 0, docs: 0 });
  });
});
