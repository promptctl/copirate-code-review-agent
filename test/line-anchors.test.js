'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  patchLines,
  buildReviewAnchors,
  annotatePatchWithLines,
  parseUnifiedDiff,
} = require('../src/index.js');

// The line-anchor invariant:
//   - @@ hunk headers reset the new-side counter to the header's starting line
//   - added (+) and context ( ) lines are anchorable and advance the counter
//   - deleted (-) lines have no new-file line and are NOT anchorable
// [LAW:verifiable-goals] This is the most fragile contract in the codebase; every
// subsequent refactor ticket must pass these fixtures unchanged.

const SIMPLE_PATCH = [
  '@@ -1,4 +1,4 @@',
  ' context line 1',   // line 1
  '+added line',       // line 2
  ' context line 3',   // line 3
  '-deleted line',     // unanchorable
  ' context line 5',   // line 4
].join('\n');

describe('patchLines — line-anchor invariant', () => {
  test('context lines are anchorable and advance the counter', () => {
    const entries = [...patchLines(SIMPLE_PATCH)];
    const lines = entries.filter(e => e.kind === 'line');
    assert.deepEqual(
      lines.map(e => ({ line: e.line, text: e.text })),
      [
        { line: 1, text: ' context line 1' },
        { line: 2, text: '+added line' },
        { line: 3, text: ' context line 3' },
        { line: 4, text: ' context line 5' },
      ],
    );
  });

  test('deleted lines are emitted as meta (unanchorable)', () => {
    const entries = [...patchLines(SIMPLE_PATCH)];
    const deletedEntry = entries.find(e => e.text === '-deleted line');
    assert.ok(deletedEntry, 'deleted line should appear');
    assert.equal(deletedEntry.kind, 'meta', 'deleted line must be meta, not anchorable');
    assert.equal(deletedEntry.line, undefined, 'deleted line must carry no line number');
  });

  test('@@ header resets counter to the declared new-side start', () => {
    const patch = [
      '@@ -10,3 +20,3 @@',
      ' context at 20',  // line 20
      '+added at 21',    // line 21
      ' context at 22',  // line 22
    ].join('\n');
    const lines = [...patchLines(patch)].filter(e => e.kind === 'line');
    assert.equal(lines[0].line, 20);
    assert.equal(lines[1].line, 21);
    assert.equal(lines[2].line, 22);
  });

  test('multiple hunks: second @@ resets counter independently', () => {
    const patch = [
      '@@ -1,2 +1,2 @@',
      ' line 1',   // 1
      '+line 2',   // 2
      '@@ -10,2 +50,2 @@',
      ' line 50',  // 50
      '+line 51',  // 51
    ].join('\n');
    const lines = [...patchLines(patch)].filter(e => e.kind === 'line');
    assert.deepEqual(lines.map(e => e.line), [1, 2, 50, 51]);
  });

  test('hunk-header line is emitted as meta (not counted)', () => {
    const entries = [...patchLines(SIMPLE_PATCH)];
    const header = entries.find(e => e.text.startsWith('@@'));
    assert.equal(header.kind, 'meta');
    assert.equal(header.line, undefined);
  });

  test('lines before any @@ are emitted as meta', () => {
    const patch = 'diff --git a/f b/f\n+++ b/f\n@@ -1,1 +1,1 @@\n+x';
    const entries = [...patchLines(patch)];
    const before = entries.filter(e => !e.text.startsWith('@@') && e.kind !== 'line');
    assert.ok(before.length > 0);
    before.forEach(e => assert.equal(e.kind, 'meta'));
  });
});

describe('buildReviewAnchors', () => {
  test('builds path:line anchor map for anchorable lines', () => {
    const files = [{ filename: 'src/foo.js', status: 'modified', patch: SIMPLE_PATCH }];
    const anchors = buildReviewAnchors(files);
    assert.ok(anchors.has('src/foo.js:1'));
    assert.ok(anchors.has('src/foo.js:2'));
    assert.ok(anchors.has('src/foo.js:3'));
    assert.ok(anchors.has('src/foo.js:4'));
    assert.equal(anchors.size, 4);
  });

  test('files without patch are skipped', () => {
    const files = [
      { filename: 'a.js', status: 'added' },             // no patch
      { filename: 'b.js', status: 'modified', patch: '@@ -1,1 +1,1 @@\n+x' },
    ];
    const anchors = buildReviewAnchors(files);
    assert.ok(!anchors.has('a.js:1'), 'no-patch file must not appear in anchors');
    assert.ok(anchors.has('b.js:1'));
  });

  test('multi-file anchor set has distinct path prefixes', () => {
    const files = [
      { filename: 'a.js', status: 'modified', patch: '@@ -1,1 +1,1 @@\n+x' },
      { filename: 'b.js', status: 'modified', patch: '@@ -1,1 +1,1 @@\n+y' },
    ];
    const anchors = buildReviewAnchors(files);
    assert.ok(anchors.has('a.js:1'));
    assert.ok(anchors.has('b.js:1'));
    assert.equal(anchors.size, 2);
  });
});

describe('annotatePatchWithLines', () => {
  test('anchorable lines are prefixed with LINE N:', () => {
    const output = annotatePatchWithLines(SIMPLE_PATCH);
    assert.ok(output.includes('LINE 1: '), 'context line 1 annotated');
    assert.ok(output.includes('LINE 2: '), 'added line annotated');
    assert.ok(output.includes('LINE 3: '), 'context line 3 annotated');
    assert.ok(output.includes('LINE 4: '), 'context line 5 annotated');
  });

  test('deleted lines are NOT annotated with LINE N:', () => {
    const output = annotatePatchWithLines(SIMPLE_PATCH);
    const lines = output.split('\n');
    const deletedLine = lines.find(l => l.startsWith('-deleted'));
    assert.ok(deletedLine, 'deleted line must appear in output');
    assert.ok(!deletedLine.startsWith('LINE '), 'deleted line must not be annotated');
  });

  test('hunk headers pass through unannotated', () => {
    const output = annotatePatchWithLines(SIMPLE_PATCH);
    const headerLine = output.split('\n').find(l => l.startsWith('@@'));
    assert.ok(headerLine, 'header must appear');
    assert.ok(!headerLine.startsWith('LINE '), 'header must not be annotated');
  });
});

describe('parseUnifiedDiff', () => {
  const UNIFIED = [
    'diff --git a/src/foo.js b/src/foo.js',
    'index abc..def 100644',
    '--- a/src/foo.js',
    '+++ b/src/foo.js',
    '@@ -1,3 +1,4 @@',
    ' context',
    '+added',
    ' context2',
    '-removed',
  ].join('\n');

  test('parses filename from b/ side', () => {
    const files = parseUnifiedDiff(UNIFIED);
    assert.equal(files.length, 1);
    assert.equal(files[0].filename, 'src/foo.js');
  });

  test('default status is modified', () => {
    const files = parseUnifiedDiff(UNIFIED);
    assert.equal(files[0].status, 'modified');
  });

  test('new file mode sets status to added', () => {
    const diff = [
      'diff --git a/new.js b/new.js',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.js',
      '@@ -0,0 +1,1 @@',
      '+hello',
    ].join('\n');
    const files = parseUnifiedDiff(diff);
    assert.equal(files[0].status, 'added');
  });

  test('deleted file mode sets status to removed', () => {
    const diff = [
      'diff --git a/old.js b/old.js',
      'deleted file mode 100644',
      '--- a/old.js',
      '+++ /dev/null',
      '@@ -1,1 +0,0 @@',
      '-goodbye',
    ].join('\n');
    const files = parseUnifiedDiff(diff);
    assert.equal(files[0].status, 'removed');
  });

  test('patch includes lines from @@ onward', () => {
    const files = parseUnifiedDiff(UNIFIED);
    assert.ok(files[0].patch.startsWith('@@ '));
    assert.ok(files[0].patch.includes('+added'));
  });

  test('files without hunks are excluded', () => {
    // Binary file header — no @@ line
    const diff = [
      'diff --git a/img.png b/img.png',
      'index abc..def 100644',
      'Binary files differ',
    ].join('\n');
    const files = parseUnifiedDiff(diff);
    assert.equal(files.length, 0);
  });

  test('multi-file diff produces one entry per changed file', () => {
    const diff = [
      'diff --git a/a.js b/a.js',
      '@@ -1,1 +1,1 @@',
      '+a',
      'diff --git a/b.js b/b.js',
      '@@ -1,1 +1,1 @@',
      '+b',
    ].join('\n');
    const files = parseUnifiedDiff(diff);
    assert.equal(files.length, 2);
    assert.deepEqual(files.map(f => f.filename), ['a.js', 'b.js']);
  });
});
