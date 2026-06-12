'use strict';

const core = require('@actions/core');

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

// [LAW:no-ambient-temporal-coupling] produceReview is the single explicit owner of all
// retry timing and failover policy. produceOnce makes one attempt with no timing knowledge.
// [LAW:dataflow-not-control-flow] The chain is policy data, not branching: the same loop
// body runs every iteration; the config value (not a code branch) determines what runs.
// [LAW:no-silent-failure] Non-transient errors surface immediately; exhaustion throws the
// last transient error rather than returning silently. [LAW:effects-at-boundaries]
// core.warning is the only effect here; all timing state is explicit local variables.
//
// produceOnce and sleepFn are injectable for testing — tests pass stubs that throw on demand
// and a no-op sleeper to avoid real waits. [LAW:effects-at-boundaries]
// buildPromptFor is (toolNames) => string; each engine gets the right MCP tool identifiers
// in its prompt. [LAW:types-are-the-program] A plain string bakes in chain[0]'s toolNames.
// Per-config retry limit: 3 total attempts (1 initial + 2 retries), honoring Retry-After.
// After 3 transient failures on one config: advance to next config IMMEDIATELY — different
// provider, waiting buys nothing. Chain exhausted → exponential backoff (cap 60s) by sweep
// count, restart from chain[0], until the 60-min budget is spent.
// [LAW:effects-at-boundaries] budgetMs is injectable so tests can set a zero/tiny budget
// to cover the 'deadline exceeded mid-retry' throw path without real 60-min waits.
async function produceReview(chain, buildPromptFor, anchors, produceOnce, sleepFn = sleep, budgetMs = TRANSIENT_RETRY_BUDGET_MS) {
  // [LAW:no-silent-failure] An empty chain never assigns lastErr; throw undefined is opaque.
  if (!chain.length) throw new Error('produceReview: chain must not be empty');
  const deadline = Date.now() + budgetMs;
  let totalAttempts = 0;
  let lastErr;
  const PER_CONFIG_LIMIT = 3;

  for (let sweep = 1; ; sweep++) {
    for (const config of chain) {
      for (let attempt = 1; attempt <= PER_CONFIG_LIMIT; attempt++) {
        totalAttempts++;
        try {
          const review = await produceOnce(config, buildPromptFor, anchors);
          return { review, configUsed: config, attempts: totalAttempts };
        } catch (err) {
          if (!(err instanceof TransientError)) throw err; // non-transient: surface immediately
          lastErr = err;
          const budgetLeft = Math.max(0, deadline - Date.now());
          if (budgetLeft === 0) throw lastErr;

          if (attempt < PER_CONFIG_LIMIT) {
            // Retry same config: honor Retry-After or use exponential backoff.
            const hintOrBackoff = err.retryAfterMs ?? transientBackoffMs(attempt);
            const delay = Math.min(hintOrBackoff, budgetLeft);
            const minsLeft = Math.ceil(budgetLeft / 60_000);
            const src = err.retryAfterMs != null ? 'Retry-After' : 'backoff';
            core.warning(
              `Transient error on '${config.name}' (${config.engine}/${config.model}) attempt ${attempt}/${PER_CONFIG_LIMIT}: ${err.message}. ` +
              `Retrying in ${Math.round(delay / 1000)}s [${src}] (~${minsLeft}m budget left).`,
            );
            await sleepFn(delay);
          } else {
            // All per-config attempts exhausted: advance to next config immediately.
            core.warning(
              `Transient error on '${config.name}' (${config.engine}/${config.model}) — all ${PER_CONFIG_LIMIT} attempts exhausted: ${err.message}. ` +
              `Advancing to next config.`,
            );
          }
        }
      }
    }

    // All configs exhausted for this sweep. Back off before restarting chain[0].
    const budgetLeft = Math.max(0, deadline - Date.now());
    if (budgetLeft === 0) throw lastErr;
    const delay = Math.min(transientBackoffMs(sweep), budgetLeft);
    const minsLeft = Math.ceil(budgetLeft / 60_000);
    core.warning(
      `All ${chain.length} config(s) exhausted (sweep ${sweep}). ` +
      `Restarting chain in ${Math.round(delay / 1000)}s (~${minsLeft}m budget left).`,
    );
    await sleepFn(delay);
  }
}

// Build the review attribution footer appended to every submitted review.
// [LAW:one-source-of-truth] The footer is built once here from the ReviewConfig value;
// transport.js references it as a parameter, never reconstructs it.
function buildAttributionFooter(config) {
  const parts = [
    `config \`${config.name}\``,
    config.engine,
    config.model || '(default model)',
  ];
  if (config.reasoning) parts.push(`reasoning \`${config.reasoning}\``);
  return `_Reviewed by ${parts.join(' / ')}._`;
}

module.exports = {
  TRANSIENT_RETRY_BUDGET_MS,
  TransientError,
  parseRetryAfterMs,
  sleep,
  transientBackoffMs,
  produceReview,
  buildAttributionFooter,
};
