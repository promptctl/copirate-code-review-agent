'use strict';
// A frozen case, materialized as a REAL GIT REPO — two commits and two branches, so a reviewer that
// takes a git revision range (`main...change`) can be pointed at the same change the engine reviews from
// `change.diff`. [LAW:decomposition] the case's assets are one thing; a working tree a git-shaped tool can
// be aimed at is another, and this is the joint between them.
//
// A case freezes the tree AT THE CHANGE'S HEAD plus the diff that produced it, so the BASE is not stored —
// it is recovered by reverse-applying the diff. Two facts about that recovery are load-bearing and neither
// is obvious:
//
//   1. The base must be the change's PARENT COMMIT, not a sibling branch. `main...change` is three-dot
//      syntax — the diff from the MERGE BASE to `change` — so a `main` branched off the change commit has
//      the change itself as its merge base and the range is EMPTY. A review of an empty range returns zero
//      findings, which is indistinguishable from a review that found nothing: a silent zero on the metric
//      this whole harness exists to measure. [LAW:no-silent-failure]
//   2. Recovery can fail quietly in other ways too — a `.gitignore` in the frozen tree swallowing a
//      changed path, a binary hunk `git apply -R` cannot reverse. So the result is not trusted: the
//      materialized repo must REPRODUCE `change.diff`, asserted here, before any reviewer sees it.
//
// [LAW:effects-at-boundaries] Module load is PURE: stdlib and src/diff.js (itself stdlib-free). The pure
// shape check is separated from the git edge so it is driven directly by tests with no repo at all.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const BASE_REF = 'main';
const HEAD_REF = 'change';

// [LAW:effects-at-boundaries] Pure. The COMPARABLE PROJECTION of a diff: which files it touches and how
// many lines it adds and removes in each.
//
// Deliberately not a byte comparison of the two diff texts. `git diff` is free to re-render what it is
// asked for — different context width, different blob hashes, a `similarity index` line where the frozen
// capture had none — and none of that changes WHICH CHANGE a reviewer sees. A byte check would refuse
// correct materializations for cosmetic reasons, and a harness that cries wolf gets its check deleted.
// What must not differ is the content: a missing file, an extra file, or a file whose hunks do not carry
// the same lines is a DIFFERENT change, and every one of those moves this projection.
function diffShape(diffText) {
  const { parseUnifiedDiff } = require('../src/diff');
  const { files } = parseUnifiedDiff(diffText);
  const shape = new Map();
  for (const { filename, patch } of files) {
    const lines = patch.split('\n');
    shape.set(filename, {
      added: lines.filter(l => l.startsWith('+') && !l.startsWith('+++')).length,
      removed: lines.filter(l => l.startsWith('-') && !l.startsWith('---')).length,
    });
  }
  return shape;
}

// [LAW:parse-dont-validate] [LAW:no-silent-failure] The checkpoint between "we ran some git commands" and
// "this repo holds the frozen change". It refuses by NAME — every file that is missing, extra, or carries
// different content — because "the materialization failed" a hundred runs into a suite is a message that
// sends the reader searching, while "expected.json's case adds evals/tasks/lib.sh, the repo does not" is
// one they can act on.
function assertReproducesDiff(gitDiffText, changeDiffText, label) {
  const want = diffShape(changeDiffText);
  const got = diffShape(gitDiffText);
  const problems = [];
  for (const [filename, counts] of want) {
    const mine = got.get(filename);
    if (!mine) {
      problems.push(`${filename}: in the frozen diff, absent from the materialized repo`);
    } else if (mine.added !== counts.added || mine.removed !== counts.removed) {
      problems.push(`${filename}: frozen diff has +${counts.added}/-${counts.removed}, materialized repo has +${mine.added}/-${mine.removed}`);
    }
  }
  for (const filename of got.keys()) {
    if (!want.has(filename)) problems.push(`${filename}: in the materialized repo, absent from the frozen diff`);
  }
  if (problems.length > 0) {
    throw new Error(
      `${label}: the materialized repo does not reproduce change.diff, so a review of it would measure a ` +
      `different change than the one expected.json annotates:\n  ${problems.join('\n  ')}`,
    );
  }
}

// The identity every materialization commits under. FIXED, so the same case materializes to the same two
// shas on every machine and every run — a case is frozen inputs, and a tree whose commit ids moved with
// the clock would be a fifth source of variance in an instrument built to have exactly one (the model's
// own stochasticity). [LAW:no-ambient-temporal-coupling]
const COMMIT_ENV = {
  GIT_AUTHOR_NAME: 'copirate-eval', GIT_AUTHOR_EMAIL: 'eval@copirate.invalid',
  GIT_COMMITTER_NAME: 'copirate-eval', GIT_COMMITTER_EMAIL: 'eval@copirate.invalid',
  GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z',
  // A developer's own git config must not reach the materialization: a global `commit.gpgsign`, a
  // `core.hooksPath`, or an `init.defaultBranch` would make the repo differ per machine — or refuse to
  // commit at all on a machine with no signing key. [LAW:no-ambient-temporal-coupling]
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
};

// [LAW:no-silent-failure] Every git call is checked — execFileSync throws on a non-zero exit, and stderr
// rides along in the message — so a reverse-apply that cannot reverse (a binary hunk, a path the frozen
// tree does not hold) stops here rather than committing a base that is simply the head again.
function git(repoDir, args) {
  return execFileSync('git', args, {
    cwd: repoDir,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...COMMIT_ENV },
  });
}

// Materialize `caseDir` into `destDir`: the frozen tree at `change`, its recovered parent at `main`,
// checked out on `change` — and proven to reproduce the frozen diff before it is handed back.
function materializeCase({ caseDir, destDir, extractTree }) {
  // ABSOLUTE, because every git call below runs with cwd inside the materialized repo — a relative case
  // path would resolve against that repo and name a patch that is not there.
  const diffPath = path.resolve(caseDir, 'change.diff');
  const changeDiff = fs.readFileSync(diffPath, 'utf8');
  fs.mkdirSync(destDir, { recursive: true });
  extractTree(path.resolve(caseDir, 'repo.tar.gz'), destDir);

  git(destDir, ['init', '-q', '-b', BASE_REF, '.']);
  // Reverse-apply FIRST and commit that as the base, so `change` lands as its CHILD — see the three-dot
  // note at the top of this file.
  git(destDir, ['apply', '-R', diffPath]);
  git(destDir, ['add', '-A']);
  git(destDir, ['commit', '-q', '-m', 'base: the reviewed change reverse-applied out of the frozen tree']);
  git(destDir, ['checkout', '-q', '-b', HEAD_REF]);
  git(destDir, ['apply', diffPath]);
  git(destDir, ['add', '-A']);
  git(destDir, ['commit', '-q', '-m', 'change: the frozen tree as the case captured it']);

  assertReproducesDiff(git(destDir, ['diff', `${BASE_REF}...${HEAD_REF}`]), changeDiff, path.basename(caseDir));
  return { repoDir: destDir, base: BASE_REF, head: HEAD_REF, range: `${BASE_REF}...${HEAD_REF}` };
}

module.exports = { diffShape, assertReproducesDiff, materializeCase, BASE_REF, HEAD_REF };
