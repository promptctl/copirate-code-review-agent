'use strict';
const fs = require('fs');
const path = require('path');

// [FRAMING:representation] The model's context window is a hard wall, and until this module nothing
// in the engine represented it: a worker's material was "the whole diff plus every assigned file read
// in full", and whether that fit the window was decided by the model's reading choices, not by the
// engine. On links-317-dolt-telemetry every worker's FIRST request was ~232k tokens against a 200k
// window (eval/out/ab-sweep0-logs, sessions ef6bfa54/29ed8a63/fefe3d0e) — the prompt alone overflowed
// before a single Read, and the workers that "succeeded" did so only because the CLI auto-compacted
// the diff into a summary and reviewed that. This module makes the window a VALUE and the fit a pure
// function of it and the material: what is shown inline, what is withheld, what is read in full, what
// is read only around its hunks. [LAW:types-are-the-program] the fit is a per-file discriminated plan;
// the prompt renders it and adds no judgment of its own. [LAW:no-mode-explosion] nothing here is an
// operator input — the window is the engine's declared fact, the sizes are the material's.

// [LAW:one-source-of-truth] Tokens are estimated ONCE, here, by one rule every consumer shares. The rule
// is deliberately two-class rather than chars/4, because the material that overflowed is exactly the
// material chars/4 misjudges by 3x: a go.sum hunk of base64 hashes and dotted module paths tokenizes at
// roughly one token PER CHARACTER (measured 0.9 on that case's 1,527-line hunk — 195 KB of hash-dense
// lines accounting for ~175k of the 232k), while ordinary prose and code run ~3.5 chars per token. A
// line is hash-dense when it carries an opaque run: 24+ unbroken base64/hex-alphabet characters with at
// least three digits, which no identifier and no sentence produces. The estimate errs HIGH by design
// (1.0 over the measured 0.9; 3.5 over the ~4 code typically gets): the bound this feeds must never say
// "fits" of something that does not, and a slightly early withholding costs one hunk's inline anchors,
// not a review. Calibrated against that transcript: this rule estimates ~223k for the worker prompt
// the API counted at ~220k (232k less the CLI's own ~12k system prompt and tool schemas) — the two
// classes' errors partly cancel there, which is why neither rate is trimmed toward its measurement.
const OPAQUE_RUN = /[A-Za-z0-9+/=]{24,}/g;
const OPAQUE_MIN_DIGITS = 3;
const OPAQUE_TOKENS_PER_CHAR = 1.0;
const PROSE_CHARS_PER_TOKEN = 3.5;

function isHashDense(line) {
  for (const run of line.match(OPAQUE_RUN) ?? []) {
    if ((run.match(/\d/g) ?? []).length >= OPAQUE_MIN_DIGITS) return true;
  }
  return false;
}

// [LAW:effects-at-boundaries] Pure: a conservative token count for a text. The newline is counted with
// its line — it is a character the model pays for like any other.
function estimateTokens(text) {
  let tokens = 0;
  for (const line of text.split('\n')) {
    const chars = line.length + 1;
    tokens += isHashDense(line) ? chars * OPAQUE_TOKENS_PER_CHAR : chars / PROSE_CHARS_PER_TOKEN;
  }
  return Math.ceil(tokens);
}

// [LAW:one-source-of-truth] The share of the window a worker needs BEYOND its material and its planned
// reads, declared once with its basis. Two parts, both measured on the transcripts named above:
//   - the engine's own fixed cost — system prompt, tool schemas, the reviewer instructions — ~12k
//     (the scout's first request on that case: 12,168 tokens carrying a ~2k-token prompt);
//   - a turn's working growth — thinking, tool-call arguments, Grep results, the targeted reads this
//     module allows, the recorded findings — up to ~57k over a 23-turn session (that scout, 12k → 69k).
// 70k is the sum rounded up. This is a capacity guardrail exactly like LANE_MEMORY_BYTES (multiscope.js):
// it is not effort, it is not tunable per review, and it moves only with a new measurement of what a
// worker's turn actually costs. A window of null (an engine that has not declared one) makes the
// budget Infinity — nothing is withheld and every read is full, the same path with a different value.
// [LAW:dataflow-not-control-flow]
const WORKER_HEADROOM_TOKENS = 70_000;

// [LAW:types-are-the-program] The read plan's vocabulary. A file's `read` is exactly one of:
//   'full'     — open the whole file (it fits alongside the diff);
//   'targeted' — too large to fit whole: read only around its hunks, by offset and limit;
//   'in-diff'  — the file is new in this change and its hunk is shown, so the diff IS its full content;
//   'none'     — not this worker's to open (another scope's file, or a deleted file with no head content).
// A file's `hunk` is 'shown' (inline, on the LINE grid) or 'withheld' (no inline diff — findings on it
// are recorded at real line numbers and posted unanchored).
const READ_KINDS = ['full', 'targeted', 'in-diff', 'none'];

// [LAW:effects-at-boundaries] Pure: the fit of one worker's material into the window.
//   window      — the engine's declared context window in tokens, or null (unknown → unbounded).
//   fixedTokens — the prompt's fit-independent prose (instructions, charter, focus, prior context).
//   files       — [{ filename, status, hunk: string|null, content: { tokens, lines } }] in diff order;
//                 hunk is the rendered inline entry, or null when it cannot be shown at all (no patch,
//                 or over MAX_DIFF_CHARS) — those are withheld before the window is consulted.
//   readSet     — Set of filenames this worker opens in full (the read-set arm's projection), or null
//                 for "every changed file" (the single-scope PR and the 'changed' arm).
// Returns [{ filename, hunk, read }] in the same order.
//
// The algebra: budget = window − headroom − fixed. Hunks are placed first, because the LINE grid is
// the review's anchoring and the whole diff is what every worker shares; when they do not all fit,
// the LARGEST is withheld first, then the next, until they do — one withheld hunk costs that file its
// inline anchors and nothing else, whereas withholding many small ones would blind the worker to most
// of the change to keep one lockfile's hashes on screen. Reads take what remains, smallest first, so
// the count of files read whole is maximal; the rest are targeted. Deterministic: ties break on name.
// [LAW:no-silent-failure] A finite window the fixed prose alone overruns is refused loudly — it means
// the instructions, not the material, are the problem, and no allocation can fix that.
function fitWorkerMaterial({ window, fixedTokens, files, readSet }) {
  const budget = window === null ? Infinity : window - WORKER_HEADROOM_TOKENS - fixedTokens;
  if (budget <= 0) {
    throw new Error(`fitWorkerMaterial: the worker's fixed prompt (${fixedTokens} tokens) plus its ${WORKER_HEADROOM_TOKENS}-token headroom already exceeds the ${window}-token context window; no material can be placed.`);
  }
  const hunkTokens = new Map(files.filter(f => f.hunk !== null).map(f => [f.filename, estimateTokens(f.hunk)]));
  const shown = new Set(hunkTokens.keys());
  let placed = [...hunkTokens.values()].reduce((a, b) => a + b, 0);
  const byHunkSizeDesc = [...hunkTokens.entries()].sort(([an, at], [bn, bt]) => bt - at || an.localeCompare(bn));
  for (const [name, tokens] of byHunkSizeDesc) {
    if (placed <= budget) break;
    shown.delete(name);
    placed -= tokens;
  }

  const opens = (f) => (readSet === null || readSet.has(f.filename)) && f.status !== 'removed';
  const read = new Map(files.map(f => [f.filename, 'none']));
  const candidates = [];
  for (const f of files.filter(opens)) {
    if (f.status === 'added' && shown.has(f.filename)) read.set(f.filename, 'in-diff');
    else candidates.push(f);
  }
  candidates.sort((a, b) => a.content.tokens - b.content.tokens || a.filename.localeCompare(b.filename));
  let remaining = budget - placed;
  for (const f of candidates) {
    if (f.content.tokens <= remaining) {
      read.set(f.filename, 'full');
      remaining -= f.content.tokens;
    } else {
      read.set(f.filename, 'targeted');
    }
  }
  return files.map(f => ({ filename: f.filename, hunk: shown.has(f.filename) ? 'shown' : 'withheld', read: read.get(f.filename) }));
}

// [LAW:effects-at-boundaries] The ONE effect this module owns: measure each changed file's content as
// it stands in the reviewed checkout — the tree the worker's Read tool will open — and stamp the
// measurement onto the record. [LAW:parse-dont-validate] `content` is the stamp: buildPrMaterial and
// buildReviewInput require it on every file, so an unmeasured changed set cannot reach a worker prompt.
// A removed file has no head content (nothing to read); every other status is read from the checkout.
// [LAW:no-silent-failure] A listed file missing from the checkout is refused with the path and root
// named: the worker would fail to open it too, and a review that silently sized it at zero would plan
// a full read of a file that is not there. `readContent` is the injected reader (fs by default) so the
// measurement is a value a test can supply. Changed files under review are UTF-8 text in practice; a
// binary file measured as text errs high, the safe direction.
// The line count a Read tool sees: a file's trailing newline ends its last line, it does not start
// another, so "a\nb\n" is two lines and an empty file is none.
function lineCount(text) {
  if (text.length === 0) return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

function measureChangedFiles(files, reviewedRepoRoot, readContent = (absPath) => fs.readFileSync(absPath, 'utf8')) {
  return files.map(f => {
    if (f.status === 'removed') return { ...f, content: { tokens: 0, lines: 0 } };
    const absPath = path.join(reviewedRepoRoot, f.filename);
    let text;
    try {
      text = readContent(absPath);
    } catch (e) {
      throw new Error(`The reviewed checkout at ${reviewedRepoRoot} has no readable ${f.filename} (listed as ${f.status} in this change): ${e.message}. The review reads changed files from that checkout, so it must be at the change's head.`);
    }
    return { ...f, content: { tokens: estimateTokens(text), lines: lineCount(text) } };
  });
}

module.exports = { estimateTokens, fitWorkerMaterial, measureChangedFiles, WORKER_HEADROOM_TOKENS, READ_KINDS };
