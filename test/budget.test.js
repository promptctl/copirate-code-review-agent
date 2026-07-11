'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  UNLIMITED_EFFECTIVE_ROUNDS,
  MIN_CAP_USD,
  CAP_FRACTION,
  estimatedCostUsd,
  perReviewCapUsd,
  chooseProfile,
} = require('../src/budget');
const { defaultEffortProfile } = require('../src/effort');

// Candidates are real EffortProfile values built through the actual constructor — proving the policy
// composes with the shipped type, not a hand-rolled stand-in. A ladder of roundCaps is the shape the
// budget wiring (zai-budget-qzm.5) will hand in.
const profile = (roundCap) => defaultEffortProfile({ roundCap });
const LADDER = [profile(1), profile(2), profile(3), profile(5)];

describe('estimatedCostUsd — a fixed-diff RANKER, asserted by ordering never by absolute dollars', () => {
  test('monotonic in roundCap at a fixed diff (higher cap ⇒ higher estimate)', () => {
    const diff = 100;
    const e1 = estimatedCostUsd(profile(1), diff);
    const e2 = estimatedCostUsd(profile(2), diff);
    const e3 = estimatedCostUsd(profile(3), diff);
    assert.ok(e1 < e2 && e2 < e3, `expected strictly increasing, got ${e1}, ${e2}, ${e3}`);
  });

  test('monotonic in diffSize at a fixed roundCap (more churn ⇒ higher estimate)', () => {
    const small = estimatedCostUsd(profile(2), 10);
    const large = estimatedCostUsd(profile(2), 800);
    assert.ok(small < large, `expected ${small} < ${large}`);
  });

  test('the roundCap=0 "unlimited" sentinel ranks as the MOST expensive, never $0 (the anti-$0 trap)', () => {
    const diff = 100;
    // A naive `perRoundBase × roundCap` would make unlimited estimate at $0 — always affordable —
    // silently defeating the budget. It must rank above any typical finite cap.
    assert.ok(estimatedCostUsd(profile(0), diff) > estimatedCostUsd(profile(5), diff));
    assert.equal(
      estimatedCostUsd(profile(0), diff),
      estimatedCostUsd(profile(UNLIMITED_EFFECTIVE_ROUNDS), diff),
    );
  });

  test('positive even at diffSize=0 — the fixed token floor dominates', () => {
    assert.ok(estimatedCostUsd(profile(1), 0) > 0);
  });

  test('pure/reproducible — identical inputs yield identical output', () => {
    assert.equal(estimatedCostUsd(profile(3), 250), estimatedCostUsd(profile(3), 250));
  });
});

describe('perReviewCapUsd — a floored fraction of REMAINING budget', () => {
  test('is CAP_FRACTION of remaining when that exceeds the floor (decays as the day depletes)', () => {
    assert.equal(perReviewCapUsd(0, 10), CAP_FRACTION * 10);
    assert.equal(perReviewCapUsd(5, 10), CAP_FRACTION * 5);
    assert.ok(perReviewCapUsd(5, 10) < perReviewCapUsd(0, 10)); // spent more ⇒ smaller cap
  });

  test('never decays below MIN_CAP_USD — a minimal review stays affordable deep into the budget', () => {
    assert.equal(perReviewCapUsd(9.99, 10), MIN_CAP_USD);
  });

  test('an overspent day (spentToday > dailyBudget) floors the cap, never goes negative', () => {
    assert.equal(perReviewCapUsd(15, 10), MIN_CAP_USD);
  });
});

describe('chooseProfile — the gradient: pick the affordable best, always return a profile', () => {
  test('picks the highest-effort candidate under a generous cap', () => {
    const { profile: chosen, withinCap } = chooseProfile({
      candidates: LADDER, spentToday: 0, dailyBudget: 10, diffSize: 100,
    });
    assert.equal(chosen.roundCap, 5); // the top of the ladder fits early in the day
    assert.equal(withinCap, true);
  });

  test('DE-RATES as the day depletes — higher spentToday selects a lower roundCap (the gradient)', () => {
    const pick = (spentToday) => chooseProfile({
      candidates: LADDER, spentToday, dailyBudget: 10, diffSize: 100,
    }).profile.roundCap;
    const early = pick(0);
    const mid = pick(8);
    const late = pick(9);
    assert.ok(early > mid && mid > late, `expected strictly decreasing effort, got ${early}, ${mid}, ${late}`);
  });

  test('FLOOR: when even the cheapest candidate exceeds the cap, still returns it — a minimal review always runs', () => {
    // A large diff makes every candidate cost more than the floored cap; the epic's bar is a gradient,
    // NOT a cutoff, so the policy must still return the cheapest profile, flagged withinCap=false.
    const { profile: chosen, withinCap } = chooseProfile({
      candidates: LADDER, spentToday: 100, dailyBudget: 10, diffSize: 2000,
    });
    assert.equal(chosen.roundCap, 1); // the cheapest candidate
    assert.equal(withinCap, false); // fell back through the floor, honestly reported
  });

  test('order-independent — a shuffled candidate set yields the same choice', () => {
    const shuffled = [profile(3), profile(5), profile(1), profile(2)];
    const a = chooseProfile({ candidates: LADDER, spentToday: 8, dailyBudget: 10, diffSize: 100 });
    const b = chooseProfile({ candidates: shuffled, spentToday: 8, dailyBudget: 10, diffSize: 100 });
    assert.equal(a.profile.roundCap, b.profile.roundCap);
  });

  test('returns a profile BY IDENTITY from the candidate set — never a synthesized value', () => {
    const target = profile(2);
    const candidates = [profile(5), target, profile(3)];
    // Tune spend so the floored cap admits roundCap≤2 but not 3 at this diff (highest-affordable = 2).
    const { profile: chosen } = chooseProfile({
      candidates, spentToday: 8.7, dailyBudget: 10, diffSize: 100,
    });
    assert.equal(chosen, target); // same object reference, not an equal copy
  });

  test('empty candidate set is a caller contract breach — throws loudly, never returns null', () => {
    assert.throws(() => chooseProfile({ candidates: [], spentToday: 0, dailyBudget: 10, diffSize: 100 }), /non-empty/);
  });
});
