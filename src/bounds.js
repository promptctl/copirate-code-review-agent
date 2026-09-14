'use strict';

// [FRAMING:parts-and-seams] The ceilings one review run can reach. The time budget (src/deadline.js) and
// the token cap (src/token-cap.js) measure different things and are enforced where each is observed, but
// reaching either one means the same thing to everything downstream: planned degradation. The run stops
// starting work, delivers what it collected, and names what it did not reach. So a bound is a VALUE in
// this map, never a second mechanism. [LAW:one-type-per-behavior]
//
// [LAW:one-source-of-truth] Each bound's words are stated once: `label` names it inside a sentence,
// `reached` is the phrase for a scope it stopped, `title` heads its summary line, and `remedy` names the
// operator's knobs. Every message that reports a bound (the spawn refusal, the mid-spawn kill, the
// nothing-completed failure, the summary, the run warning) reads them from here, so a remedy is never
// phrased two drifting ways.
const BOUNDS = Object.freeze({
  time: Object.freeze({
    label: 'time budget',
    reached: 'time budget exhausted',
    title: '⏳ **Time budget exhausted**',
    remedy: 'Raise TIME_BUDGET_MINUTES (and the workflow job\'s timeout-minutes above it) or split the change.',
  }),
  tokens: Object.freeze({
    label: 'token cap',
    reached: 'token cap reached',
    title: '🪙 **Token cap reached**',
    remedy: 'Raise MAX_REVIEW_TOKENS or split the change.',
  }),
});

// [LAW:types-are-the-program] "A bound was reached" is a distinct fact from "the engine failed": the first
// is planned degradation the scheduler absorbs scope by scope, the second is a worker death. The error
// carries WHICH bound, so the pass records it as the scope's cause and every rendering names the right
// ceiling. It is NOT retryable and NOT transient by construction: retryTransientSpawn passes it through
// and produceReview's `instanceof TransientError` gate rethrows it immediately. No retry fits in a budget
// that has already run out, and failing over to the next config would spend past a cap the whole run shares.
// [LAW:parse-dont-validate] The constructor is the one checkpoint for `bound`: an unknown one throws here,
// so no consumer downstream ever looks a bound up and finds nothing.
class BudgetExhaustedError extends Error {
  constructor(bound, message) {
    if (!Object.hasOwn(BOUNDS, bound)) throw new Error(`BudgetExhaustedError: unknown bound ${JSON.stringify(bound)}`);
    super(message);
    // Distinguishable in serialized form too: without the name, err.name/String(err) report a generic
    // "Error" and every log or triage surface collapses planned degradation back into an engine failure.
    this.name = 'BudgetExhaustedError';
    this.bound = bound;
  }
}

module.exports = { BOUNDS, BudgetExhaustedError };
