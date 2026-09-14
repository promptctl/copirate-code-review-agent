'use strict';

const { BOUNDS, BudgetExhaustedError } = require('./bounds');

// [FRAMING:parts-and-seams] The review's token cap: a hard ceiling on the tokens one run may spend, counted
// in the review footer's own units (input, cached input included, plus output) so an operator sizes it by
// reading the footer. Unlike the deadline, spend is not known in advance — it accrues while engines run, in
// several lanes at once — so the cap is OWNED mutable state rather than a minted value: one owner, created
// once at the run boundary and shared by every spawn of the run (the scout, every worker, every sweep,
// every retry, and every config a failover restarts the pass on). [LAW:no-shared-mutable-globals]

// [LAW:no-silent-failure] Parse strictly, mirroring parseTimeBudgetMinutes: a typo like "10M" or "ten
// million" must red the run, never silently disable the cap it exists to enforce. The domain is a
// non-negative integer of tokens; 0 = no cap, matching the 0-sentinel of TIME_BUDGET_MINUTES and
// MAX_REVIEW_ROUNDS. Empty (an explicitly cleared input) is no cap; unset gets action.yml's default.
function parseMaxReviewTokens(raw) {
  const s = String(raw).trim();
  if (s === '') return 0;
  const tokens = Number(s);
  if (!/^\d+$/.test(s) || !Number.isSafeInteger(tokens)) {
    throw new Error(`MAX_REVIEW_TOKENS must be a non-negative integer of tokens (0 = no cap); got "${raw}".`);
  }
  return tokens;
}

// The cap's state and the one API that changes it. `limit` 0 reads as Infinity, so an uncapped run takes
// the same code path with a value that is never reached. [LAW:dataflow-not-control-flow]
//
// What the run has SPENT is the settled spawns' totals plus every in-flight spawn's live estimate, so a
// spawn's tokens count from the first usage event its engine emits, not from when it exits. Each spawn
// opens a handle:
//   observe(total) — the spawn's running total so far, fed live from the engine's stream (runEngine);
//   onExhausted(fn) — how to stop this spawn when the cap is reached, by any lane (runEngine);
//   settle(total)   — the engine's authoritative total once the spawn is over (the adapter seam).
// settle charges max(live, authoritative), because both undercount in different ways: claude-code's live
// output count is a partial snapshot, and opencode's authoritative sum loses a clipped stream's head. A
// spawn that died with no report settles with 0 and keeps what was observed. [FRAMING:representation]
//
// [LAW:single-enforcer] Exhaustion is decided here, in one place: when spend reaches the limit, EVERY
// open spawn's onExhausted fires, once, so the cap stops all lanes and not only the spawn that crossed
// it. The overshoot is what the in-flight spawns reported in their last usage events — at most one
// model request per running spawn.
function mintTokenCap(limit) {
  const ceiling = limit > 0 ? limit : Infinity;
  let committed = 0;
  const live = new Map();
  const watchers = new Map();
  const spent = () => committed + [...live.values()].reduce((sum, n) => sum + n, 0);
  const exhausted = () => spent() >= ceiling;
  const fireIfExhausted = () => {
    if (!exhausted()) return;
    const stops = [...watchers.values()];
    watchers.clear();
    for (const stop of stops) stop();
  };
  const describe = () => `${spent().toLocaleString('en-US')} of ${ceiling.toLocaleString('en-US')} tokens`;
  // [LAW:single-enforcer] The one wording of each way the cap stops work — a spawn refused before it
  // starts, a spawn killed mid-flight — so the remedy is named the same way wherever the cap bites, and
  // the figure is read at the instant the stop is ordered.
  const refused = (what) => new BudgetExhaustedError('tokens', `${what} refused: the review's token cap is spent (${describe()}). ${BOUNDS.tokens.remedy}`);
  const killed = (what) => new BudgetExhaustedError('tokens', `${what} killed: the review's token cap was reached mid-spawn (${describe()}). ${BOUNDS.tokens.remedy}`);
  return {
    exhausted,
    describe,
    refused,
    open() {
      const key = Symbol('spawn');
      live.set(key, 0);
      return {
        exhausted,
        refused,
        killed,
        observe(total) {
          live.set(key, Math.max(live.get(key), total));
          fireIfExhausted();
        },
        onExhausted(stop) {
          watchers.set(key, stop);
          fireIfExhausted();
        },
        settle(total) {
          committed += Math.max(live.get(key), total);
          live.delete(key);
          watchers.delete(key);
          fireIfExhausted();
        },
      };
    },
  };
}

module.exports = { parseMaxReviewTokens, mintTokenCap };
