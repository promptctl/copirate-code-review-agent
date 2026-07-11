'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert');

const { defaultEffortProfile, resolveReasoningTier, TIER_RANK } = require('../src/effort');
const registry = require('../src/engine/registry');

describe('defaultEffortProfile', () => {
  test('reproduces the pre-profile scope concurrency (4)', () => {
    assert.deepEqual(defaultEffortProfile(), { scopeConcurrency: 4 });
  });

  test('returns a fresh object each call (no shared mutable default)', () => {
    const a = defaultEffortProfile();
    a.scopeConcurrency = 99;
    assert.equal(defaultEffortProfile().scopeConcurrency, 4);
  });
});

// The resolver's ALGORITHM, exercised on SYNTHETIC fixtures — deliberately not any adapter's real
// range, so these assertions test the pure math and never quietly track (or drift from) adapter
// config. The real per-adapter contract is asserted separately, against the live registry, below.
// [LAW:behavior-not-structure]
describe('resolveReasoningTier — value-driven resolution', () => {
  // A three-rung fixture matching no adapter (claude is low..max, codex minimal..xhigh).
  const RANGE = ['low', 'medium', 'high'];

  test('null/undefined tier resolves to null (leave the engine default)', () => {
    assert.equal(resolveReasoningTier(null, RANGE), null);
    assert.equal(resolveReasoningTier(undefined, RANGE), null);
  });

  test('an empty engine range resolves any tier to null (axis unsupported)', () => {
    assert.equal(resolveReasoningTier('high', []), null);
    assert.equal(resolveReasoningTier('minimal', []), null);
    assert.equal(resolveReasoningTier(null, []), null);
  });

  test('a tier the engine supports passes through unchanged (identity — the case today)', () => {
    for (const t of RANGE) assert.equal(resolveReasoningTier(t, RANGE), t);
  });

  test('an unknown tier string throws, naming the known tiers (no silent clamp)', () => {
    assert.throws(() => resolveReasoningTier('turbo', RANGE), /Unknown reasoning tier/);
    assert.throws(() => resolveReasoningTier('turbo', RANGE), /minimal, low, medium, high, xhigh, max/);
  });

  test('a tier below the range floor clamps up to the floor', () => {
    // 'minimal' (rank 0) is below the fixture's floor 'low' (rank 1) → clamp up to 'low'.
    assert.equal(resolveReasoningTier('minimal', RANGE), 'low');
  });

  test('a tier above the range ceiling clamps down to the ceiling', () => {
    // 'max' (rank 4) is above the fixture's ceiling 'high' (rank 3) → clamp down to 'high'.
    assert.equal(resolveReasoningTier('max', RANGE), 'high');
  });

  test('on a distance tie, the LOWER (cheaper) rung wins', () => {
    // Range with a gap: 'medium' (rank 2) is equidistant from 'low' (1) and 'high' (3).
    assert.equal(resolveReasoningTier('medium', ['low', 'high']), 'low');
  });

  test('an engine range carrying a rung unknown to the ladder throws (symmetric validation)', () => {
    // [LAW:no-silent-failure] the mirror of the unknown-tier throw: a malformed range must red the
    // run, not poison the clamp with a NaN distance and silently drop the axis.
    assert.throws(() => resolveReasoningTier('high', ['low', 'extreme']), /unknown to the tier ladder/);
    assert.throws(() => resolveReasoningTier(null, ['bogus']), /unknown to the tier ladder/);
  });
});

// The acceptance criterion: assert reasoning-tier clamping against each ADAPTER's declared range,
// read from the registry (the single source of truth), so the test tracks the real capabilities.
describe('resolveReasoningTier — against each adapter’s declared reasoning-effort range', () => {
  const ENGINES = ['claude-code', 'codex', 'opencode'];
  const ALL_TIERS = Object.keys(TIER_RANK);

  // [LAW:no-silent-failure] [LAW:one-source-of-truth] The enforced invariant behind resolveReasoningTier:
  // every rung an adapter declares must be known to the tier ladder. This is what makes the resolver
  // safe (no NaN-poisoned clamp) AND ties the adapter ranges to the one vocabulary — an adapter adding
  // a rung without teaching TIER_RANK reds CI here, not silently at runtime.
  test('every adapter’s declared range is a subset of the tier ladder', () => {
    for (const name of ENGINES) {
      for (const e of registry.get(name).capabilities.reasoningEfforts) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(TIER_RANK, e),
          `${name} declares reasoning effort '${e}', missing from TIER_RANK`,
        );
      }
    }
  });

  for (const name of ENGINES) {
    const range = registry.get(name).capabilities.reasoningEfforts;

    test(`${name}: every abstract tier resolves to a value the engine actually supports (or null)`, () => {
      for (const tier of ALL_TIERS) {
        const resolved = resolveReasoningTier(tier, range);
        if (range.length === 0) {
          assert.equal(resolved, null, `${name} declares no range, so ${tier} must resolve to null`);
        } else {
          assert.ok(range.includes(resolved), `${name}: ${tier} resolved to ${resolved}, not in ${range.join(',')}`);
        }
      }
    });

    test(`${name}: null always resolves to null (engine default preserved)`, () => {
      assert.equal(resolveReasoningTier(null, range), null);
    });
  }

  test('opencode (empty range) ignores the axis for every tier', () => {
    const range = registry.get('opencode').capabilities.reasoningEfforts;
    assert.deepEqual(range, []);
    for (const tier of ALL_TIERS) assert.equal(resolveReasoningTier(tier, range), null);
  });

  test('claude-code clamps codex-only tiers into its own range', () => {
    const range = registry.get('claude-code').capabilities.reasoningEfforts;
    assert.equal(resolveReasoningTier('minimal', range), 'low');   // below floor → floor
    assert.equal(resolveReasoningTier('xhigh', range), 'max');     // codex ceiling → claude ceiling
  });

  test('codex clamps claude-only tiers into its own range', () => {
    const range = registry.get('codex').capabilities.reasoningEfforts;
    assert.equal(resolveReasoningTier('max', range), 'xhigh');     // claude ceiling → codex ceiling
  });
});
