'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { BOUNDS, BudgetExhaustedError } = require('../src/bounds');
const { isRetryableSpawnError, TransientError } = require('../src/failover');

// ── a reached bound's place in the error vocabulary ───────────────────────────────────────────────
describe('BudgetExhaustedError', () => {
  for (const bound of Object.keys(BOUNDS)) {
    test(`${bound}: is not retryable in place — a fresh spawn cannot fit in a spent bound`, () => {
      assert.equal(isRetryableSpawnError(new BudgetExhaustedError(bound, 'x')), false);
    });
    test(`${bound}: is not transient — config-level failover must not restart the pass past it`, () => {
      assert.equal(new BudgetExhaustedError(bound, 'x') instanceof TransientError, false);
    });
  }
  test('carries which bound was reached', () => {
    assert.equal(new BudgetExhaustedError('tokens', 'x').bound, 'tokens');
    assert.equal(new BudgetExhaustedError('time', 'x').bound, 'time');
  });
  test('the error type serializes distinguishably', () => {
    const e = new BudgetExhaustedError('time', 'budget spent');
    assert.equal(e.name, 'BudgetExhaustedError');
    assert.match(String(e), /^BudgetExhaustedError: budget spent/);
  });
  test('an unknown bound is refused at construction, never a bound no rendering can name', () => {
    assert.throws(() => new BudgetExhaustedError('budget', 'x'), /unknown bound "budget"/);
  });
});

describe('BOUNDS', () => {
  test('each remedy names the knob that raises its bound', () => {
    assert.match(BOUNDS.time.remedy, /TIME_BUDGET_MINUTES/);
    assert.match(BOUNDS.tokens.remedy, /MAX_REVIEW_TOKENS/);
  });
});
