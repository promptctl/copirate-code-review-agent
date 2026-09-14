'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { estimateTokens, fitWorkerMaterial, measureChangedFiles, WORKER_HEADROOM_TOKENS, READ_KINDS } = require('../src/window');

// ── estimateTokens — a conservative two-class count ─────────────────────────────────────────────
// The material that overflowed the 200k window (zai-engine-ydc) was a go.sum of hashes, which the
// chars/4 rule misjudges by 3x. The contract: hash-dense lines count ~1 token per character, prose
// and code ~3.5 characters per token, and the estimate never errs low on either.
describe('estimateTokens', () => {
  test('a hash-dense line (a go.sum entry) counts about one token per character', () => {
    const line = 'github.com/dolthub/dolt/go v0.40.4 h1:Zx8vK3q9dQ2mF7pL4rT6wY1nB5cJ8hV0sX9aE2gK4uM=';
    const t = estimateTokens(line);
    assert.ok(t >= line.length && t <= line.length + 1, `${t} for ${line.length} chars`);
  });
  test('ordinary code counts about 3.5 characters per token', () => {
    const line = 'function add(a, b) { return a + b; } // a plain line of code';
    assert.equal(estimateTokens(line), Math.ceil((line.length + 1) / 3.5));
  });
  test('an identifier with digits but no long opaque run is not hash-dense', () => {
    const line = 'const sha256Digest = computeSha256Digest(input1, input2);';
    assert.equal(estimateTokens(line), Math.ceil((line.length + 1) / 3.5));
  });
  test('a long run with fewer than three digits (a word) is not hash-dense', () => {
    const line = 'Supercalifragilisticexpialidocious1';
    assert.equal(estimateTokens(line), Math.ceil((line.length + 1) / 3.5));
  });
  test('lines are summed, each with its newline', () => {
    assert.equal(estimateTokens('ab\ncd'), Math.ceil(3 / 3.5 + 3 / 3.5));
  });
});

// ── fitWorkerMaterial — the pure fit of one worker's material into the window ───────────────────
describe('fitWorkerMaterial', () => {
  const prose = (chars) => 'x'.repeat(chars);
  const file = (filename, { status = 'modified', hunk = prose(70), tokens = 100, lines = 10 } = {}) =>
    ({ filename, status, hunk, content: { tokens, lines } });
  const readOf = (plan) => Object.fromEntries(plan.map(p => [p.filename, p.read]));
  const hunkOf = (plan) => Object.fromEntries(plan.map(p => [p.filename, p.hunk]));

  test('READ_KINDS is the closed vocabulary of a file\'s read plan', () => {
    assert.deepEqual(READ_KINDS, ['full', 'targeted', 'in-diff', 'none']);
  });

  test('a null window is unbounded: every hunk shown, every readable file read in full', () => {
    const plan = fitWorkerMaterial({ window: null, fixedTokens: 10_000, files: [file('a.js', { tokens: 10 ** 9 }), file('b.js')], readSet: null });
    assert.deepEqual(hunkOf(plan), { 'a.js': 'shown', 'b.js': 'shown' });
    assert.deepEqual(readOf(plan), { 'a.js': 'full', 'b.js': 'full' });
  });

  test('a fixed prompt that alone overruns the window is refused loudly — no allocation can fix the instructions', () => {
    assert.throws(
      () => fitWorkerMaterial({ window: 100_000, fixedTokens: 100_000 - WORKER_HEADROOM_TOKENS, files: [], readSet: null }),
      /fixed prompt .* already exceeds the 100000-token context window/,
    );
  });

  test('when the hunks overrun the budget the LARGEST is withheld first, until the rest fit', () => {
    // budget = 200k − 70k − 10k = 120k tokens of material. Hunks: ~112k (hash-dense), 30k, 5k.
    const hashes = Array.from({ length: 1500 }, (_, i) => `mod/${i} v1.0.0 h1:${'A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q7R8S9T0U1V2W3X4Y5Z6a7b8'}=`).join('\n');
    const files = [
      file('go.sum', { status: 'added', hunk: hashes, tokens: estimateTokens(hashes), lines: 1500 }),
      file('big.js', { hunk: prose(30_000 * 3.5) }),
      file('small.js', { hunk: prose(5_000 * 3.5) }),
    ];
    const plan = fitWorkerMaterial({ window: 200_000, fixedTokens: 10_000, files, readSet: null });
    assert.deepEqual(hunkOf(plan), { 'go.sum': 'withheld', 'big.js': 'shown', 'small.js': 'shown' });
  });

  test('an ADDED file whose hunk is shown is read from the diff, never opened again', () => {
    const plan = fitWorkerMaterial({ window: 200_000, fixedTokens: 1_000, files: [file('new.js', { status: 'added' }), file('old.js')], readSet: null });
    assert.deepEqual(readOf(plan), { 'new.js': 'in-diff', 'old.js': 'full' });
  });

  test('an added file whose hunk was withheld is opened like any other (full when it fits)', () => {
    const huge = prose(140_000 * 3.5);
    const plan = fitWorkerMaterial({ window: 200_000, fixedTokens: 1_000, files: [file('new.js', { status: 'added', hunk: huge, tokens: 500 })], readSet: null });
    assert.deepEqual(hunkOf(plan), { 'new.js': 'withheld' });
    assert.deepEqual(readOf(plan), { 'new.js': 'full' });
  });

  test('reads are greedy ascending by size: as many files as fit are read whole, the rest targeted', () => {
    // budget = 200k − 70k − 10k = 120k; hunks ≈ 3 × 21 = 63; remaining ≈ 119,937.
    const files = [file('c.js', { tokens: 80_000 }), file('a.js', { tokens: 30_000 }), file('b.js', { tokens: 60_000 })];
    const plan = fitWorkerMaterial({ window: 200_000, fixedTokens: 10_000, files, readSet: null });
    assert.deepEqual(readOf(plan), { 'a.js': 'full', 'b.js': 'full', 'c.js': 'targeted' });
  });

  test('a readSet confines full reads to its members; the rest are none, a removed file is none', () => {
    const files = [file('mine.js'), file('theirs.js'), file('gone.js', { status: 'removed', hunk: null, tokens: 0, lines: 0 })];
    const plan = fitWorkerMaterial({ window: 200_000, fixedTokens: 1_000, files, readSet: new Set(['mine.js', 'gone.js']) });
    assert.deepEqual(readOf(plan), { 'mine.js': 'full', 'theirs.js': 'none', 'gone.js': 'none' });
    assert.deepEqual(hunkOf(plan), { 'mine.js': 'shown', 'theirs.js': 'shown', 'gone.js': 'withheld' });
  });

  test('a hunk of null (no patch, or over MAX_DIFF_CHARS) is withheld before the window is consulted', () => {
    const plan = fitWorkerMaterial({ window: null, fixedTokens: 0, files: [file('big.js', { hunk: null })], readSet: null });
    assert.deepEqual(plan, [{ filename: 'big.js', hunk: 'withheld', read: 'full' }]);
  });

  test('the plan is in diff order and deterministic on ties', () => {
    const files = [file('z.js'), file('a.js'), file('m.js')];
    const plan = fitWorkerMaterial({ window: 200_000, fixedTokens: 1_000, files, readSet: null });
    assert.deepEqual(plan.map(p => p.filename), ['z.js', 'a.js', 'm.js']);
  });
});

// ── measureChangedFiles — the one effect: stamp each file's content measurement ─────────────────
describe('measureChangedFiles', () => {
  const files = [
    { filename: 'src/a.js', status: 'modified', patch: '@@ -1 +1 @@\n+x' },
    { filename: 'src/gone.js', status: 'removed' },
  ];
  test('stamps tokens, lines and symbols from the injected reader, at the path under the reviewed root; a removed file measures 0', () => {
    const seen = [];
    const out = measureChangedFiles(files, '/repo', (p) => { seen.push(p); return 'line one\nline two\n'; });
    assert.deepEqual(seen, ['/repo/src/a.js']);
    // the trailing newline ends line two; the symbols are the seam material (src/seams.js) stamped by the same read
    assert.deepEqual(out[0].content, { tokens: estimateTokens('line one\nline two\n'), lines: 2, symbols: { defines: [], uses: [] } });
    assert.deepEqual(out[1].content, { tokens: 0, lines: 0, symbols: { defines: [], uses: [] } });
    assert.equal(out[0].patch, files[0].patch); // the record is extended, never replaced
  });
  test('a file with no trailing newline keeps its last line, and an empty file has none', () => {
    const out = measureChangedFiles([files[0], files[0]], '/repo', (() => { let n = 0; return () => (n++ === 0 ? 'a\nb' : ''); })());
    assert.equal(out[0].content.lines, 2);
    assert.equal(out[1].content.lines, 0);
  });
  test('a listed file missing from the checkout is refused with the path and root named', () => {
    assert.throws(
      () => measureChangedFiles(files, '/repo', () => { throw new Error('ENOENT'); }),
      /The reviewed checkout at \/repo has no readable src\/a\.js \(listed as modified in this change\): ENOENT/,
    );
  });
});
