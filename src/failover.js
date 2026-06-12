'use strict';

const TRANSIENT_RETRY_BUDGET_MS = 60 * 60 * 1000;
const TRANSIENT_BACKOFF_BASE_MS = 2_000;
const TRANSIENT_BACKOFF_MAX_MS = 60_000;

// [LAW:types-are-the-program] "Transient retryable error" is a type, not a flag bolted
// onto a generic Error. The raw 429/rate-limited and 529/overloaded signals are classified
// once, at the engine adapter boundary; the retry loop dispatches on the error's type,
// never a re-matched string. [LAW:one-type-per-behavior] Both share identical retry
// behavior, so they are one type — the cause survives only as a value (the message prefix).
// retryAfterMs carries the server-specified wait when the Retry-After header is echoed in
// CLI output; null means fall back to exponential backoff. [LAW:dataflow-not-control-flow]
class TransientError extends Error {
  constructor(message, retryAfterMs = null) {
    super(message);
    this.retryAfterMs = retryAfterMs;
  }
}

// Extract the server's Retry-After hint (seconds form) from CLI text output.
// Returns the exact value in milliseconds, or null if absent. No cap: the caller
// must honor the full server-specified window; TRANSIENT_BACKOFF_MAX_MS belongs
// on the exponential backoff path only. [LAW:one-source-of-truth]
function parseRetryAfterMs(text) {
  const match = /retry.?after[:\s]+(\d+)/i.exec(text);
  if (!match) return null;
  return parseInt(match[1], 10) * 1000;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function transientBackoffMs(attempt) {
  const cap = Math.min(TRANSIENT_BACKOFF_MAX_MS, TRANSIENT_BACKOFF_BASE_MS * 2 ** (attempt - 1));
  return cap / 2 + Math.random() * (cap / 2);
}

module.exports = {
  TRANSIENT_RETRY_BUDGET_MS,
  TransientError,
  parseRetryAfterMs,
  sleep,
  transientBackoffMs,
};
