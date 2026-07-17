'use strict';

const { diffChurn } = require('./diff');

// [FRAMING:parts-and-seams] assessDifficulty is the pure, pre-spend MEASUREMENT half of the difficulty
// epic (zai-difficulty-0ea): it turns the reviewed file set into an honest description of how much
// change is here, computed BEFORE any engine spend so it is free and reproducible — the same diff
// always yields the same value. [LAW:dataflow-not-control-flow] [LAW:effects-at-boundaries] Pure: no
// IO, no clock, no engine. The POLICY that turns these signals into an effort ladder is a separate
// part (the candidate-derivation slice, zai-difficulty-0ea.2); this module carries NO knowledge of
// EffortProfile, roundCap, or thresholds, so it composes with any consumer — candidate derivation, a
// run-log observation, a future difficulty-driven lens — asking nothing of them. [LAW:composability]
//
// It runs on the SAME filteredFiles the engine reviews and diffChurn already sums (the set left after
// EXCLUDE_PATTERNS), so dist/generated/lockfile files are already gone: re-deriving THOSE as a
// "trivial" signal here would be redundant with exclusion. The signals that stay honest over the
// filtered set are diff MAGNITUDE (churn), SPREAD (how many files — the sum of the kind breakdown),
// and each touched file's KIND.

// [LAW:types-are-the-program] The strongest theorem the domain supports pre-spend — deliberately the
// RAW signals, never a scalar "score" (false precision the domain can't justify) nor an effort verdict
// (that is policy). `churn` is exact; `kinds` PARTITIONS every touched file into three risk classes,
// so a consumer derives spread as their sum and "touches source" as kinds.source > 0 — nothing thrown
// away, and no second authority to drift from. [LAW:one-source-of-truth] There is deliberately no
// `fileCount` field: it is kinds.source + kinds.tests + kinds.docs, derived by the consumer, never
// stored as a value that could disagree with the breakdown it duplicates.
// @typedef {{ churn: number, kinds: { source: number, tests: number, docs: number } }} Difficulty

// A path is TEST infrastructure when a directory segment marks a test tree, or the basename matches a
// cross-language test-file convention (js/ts `.test`/`.spec`, go `_test`, python `test_`). Path-based
// and conservative: this is a factual claim about the file, not an effort decision.
const TEST_DIR = /(^|\/)(?:tests?|__tests__|__mocks__|spec)\//i;
const TEST_FILE = /(?:\.(?:test|spec)\.[^/.]+|_test\.[^/.]+|(?:^|\/)test_[^/]*\.py)$/i;

// A path is DOCUMENTATION when it is a prose/markup file, lives under a docs tree, or is a
// conventional top-level project note (LICENSE/README/CHANGELOG/…). `.txt` is deliberately NOT a
// standalone doc extension: a bare `.txt` is as often a dependency/data spec (requirements.txt,
// constraints.txt) as prose, and misclassifying such a supply-chain file as docs-only is the
// dangerous source→under-review direction. So `.txt` counts as documentation ONLY when attached to a
// recognized note keyword (README.txt), governed by DOCS_FILE, never on its own.
const DOCS_DIR = /(^|\/)docs?\//i;
const DOCS_EXT = /\.(?:md|mdx|markdown|rst|adoc)$/i;
// The keyword must be the whole basename or carry a note extension — the boundary is `(?:\.note-ext)?$`,
// not a greedy `[^/]*$`, so `README`/`README.txt` classify as docs while `license.js` and
// `licensed_users.csv` fall through to source by construction. Case-insensitive, consistent with every
// other classification pattern, so an extensionless lowercase `readme`/`license` is not missed.
const DOCS_FILE = /(^|\/)(?:LICENSE|LICENCE|COPYING|NOTICE|AUTHORS|CHANGELOG|README|CONTRIBUTING)(?:\.(?:md|mdx|markdown|rst|adoc|txt))?$/i;

// [LAW:effects-at-boundaries] Pure. Classify ONE file's path into exactly one risk kind. A closed,
// total partition (every path resolves to one of the three), with a documented precedence — a test
// tree wins over a doc extension (a markdown fixture under test/ is test infrastructure), and anything
// neither test nor docs is SOURCE. Source is the conservative default: an unrecognized path (including
// a patch-less binary asset) is treated as reviewable-risk, never silently discounted. [LAW:no-silent-failure]
//
// [LAW:no-silent-failure] A missing or empty filename is a CALLER CONTRACT breach, not an unrecognized
// path: a non-string RegExp.test would coerce to "undefined" and an empty string matches no pattern —
// both fall through to 'source', a phantom file silently inflating the source count, a lie about what
// the change touched. A valid file always has a non-empty path, so throw loudly (as
// chooseProfile/resolveReasoningTier/parseDailyBudgetUsd do on bad input) rather than launder the error
// into a plausible classification. This is NOT a defensive skip [LAW:no-defensive-null-guards]: absence
// is not a genuine value here — a fileless entry can't come from valid transport data — so it fails the
// run instead of quietly dropping work.
function classifyFile(filename) {
  if (typeof filename !== 'string' || filename === '') {
    throw new Error(`classifyFile requires a non-empty string filename, got ${JSON.stringify(filename)}.`);
  }
  if (TEST_DIR.test(filename) || TEST_FILE.test(filename)) return 'tests';
  if (DOCS_DIR.test(filename) || DOCS_EXT.test(filename) || DOCS_FILE.test(filename)) return 'docs';
  return 'source';
}

// [LAW:effects-at-boundaries] Pure. The pre-spend difficulty of a reviewed file set.
// [LAW:one-source-of-truth] churn is diffChurn over the SAME set — never a second line-counter, so the
// difficulty magnitude and the budget cost estimate can never disagree about how big the diff is.
// Every touched file is classified (patch-less files included: they add 0 churn but still widen the
// change's spread), so the kind counts sum to the file count.
function assessDifficulty(files) {
  const kinds = { source: 0, tests: 0, docs: 0 };
  for (const file of files) kinds[classifyFile(file.filename)]++;
  return { churn: diffChurn(files), kinds };
}

module.exports = {
  classifyFile,
  assessDifficulty,
};
