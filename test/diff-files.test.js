'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeDiffFiles } = require('../src/diff-files');

// The change, on disk (zai-material-bez): every changed file with a patch becomes <dir>/<path>.diff on the
// LINE grid the review anchors to, and a worker reads it with its own tools. [LAW:verifiable-goals]
describe('writeDiffFiles — the change as files a worker reads', () => {
  const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'diff-files-test-'));

  test('each changed file with a patch lands at <dir>/<path>.diff, annotated on the new-side LINE grid', () => {
    const dir = writeDiffFiles([
      { filename: 'src/a.js', status: 'modified', patch: '@@ -1,2 +1,2 @@\n context\n-old\n+new' },
      { filename: 'README.md', status: 'added', patch: '@@ -0,0 +1 @@\n+hello' },
    ], scratch());
    assert.equal(fs.readFileSync(path.join(dir, 'src/a.js.diff'), 'utf8'), 'src/a.js (modified)\n@@ -1,2 +1,2 @@\nLINE 1:  context\n-old\nLINE 2: +new\n');
    assert.equal(fs.readFileSync(path.join(dir, 'README.md.diff'), 'utf8'), 'README.md (added)\n@@ -0,0 +1 @@\nLINE 1: +hello\n');
  });

  test('a file with no patch has no diff file, and the directory is created when it does not exist', () => {
    const dir = path.join(scratch(), 'nested', 'diffs');
    assert.equal(writeDiffFiles([{ filename: 'logo.png', status: 'added' }], dir), dir);
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  test('a changed path that resolves outside the directory is refused, and nothing is written for it', () => {
    const root = scratch();
    const dir = path.join(root, 'diffs');
    assert.throws(
      () => writeDiffFiles([{ filename: '../escaped.js', status: 'modified', patch: '@@ -1 +1 @@\n+x' }], dir),
      /changed path "\.\.\/escaped\.js" resolves outside the diff directory/,
    );
    assert.equal(fs.existsSync(path.join(root, 'escaped.js.diff')), false);
  });
});
