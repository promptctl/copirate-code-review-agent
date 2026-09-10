'use strict';
// [LAW:one-way-deps] partition.js depends on review.js (the owner of what a Scope is) and nothing else in
// src/; multiscope.js depends on this. Downhill only.
const { parseScopeValue } = require('./review');

// THE PARTITION — how a pull request's changed files divide into review scopes — as a pure function of
// the changed paths. Same input, same structure, every run.
//
// [LAW:one-source-of-truth] Until this module the partition was bought from an LLM scout per run and
// re-rolled every time: on a frozen case the identical diff split into 1 to 5 scopes across replays
// (copirate-determinism-5od), scope count drove every downstream number — spawns, tokens, findings, and a
// 26-point recall spread — and in 3 of 40 replays the scout emitted scopes with NO files at all, so every
// worker silently fell back to reading the whole diff at ~3x the cost while the run scored as a valid
// sample. A review's structure is a CHOSEN value with one rule and one owner, not a dice roll: the rule
// lives here, its parameters are named constants, and a change to it is a code change an A/B can measure.
// [LAW:no-ambient-temporal-coupling] nothing here reads a clock, a model, or a file.
//
// The rule, in the order it applies:
//   1. A test file joins the concern of the changed source file it names (test/foo.test.js -> the changed
//      foo.js), when exactly one such source is in the change. A test that names no changed source, or an
//      ambiguous one, keys on its own directory like any other file.
//   2. Every file keys on its directory ('.' for the repository root).
//   3. A directory group smaller than MIN_SCOPE_FILES merges into its parent directory's group, deepest
//      first, until every group is at least that size or sits at the root. The root never merges.
// Every changed path lands in exactly one scope by construction, so no coverage sweep, duplicate check,
// or withheld-path strip exists downstream: the type of the output IS the theorem. [LAW:types-are-the-program]

// [LAW:one-source-of-truth] The one width lever this rule has. A scope is one worker spawn (~5 min,
// ~250k tokens on the shipped engine), so this constant is the cost/recall dial the partition exposes;
// measure it with the eval harness before moving it, and record the move (zai-tuning-pf0).
const MIN_SCOPE_FILES = 2;

// Test files are recognised by where they live or what they are called — both conventions are common,
// and either alone misses half of real repositories.
const TEST_DIRS = new Set(['test', 'tests', '__tests__', 'spec', 'specs']);
const TEST_STEM_SUFFIX = /(\.test|\.spec|_test|-test)$/;

// The label a root-keyed scope carries: '.' is a path, not a name a reader can follow.
const ROOT_SCOPE_NAME = 'top-level';

// [LAW:effects-at-boundaries] Pure path arithmetic. Diff paths are always '/'-separated (git's own form,
// parseReviewableFiles refuses anything else), so no platform separator is consulted.
function dirnameOf(p) {
  const i = p.lastIndexOf('/');
  return i === -1 ? '.' : p.slice(0, i);
}
function parentOf(dir) {
  const i = dir.lastIndexOf('/');
  return i === -1 ? '.' : dir.slice(0, i);
}
function stemOf(p) {
  const base = p.slice(p.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? base : base.slice(0, dot);
}
function isTestPath(p) {
  return TEST_DIRS.has(p.split('/')[0]) || TEST_STEM_SUFFIX.test(stemOf(p));
}

// Rule 1 as a table: the concern directory each path keys on. A test path keys on the directory of the ONE
// changed source whose stem it names; every other path keys on its own directory. Built once so the
// grouping below is a plain fold over values. [LAW:dataflow-not-control-flow]
function concernDirOf(changedPaths) {
  const sourcesByStem = new Map();
  for (const p of changedPaths) {
    if (isTestPath(p)) continue;
    const stem = stemOf(p);
    sourcesByStem.set(stem, sourcesByStem.has(stem) ? null : p); // null marks an ambiguous stem
  }
  return new Map(changedPaths.map(p => {
    const named = isTestPath(p) ? sourcesByStem.get(stemOf(p).replace(TEST_STEM_SUFFIX, '')) : null;
    return [p, dirnameOf(named ?? p)];
  }));
}

// Rule 3: merge undersized groups into their parents, deepest first. Each iteration moves exactly one
// group, and a group only ever moves UP, so the loop terminates at the root in at most (depth) steps per
// group. Deterministic: candidates are ordered by depth then name, so the same input always merges the
// same group first. [LAW:no-ambient-temporal-coupling]
function mergeSmallGroups(groups, minFiles) {
  const merged = new Map(groups);
  for (;;) {
    const small = [...merged.keys()]
      .filter(dir => dir !== '.' && merged.get(dir).length < minFiles)
      .sort((a, b) => depthOf(b) - depthOf(a) || (a < b ? -1 : 1));
    if (small.length === 0) return merged;
    const dir = small[0];
    const parent = parentOf(dir);
    merged.set(parent, [...(merged.get(parent) ?? []), ...merged.get(dir)]);
    merged.delete(dir);
  }
}
function depthOf(dir) {
  return dir === '.' ? 0 : dir.split('/').length;
}

// The scope's focus: the same three directives the LLM scout was told to write into every focus, now
// authored once. It names the files (so the worker knows its assignment even before the read-targets
// line) and points the worker at the import edges the change crosses — the seam checks are where
// multi-file defects live. [LAW:one-source-of-truth]
function focusFor(dir, files) {
  const where = dir === '.' ? 'the repository root' : dir;
  return `Review the changes to ${files.join(', ')} in ${where}. Also read the files they import and check `
    + 'each connection: the dependency points one way, and no single fact is defined or owned on both sides.';
}

// [LAW:parse-dont-validate] The one producer of a PR review's partition. In: the changed paths a review
// will cover (already filtered by EXCLUDE_PATTERNS — a withheld path never reaches here, so it can never
// be assigned). Out: the scopes as the workers run them, each minted through parseScopeValue so a scope
// from this producer is the SAME stamped value as one recorded by a scout or read from a pinned plan,
// plus the orientation line every worker and the posted summary share. [LAW:single-enforcer]
// [LAW:no-silent-failure] An empty change has no partition; refusing here names the fact rather than
// letting planRecord refuse an empty scope list two seams later.
function partitionByDirectory(changedPaths, { minFiles = MIN_SCOPE_FILES } = {}) {
  if (changedPaths.length === 0) {
    throw new Error('partitionByDirectory: no changed paths to partition — a review with no files has no structure.');
  }
  const concernDir = concernDirOf(changedPaths);
  const groups = new Map();
  for (const p of [...changedPaths].sort()) {
    const dir = concernDir.get(p);
    groups.set(dir, [...(groups.get(dir) ?? []), p]);
  }
  const merged = mergeSmallGroups(groups, minFiles);
  // [LAW:one-source-of-truth] A merged-in subdirectory lands at the END of its parent's group, so the
  // list is sorted once here and both renderings of the assignment — the focus prose and the files
  // field — read from that one ordering.
  const scopes = [...merged.keys()].sort().map((dir, index) => {
    const files = [...merged.get(dir)].sort();
    return parseScopeValue({ name: dir === '.' ? ROOT_SCOPE_NAME : dir, focus: focusFor(dir, files), files }, index);
  });
  const areas = scopes.map(s => `${s.name} (${s.files.length} file${s.files.length === 1 ? '' : 's'})`).join(', ');
  const context = `This pull request changes ${changedPaths.length} file${changedPaths.length === 1 ? '' : 's'} `
    + `in ${scopes.length} area${scopes.length === 1 ? '' : 's'}: ${areas}.`;
  return { scopes, context };
}

module.exports = { partitionByDirectory, MIN_SCOPE_FILES, ROOT_SCOPE_NAME };
