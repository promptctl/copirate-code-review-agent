'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { parseMaxReviewTokens, mintTokenCap } = require('../src/token-cap');
const { BudgetExhaustedError } = require('../src/bounds');

// ── the cap input, parsed strictly (mirrors parseTimeBudgetMinutes) ───────────────────────────────
describe('parseMaxReviewTokens', () => {
  test('accepts a run of digits', () => {
    assert.equal(parseMaxReviewTokens('10000000'), 10_000_000);
    assert.equal(parseMaxReviewTokens(' 42 '), 42);
  });
  test('0 and empty are the no-cap sentinel', () => {
    assert.equal(parseMaxReviewTokens('0'), 0);
    assert.equal(parseMaxReviewTokens(''), 0);
  });
  test('rejects anything else loudly — a typo must never silently disable the cap', () => {
    for (const raw of ['10M', 'ten million', '-5', '1.5', '1e7', '1_000']) {
      assert.throws(() => parseMaxReviewTokens(raw), /MAX_REVIEW_TOKENS must be a non-negative integer/, raw);
    }
  });
  test('a digit string past the safe-integer range is rejected, never an imprecise cap', () => {
    assert.throws(() => parseMaxReviewTokens('9'.repeat(40)), /MAX_REVIEW_TOKENS must be a non-negative integer/);
  });
});

// ── the cap's spend accounting ────────────────────────────────────────────────────────────────────
describe('mintTokenCap', () => {
  test('no cap (0) is never exhausted, whatever is spent', () => {
    const cap = mintTokenCap(0);
    const spend = cap.open();
    let stopped = false;
    spend.onExhausted(() => { stopped = true; });
    spend.observe(Number.MAX_SAFE_INTEGER);
    spend.settle(Number.MAX_SAFE_INTEGER);
    assert.equal(cap.exhausted(), false);
    assert.equal(stopped, false);
  });

  test('a spawn counts live, before it settles', () => {
    const cap = mintTokenCap(100);
    const spend = cap.open();
    spend.observe(60);
    assert.match(cap.describe(), /^60 of 100 tokens$/);
    spend.observe(100);
    assert.equal(cap.exhausted(), true);
  });

  test('a live total never counts backwards: a smaller reading does not un-spend tokens', () => {
    const cap = mintTokenCap(1_000);
    const spend = cap.open();
    spend.observe(500);
    spend.observe(200);
    assert.match(cap.describe(), /^500 of 1,000 tokens$/);
  });

  test('settle charges the larger of the live and authoritative totals', () => {
    const higherReport = mintTokenCap(1_000);
    const a = higherReport.open();
    a.observe(300);
    a.settle(450); // the result envelope's full output count
    assert.match(higherReport.describe(), /^450 of 1,000 tokens$/);

    const lowerReport = mintTokenCap(1_000);
    const b = lowerReport.open();
    b.observe(300);
    b.settle(0); // a spawn that died with no report keeps what was observed
    assert.match(lowerReport.describe(), /^300 of 1,000 tokens$/);
  });

  test('spend accumulates across spawns: a settled spawn stays spent for the next', () => {
    const cap = mintTokenCap(1_000);
    const first = cap.open();
    first.observe(400);
    first.settle(400);
    const second = cap.open();
    second.observe(500);
    assert.match(cap.describe(), /^900 of 1,000 tokens$/);
  });

  test('reaching the cap stops EVERY open spawn, not only the one that crossed it, each exactly once', () => {
    const cap = mintTokenCap(1_000);
    const lanes = [cap.open(), cap.open(), cap.open()];
    const stops = [0, 0, 0];
    lanes.forEach((spend, i) => spend.onExhausted(() => { stops[i] += 1; }));
    lanes[0].observe(300);
    lanes[1].observe(300);
    assert.deepEqual(stops, [0, 0, 0]);
    lanes[2].observe(400);
    assert.deepEqual(stops, [1, 1, 1]);
    lanes[2].observe(900);
    assert.deepEqual(stops, [1, 1, 1]);
  });

  test("a settle's authoritative total can reach the cap, and it stops the spawns still running", () => {
    const cap = mintTokenCap(1_000);
    const finishing = cap.open();
    const running = cap.open();
    let stopped = false;
    running.onExhausted(() => { stopped = true; });
    finishing.observe(500);
    finishing.settle(1_000);
    assert.equal(stopped, true);
  });

  test('a spawn opened on a spent cap is stopped the moment it asks to be watched', () => {
    const cap = mintTokenCap(10);
    const spent = cap.open();
    spent.observe(10);
    spent.settle(10);
    const late = cap.open();
    let stopped = false;
    late.onExhausted(() => { stopped = true; });
    assert.equal(stopped, true);
  });

  test('a settled spawn is no longer watched', () => {
    const cap = mintTokenCap(100);
    const done = cap.open();
    let stopped = false;
    done.onExhausted(() => { stopped = true; });
    done.observe(50);
    done.settle(50);
    const other = cap.open();
    other.observe(60);
    assert.equal(stopped, false);
  });

  test('refusals and kills are BudgetExhaustedError(tokens), naming the spend and the knob', () => {
    const cap = mintTokenCap(1_000);
    const spend = cap.open();
    spend.observe(1_200);
    for (const err of [cap.refused('pass'), spend.refused('claude-code spawn'), spend.killed('codex spawn')]) {
      assert.ok(err instanceof BudgetExhaustedError);
      assert.equal(err.bound, 'tokens');
      assert.match(err.message, /1,200 of 1,000 tokens/);
      assert.match(err.message, /MAX_REVIEW_TOKENS/);
    }
    assert.match(spend.killed('codex spawn').message, /^codex spawn killed: the review's token cap was reached mid-spawn/);
    assert.match(spend.refused('claude-code spawn').message, /^claude-code spawn refused: the review's token cap is spent/);
  });
});
