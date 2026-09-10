'use strict';
// [LAW:one-way-deps] partition.js depends on review.js (the owner of what a Scope is) and nothing else in
// src/; multiscope.js depends on this. Downhill only.
const { parseScopeValue } = require('./review');

// THE PARTITION — how a pull request's changed files divide into review scopes — as a pure function of
// the changed paths and their churn. Same input, same structure, every run.
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
//   1. A test file whose stem carries a test suffix joins the concern of the changed source it names
//      (test/foo.test.js -> the changed foo.js), when exactly one such source is in the change. A test
//      that names no changed source, an ambiguous one, or nothing at all (test/helpers.js: a test by
//      directory, naming no source) keys on its own directory like any other file.
//   2. Every file keys on its directory ('.' for the repository root).
//   3. A directory group smaller than MIN_SCOPE_FILES merges into its parent directory's group, deepest
//      first, until every group is at least that size or sits at the root. The root never merges.
//   4. On a LOPSIDED plan — the largest group's churn at least LOPSIDED_RATIO times the runner-up's — a
//      largest group at or above SCOPE_CHURN_CAP is cut into parts of near-equal churn, contiguous in companion
//      order (a test and the source it names are one unit, never parted). Each part OWNS its files
//      and READS every sibling part's files in full, so the concern is still seen whole by every worker
//      that judges a piece of it: the seam between parts is covered by construction, not by hope. The
//      part count is bounded by the read budget (the concern's extra reads never exceed the changed
//      set — the ceiling zai-timing-8jk.5 names), and a cut that would leave a part under
//      SCOPE_CHURN_FLOOR is not made: that group is at the floor, and stays one scope.
// Every changed path lands in exactly one scope's `files` by construction, so no coverage sweep,
// duplicate check, or withheld-path strip exists downstream: the type of the output IS the theorem.
// `reads` is eyesight, never ownership — pinnedProposal proves `files` as the cover and `reads` as
// membership in the changed set: a read outside the change is refused, a read is never counted as coverage.
// [LAW:types-are-the-program]

// [LAW:one-source-of-truth] The one width lever this rule has. A scope is one worker spawn (~5 min,
// ~250k tokens on the shipped engine), so this constant is the cost/recall dial the partition exposes;
// measure it with the eval harness before moving it, and record the move (zai-tuning-pf0).
const MIN_SCOPE_FILES = 2;

// The size dimension, calibrated on zai-timing-8jk.3 (n=190 pass-0 spawns, 53 runs): a scope's spawn
// runs ≈ 83 s × churn^0.21 — every scope pays a ~2-minute floor, and doubling churn adds ~15%. The
// largest-churn scope was the run's straggler 71% of the time on lopsided plans and at chance on even
// ones, so the cut fires only where the proxy works. [LAW:one-source-of-truth] three named dials, each
// with its reason; measure before moving one.
//   LOPSIDED_RATIO   — the plan shape the proxy predicts: max ≥ 2× runner-up (a single scope is lopsided
//                      against a runner-up of zero — the one-lane plan gains the most from a second lane).
//   SCOPE_CHURN_CAP  — where size starts to hurt: the top churn quartile (>214 lines) ran 5m49s median
//                      against 3m36s for the next, and 13 of 14 failed or retried attempts sat on scopes
//                      of 364–571 lines. 360 is the bottom of that band.
//   SCOPE_CHURN_FLOOR — the largest INDIVISIBLE reviewable unit, in lines: below ~100 the fit says a
//                      part saves under 30 s of a spawn that costs a whole extra lane and a second read,
//                      and a single file is never cut in two (a half-file has no reader for its seam).
//                      No review is faster than one spawn over this floor: ≈ 83 s × 100^0.21 ≈ 3m35s of
//                      pass-0 wall clock plus the sweep chain, and no partition can go below it.
const LOPSIDED_RATIO = 2;
const SCOPE_CHURN_CAP = 360;
const SCOPE_CHURN_FLOOR = 100;

// Test files are recognised by where they live (a test directory ANYWHERE in the path — Jest's
// src/x/__tests__/, a monorepo's packages/foo/test/) or what they are called — both conventions are
// common, and either alone misses half of real repositories. Recognition decides only that a file is
// never a SOURCE; naming a source is the suffix's job alone, because a bare stem in a test directory
// (test/config.js beside src/config.js) shares a name by coincidence, not by convention.
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
  return p.split('/').slice(0, -1).some(seg => TEST_DIRS.has(seg)) || TEST_STEM_SUFFIX.test(stemOf(p));
}

// Rule 1 as a table: for each path, its COMPANION (the one changed source a suffixed test names, else
// itself) and the concern directory that companion keys on. Every other path keys on its own directory.
// Built once so the grouping below is a plain fold over values, and the companion is what rule 4 orders
// a cut by, so a test and its source land in the same part. [LAW:dataflow-not-control-flow]
function concernOf(changedPaths) {
  const sourcesByStem = new Map();
  for (const p of changedPaths) {
    if (isTestPath(p)) continue;
    const stem = stemOf(p);
    sourcesByStem.set(stem, sourcesByStem.has(stem) ? null : p); // null marks an ambiguous stem
  }
  return new Map(changedPaths.map(p => {
    const stem = stemOf(p);
    const named = TEST_STEM_SUFFIX.test(stem) ? sourcesByStem.get(stem.replace(TEST_STEM_SUFFIX, '')) : null;
    const companion = named ?? p;
    return [p, { dir: dirnameOf(companion), companion }];
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
// `reads` renders as a value: [] (the whole concern is this scope) says nothing; a split part names the
// sibling parts' files and says what the second read is FOR — the seam, and any defect seen there. A
// finding in a sibling's file is recorded, never left for the sibling: dedupe merges the overlap.
// [LAW:dataflow-not-control-flow]
function focusFor(dir, files, reads) {
  const where = dir === '.' ? 'the repository root' : dir;
  const seam = reads.length > 0
    ? ` This concern is reviewed in parts for size; the rest of it — ${reads.join(', ')} — is owned elsewhere in the plan. `
      + 'Read those files in full too: the seam between your files and theirs is yours to check, and a defect you '
      + 'notice in one of them is recorded, never left for the worker that owns it.'
    : '';
  return `Review the changes to ${files.join(', ')} in ${where}.${seam} Also read the files they import and check `
    + 'each connection: the dependency points one way, and no single fact is defined or owned on both sides.';
}

// Rule 4. The part count a group is cut into: enough parts to bring each under the cap, but never more
// than the read budget allows — each part reads the whole group, so k parts read it k times, and the
// (k-1) extra reads are held at or below the changed set's own churn. [LAW:one-source-of-truth]
function partCount(groupChurn, totalChurn) {
  return Math.min(Math.ceil(groupChurn / SCOPE_CHURN_CAP), 1 + Math.floor(totalChurn / groupChurn));
}

// A cut of `units` into k contiguous parts of near-equal churn: each unit joins the part its churn's
// midpoint falls in. A unit is a companion group — a source and the tests that name it — so a cut can
// never part a test from its source: the seam a test covers is the one seam no second reader can replace.
// Pure arithmetic over the order given.
function cutInto(units, churnOf, k) {
  const target = units.reduce((sum, unit) => sum + churnOf(unit), 0) / k;
  const parts = Array.from({ length: k }, () => []);
  let before = 0;
  for (const unit of units) {
    const churn = churnOf(unit);
    parts[Math.min(k - 1, Math.floor((before + churn / 2) / target))].push(...unit);
    before += churn;
  }
  return parts;
}

// The parts a group becomes: the largest k, from partCount down, whose every part clears the floor; k=1
// is the group itself, uncut. An empty part has churn 0 and so fails the floor with the rest — the same
// rule, not a second check. Deterministic: same files, same churn, same cut. [LAW:no-ambient-temporal-coupling]
function partsOf(units, churnOf, totalChurn) {
  const unitChurn = (unit) => unit.reduce((sum, f) => sum + churnOf(f), 0);
  const groupChurn = units.reduce((sum, unit) => sum + unitChurn(unit), 0);
  for (let k = partCount(groupChurn, totalChurn); k > 1; k--) {
    const parts = cutInto(units, unitChurn, k);
    if (parts.every(part => unitChurn(part) >= SCOPE_CHURN_FLOOR)) return parts;
  }
  return [units.flat()];
}

// [LAW:parse-dont-validate] The one producer of a PR review's partition. In: the changed files a review
// will cover as { filename, churn } (already filtered by EXCLUDE_PATTERNS — a withheld path never reaches
// here, so it can never be assigned; churn is fileChurn, src/diff.js, the same count the budget is
// calibrated on). Out: the scopes as the workers run them, each minted through parseScopeValue so a scope
// from this producer is the SAME stamped value as one recorded by a scout or read from a pinned plan,
// plus the orientation line every worker and the posted summary share. [LAW:single-enforcer]
// [LAW:no-silent-failure] An empty change has no partition; refusing here names the fact rather than
// letting planRecord refuse an empty scope list two seams later.
function partitionByDirectory(changed, { minFiles = MIN_SCOPE_FILES } = {}) {
  if (changed.length === 0) {
    throw new Error('partitionByDirectory: no changed files to partition — a review with no files has no structure.');
  }
  const churnByPath = new Map(changed.map(f => [f.filename, f.churn]));
  const churnOf = (p) => churnByPath.get(p);
  const changedPaths = [...churnByPath.keys()].sort();
  const concern = concernOf(changedPaths);
  const groups = new Map();
  for (const p of changedPaths) {
    const { dir } = concern.get(p);
    groups.set(dir, [...(groups.get(dir) ?? []), p]);
  }
  const merged = mergeSmallGroups(groups, minFiles);

  // Rule 4 fires on the ONE largest group, and only on a lopsided plan above the cap. Ties break by name
  // so the same input always cuts the same group. The other groups are untouched: a balance target every
  // run chases is exactly what 8jk.3 ruled out — the proxy is noise on even plans.
  const groupChurn = new Map([...merged].map(([dir, files]) => [dir, files.reduce((sum, f) => sum + churnOf(f), 0)]));
  const byChurn = [...groupChurn.keys()].sort((a, b) => groupChurn.get(b) - groupChurn.get(a) || (a < b ? -1 : 1));
  const [largest, runnerUp] = byChurn;
  const totalChurn = changedPaths.reduce((sum, p) => sum + churnOf(p), 0);
  const lopsided = groupChurn.get(largest) >= LOPSIDED_RATIO * (runnerUp === undefined ? 0 : groupChurn.get(runnerUp));
  const cut = lopsided && groupChurn.get(largest) >= SCOPE_CHURN_CAP ? largest : null;

  // [LAW:one-source-of-truth] A merged-in subdirectory lands at the END of its parent's group, so each
  // group is ordered once here — by companion, the source itself first, then path — and every rendering
  // of an assignment (the focus prose, the files field, the cut) reads from that one ordering.
  const companionKey = (p) => [concern.get(p).companion, p === concern.get(p).companion ? 0 : 1, p];
  const companionOrder = (a, b) => {
    const ka = companionKey(a); const kb = companionKey(b);
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
    }
    return 0;
  };
  // Companion groups as units: consecutive files (in companion order) that share one companion.
  const unitsOf = (files) => files.reduce((units, f) => {
    const last = units[units.length - 1];
    if (last && concern.get(last[0]).companion === concern.get(f).companion) last.push(f); else units.push([f]);
    return units;
  }, []);
  const scopes = [...merged.keys()].sort().flatMap((dir) => {
    const files = [...merged.get(dir)].sort(companionOrder);
    const name = dir === '.' ? ROOT_SCOPE_NAME : dir;
    const parts = dir === cut ? partsOf(unitsOf(files), churnOf, totalChurn) : [files];
    return parts.map((own, i) => {
      const reads = parts.flatMap((part, j) => (j === i ? [] : part));
      return { name: parts.length === 1 ? name : `${name} ${i + 1}/${parts.length}`, focus: focusFor(dir, own, reads), files: own, reads };
    });
  }).map((scope, index) => parseScopeValue(scope, index));
  const areas = scopes.map(s => `${s.name} (${s.files.length} file${s.files.length === 1 ? '' : 's'})`).join(', ');
  const context = `This pull request changes ${changedPaths.length} file${changedPaths.length === 1 ? '' : 's'} `
    + `in ${scopes.length} area${scopes.length === 1 ? '' : 's'}: ${areas}.`;
  return { scopes, context };
}

module.exports = { partitionByDirectory, MIN_SCOPE_FILES, LOPSIDED_RATIO, SCOPE_CHURN_CAP, SCOPE_CHURN_FLOOR, ROOT_SCOPE_NAME };
