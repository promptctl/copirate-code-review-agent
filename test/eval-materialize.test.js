'use strict';
// Materializing a frozen case as a git repo. The properties asserted here are the ones that fail
// SILENTLY when they fail — an empty revision range and a swallowed file both produce a review that
// simply finds less, with nothing anywhere saying why. [LAW:no-silent-failure]

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { diffShape, assertReproducesDiff, materializeCase } = require('../eval/materialize-case');
const { extractTree } = require('../eval/run-case');

const CASE_DIR = path.join(__dirname, '..', 'eval', 'cases', 'laws-4-eval-tasks');

const diffOf = (filename, added, removed) => [
  `diff --git a/${filename} b/${filename}`,
  `--- a/${filename}`,
  `+++ b/${filename}`,
  '@@ -1,1 +1,1 @@',
  ...Array.from({ length: added }, (_, i) => `+added ${i}`),
  ...Array.from({ length: removed }, (_, i) => `-removed ${i}`),
].join('\n');

describe('the comparable projection of a diff', () => {
  test('counts the lines a change adds and removes, per file', () => {
    assert.deepEqual(diffShape(diffOf('a.js', 2, 1)).get('a.js'), { added: 2, removed: 1 });
  });

  // `git diff` re-renders what it is asked for — different context width, different blob hashes — and
  // none of that changes WHICH CHANGE a reviewer sees. A check that refused those would be deleted by the
  // first person it cried wolf at.
  test('a rerendered header is not a different change', () => {
    const frozen = `index 1111111..2222222 100644\n${diffOf('a.js', 2, 1)}`;
    assert.doesNotThrow(() => assertReproducesDiff(diffOf('a.js', 2, 1), frozen, 'case'));
  });
});

describe('a materialized repo must reproduce the frozen change, or say so by name', () => {
  test('a file the repo lost is named, not tolerated', () => {
    assert.throws(
      () => assertReproducesDiff(diffOf('a.js', 2, 1), `${diffOf('a.js', 2, 1)}\n${diffOf('b.js', 1, 0)}`, 'case'),
      /b\.js: in the frozen diff, absent from the materialized repo/,
    );
  });

  test('a file the repo gained is named too — an extra file is a different change', () => {
    assert.throws(
      () => assertReproducesDiff(`${diffOf('a.js', 2, 1)}\n${diffOf('b.js', 1, 0)}`, diffOf('a.js', 2, 1), 'case'),
      /b\.js: in the materialized repo, absent from the frozen diff/,
    );
  });

  test('a file whose content differs is named with both counts', () => {
    assert.throws(
      () => assertReproducesDiff(diffOf('a.js', 5, 1), diffOf('a.js', 2, 1), 'case'),
      /a\.js: frozen diff has \+2\/-1, materialized repo has \+5\/-1/,
    );
  });
});

describe('a frozen case becomes a repo a git-shaped reviewer can be aimed at', () => {
  // THE BUG THIS EXISTS TO PREVENT: `main...change` is three-dot syntax — the diff from the MERGE BASE.
  // Branch `main` off the change commit and the merge base IS change, so the range is empty and every
  // review of it finds nothing, indistinguishable from a review that found nothing. The base has to be
  // the change's PARENT, and the only way to know it is is to ask git for the range.
  test('the revision range carries the whole frozen change, not an empty diff', () => {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'materialize-'));
    try {
      const { repoDir, range } = materializeCase({ caseDir: CASE_DIR, destDir: path.join(dest, 'repo'), extractTree });
      const rendered = execFileSync('git', ['diff', range], { cwd: repoDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      assert.notEqual(rendered.trim(), '', 'the range must not be empty — an empty range reviews nothing and reports it as a clean review');
      const frozen = diffShape(fs.readFileSync(path.join(CASE_DIR, 'change.diff'), 'utf8'));
      assert.deepEqual(diffShape(rendered), frozen);
      // The head is checked out, so a reviewer reading the working tree sees the changed code.
      assert.equal(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim(), 'change');
      // Two commits, base first: the range is only non-empty because change descends from base.
      assert.equal(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim(), '2');
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });

  // A case is frozen inputs. A tree whose commit ids moved with the clock would add a source of variance
  // to an instrument built to have exactly one. [LAW:no-ambient-temporal-coupling]
  test('the same case materializes to the same commits every time', () => {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'materialize-det-'));
    try {
      const shas = ['a', 'b'].map(which => {
        const { repoDir } = materializeCase({ caseDir: CASE_DIR, destDir: path.join(dest, which), extractTree });
        return execFileSync('git', ['rev-parse', 'main', 'change'], { cwd: repoDir, encoding: 'utf8' });
      });
      assert.equal(shas[0], shas[1]);
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });
});
