'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { classifyClaudeError, parseRetryAfterMs, transientBackoffMs, TransientError } = require('../src/index.js');

describe('parseRetryAfterMs', () => {
  test('returns null when no Retry-After hint in text', () => {
    assert.equal(parseRetryAfterMs('rate limit exceeded'), null);
    assert.equal(parseRetryAfterMs(''), null);
    assert.equal(parseRetryAfterMs('429 Too Many Requests'), null);
  });

  test('parses "retry-after: N" and returns N*1000', () => {
    assert.equal(parseRetryAfterMs('retry-after: 30'), 30_000);
    assert.equal(parseRetryAfterMs('Retry-After: 120'), 120_000);
  });

  test('parses "retry after N" (space instead of hyphen)', () => {
    assert.equal(parseRetryAfterMs('retry after 60'), 60_000);
  });

  test('Retry-After: 0 means "retry immediately" and returns 0, not null', () => {
    // [LAW:types-are-the-program] 0 is a valid server directive ("retry at once");
    // distinguishing absent (null) from immediate (0) is load-bearing for the label logic.
    assert.equal(parseRetryAfterMs('retry-after: 0'), 0);
  });

  test('extracts from middle of longer error message', () => {
    assert.equal(parseRetryAfterMs('Error 429: rate limit. Retry-After: 45 seconds'), 45_000);
  });

  test('returned value is uncapped (server hint is authoritative)', () => {
    // The cap (TRANSIENT_BACKOFF_MAX_MS = 60s) belongs on exponential backoff only.
    assert.equal(parseRetryAfterMs('retry-after: 3600'), 3_600_000);
  });
});

describe('classifyClaudeError', () => {
  const base = new Error('spawn failed');

  test('429 text produces TransientError', () => {
    const result = classifyClaudeError(base, 'HTTP 429 Too Many Requests');
    assert.ok(result instanceof TransientError);
    assert.ok(result.message.includes('rate-limited'));
  });

  test('rate-limit text produces TransientError', () => {
    const result = classifyClaudeError(base, 'rate limit exceeded');
    assert.ok(result instanceof TransientError);
  });

  test('429 with Retry-After attaches the hint', () => {
    const result = classifyClaudeError(base, 'HTTP 429 — retry-after: 90');
    assert.ok(result instanceof TransientError);
    assert.equal(result.retryAfterMs, 90_000);
  });

  test('429 without Retry-After has null retryAfterMs', () => {
    const result = classifyClaudeError(base, 'HTTP 429 Too Many Requests');
    assert.ok(result instanceof TransientError);
    assert.equal(result.retryAfterMs, null);
  });

  test('529 text produces TransientError with null retryAfterMs', () => {
    const result = classifyClaudeError(base, 'HTTP 529 overloaded');
    assert.ok(result instanceof TransientError);
    assert.equal(result.retryAfterMs, null);
    assert.ok(result.message.includes('overloaded'));
  });

  test('overloaded text produces TransientError', () => {
    const result = classifyClaudeError(base, 'model is overloaded, try again');
    assert.ok(result instanceof TransientError);
  });

  test('unrelated error is returned unchanged', () => {
    const result = classifyClaudeError(base, 'unexpected token at line 42');
    assert.equal(result, base);
    assert.ok(!(result instanceof TransientError));
  });
});

describe('transientBackoffMs', () => {
  // transientBackoffMs uses Math.random(), so we can only assert range bounds.
  // cap = min(60_000, 2_000 * 2^(attempt-1)); result ∈ [cap/2, cap]

  function capForAttempt(attempt) {
    return Math.min(60_000, 2_000 * 2 ** (attempt - 1));
  }

  for (const attempt of [1, 2, 3, 4, 5, 6, 7]) {
    test(`attempt ${attempt}: result is within [cap/2, cap]`, () => {
      const cap = capForAttempt(attempt);
      const result = transientBackoffMs(attempt);
      assert.ok(result >= cap / 2, `${result} < ${cap / 2} (lower bound)`);
      assert.ok(result <= cap, `${result} > ${cap} (upper bound)`);
    });
  }

  test('caps at TRANSIENT_BACKOFF_MAX_MS (60s) for high attempt counts', () => {
    // attempt >= 6 should always cap at 60_000
    for (let i = 0; i < 10; i++) {
      const result = transientBackoffMs(10);
      assert.ok(result <= 60_000);
    }
  });
});
