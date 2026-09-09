'use strict';
// How a CLI integer flag is parsed, owned once. The FLOOR is the only thing that differs between a count
// (≥1) and a cap whose off position is 0, so it crosses as a VALUE and the two accept sets are one
// function — not two hand-mirrored copies in run-case.js and freeze-suite.js, which is what this file
// replaced. [LAW:one-source-of-truth] [LAW:one-type-per-behavior]
//
// [LAW:effects-at-boundaries] EMPTY require graph, so both CLIs can import it at module load without
// spending their load-purity guarantee — the same property src/effort.js is imported for.

// The idiomatic names for the floors these CLIs use; any other floor names itself, so the naming is
// TOTAL and no caller can be promised `must be undefined`.
const FLOOR_NAME = { 0: 'a non-negative integer', 1: 'a positive integer' };

// [LAW:parse-dont-validate] Parse a CLI flag as an integer at or above `min` — the accept set is exactly
// {min, min+1, …}. Number() + Number.isInteger rejects '2.5'/'3.7'/'abc' where parseInt would SILENTLY
// TRUNCATE ('2.5' → 2), so the check matches what the error promises.
// [LAW:no-silent-failure] The rejected value is echoed so a typo is located, not guessed.
function parseIntAtLeast(raw, flag, min) {
  const floor = FLOOR_NAME[min] ?? `an integer >= ${min}`;
  // [LAW:no-silent-failure] Number('') and Number(' ') are 0, so a flag given no value would parse as
  // zero — invisible for a count (0 is below its floor) and CATASTROPHIC for a cap whose floor IS 0:
  // `--sweep-cap=` would silently select the sweeps-off arm. Blank is refused before the coercion.
  if (String(raw).trim() === '') throw new Error(`${flag} must be ${floor} (got ${JSON.stringify(raw)}).`);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`${flag} must be ${floor} (got ${JSON.stringify(raw)}).`);
  return n;
}

// The counts' floor, named once.
function parsePositiveInt(raw, flag) {
  return parseIntAtLeast(raw, flag, 1);
}

module.exports = { FLOOR_NAME, parseIntAtLeast, parsePositiveInt };
