'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert');

const { defaultEffortProfile, resolveReasoningTier, maxTier, TIER_RANK, readSetProjection, READ_SETS, DEFAULT_READ_SET, EFFORT_SCHEMA, UNVERSIONED_EFFORT_SCHEMA, EFFORT_SCHEMA_BACKFILL, effortAxes, recordEffort, completeEffort } = require('../src/effort');
const registry = require('../src/engine/registry');

describe('defaultEffortProfile', () => {
  test('carries only the axes it governs — no lane count; that is machine capacity, derived in the pool', () => {
    assert.deepEqual(defaultEffortProfile(), { roundCap: 0, sweepCap: 2, reasoningTier: null, readSet: 'assigned' });
  });

  test('defaults sweepCap to the convergence-sweep bound (2) and folds a supplied one', () => {
    assert.equal(defaultEffortProfile().sweepCap, 2);
    assert.equal(defaultEffortProfile({ sweepCap: 0 }).sweepCap, 0);
    assert.equal(defaultEffortProfile({ sweepCap: 5 }).sweepCap, 5);
  });

  test('defaults reasoningTier to null (propose no raise; the config tier stands)', () => {
    assert.equal(defaultEffortProfile().reasoningTier, null);
    assert.equal(defaultEffortProfile({ roundCap: 5 }).reasoningTier, null);
  });

  test('folds a supplied reasoningTier into the profile (the raising axis)', () => {
    assert.equal(defaultEffortProfile({ reasoningTier: 'high' }).reasoningTier, 'high');
  });

  test('defaults readSet to the shipped split-read arm and folds a supplied one', () => {
    assert.equal(defaultEffortProfile().readSet, 'assigned');
    assert.equal(defaultEffortProfile().readSet, DEFAULT_READ_SET);
    assert.equal(defaultEffortProfile({ readSet: 'changed' }).readSet, 'changed');
  });

  test('returns a fresh object each call (no shared mutable default)', () => {
    const a = defaultEffortProfile();
    a.sweepCap = 99;
    assert.equal(defaultEffortProfile().sweepCap, 2);
  });

  test('folds the supplied roundCap into the profile (the cost-bearing axis)', () => {
    assert.equal(defaultEffortProfile({ roundCap: 5 }).roundCap, 5);
    assert.equal(defaultEffortProfile({ roundCap: 0 }).roundCap, 0);
  });

  test('defaults roundCap to the neutral 0 (unlimited) sentinel when unsupplied', () => {
    assert.equal(defaultEffortProfile().roundCap, 0);
    assert.equal(defaultEffortProfile({}).roundCap, 0);
  });
});

describe('readSetProjection — the read-set arm, resolved to what a worker opens', () => {
  // The axis's CONTRACT: which files a worker opens in full, given its scope's assignment. Asserted
  // through the resolved projection — the only way a caller can reach the meaning — never by reading
  // the table directly, so a different table shape with the same behavior still passes.
  test("'assigned' reads exactly the scope's own files — the shipped split-read arm", () => {
    const files = ['a.js', 'b.js'];
    assert.deepEqual(readSetProjection('assigned')(files), files);
  });

  test("'changed' reads the whole changed set, spelled as prompt.js's empty-list value for it", () => {
    assert.deepEqual(readSetProjection('changed')(['a.js', 'b.js']), []);
  });

  test('the two arms disagree on the same scope — the A/B is expressible at all', () => {
    const files = ['a.js'];
    assert.notDeepEqual(readSetProjection('assigned')(files), readSetProjection('changed')(files));
  });

  test('every declared arm resolves to a projection — no name without a meaning', () => {
    for (const arm of READ_SETS) assert.equal(typeof readSetProjection(arm), 'function');
  });

  test('an arm outside the vocabulary throws, naming the known arms — never coalesced to the default', () => {
    // The measurement-integrity case: a silent fall back to 'assigned' would report the SHIPPED
    // behavior under the other arm's name, so the A/B would read as "no difference" and be believed.
    for (const bad of [undefined, null, '', 'all', 'ASSIGNED', 0]) {
      assert.throws(() => readSetProjection(bad), /Unknown read set/);
    }
  });
});

// maxTier is the per-config FLOOR reconciliation: difficulty proposes a raise, the config carries a
// baseline, and the effective tier is the higher of the two. These assert the value semantics that make
// difficulty a monotonic floor (it lifts an under-specified config, never lowers an explicit one).
describe('maxTier — the higher reasoning tier, difficulty as a monotonic floor', () => {
  test('both null → null (the byte-identical no-raise case)', () => {
    assert.equal(maxTier(null, null), null);
    assert.equal(maxTier(undefined, undefined), null);
    assert.equal(maxTier(null, undefined), null);
  });

  test('one operand null → the other (a raise onto an unset config, or a config with no raise)', () => {
    assert.equal(maxTier(null, 'high'), 'high');   // difficulty raises an unset config
    assert.equal(maxTier('low', null), 'low');     // config baseline, no raise proposed
    assert.equal(maxTier(undefined, 'medium'), 'medium');
  });

  test('the higher rank wins — difficulty LIFTS an under-specified config', () => {
    assert.equal(maxTier('low', 'high'), 'high');
    assert.equal(maxTier('high', 'low'), 'high');
    assert.equal(maxTier('medium', 'max'), 'max');
  });

  test('an explicit high config is NEVER lowered by a smaller proposed raise', () => {
    assert.equal(maxTier('max', 'high'), 'max');   // config wins: difficulty only raises, never caps
    assert.equal(maxTier('xhigh', 'medium'), 'xhigh');
  });

  test('equal rank keeps the FIRST operand — pass the (engine-valid) config tier first', () => {
    // xhigh and max share rank 4 (each engine's ceiling); the config names the one its engine accepts,
    // so it must survive a same-rank proposal rather than being swapped for the abstract one.
    assert.equal(maxTier('max', 'xhigh'), 'max');
    assert.equal(maxTier('xhigh', 'max'), 'xhigh');
  });

  test('an unknown tier is a caller bug — throws, never silently coalesces to the known one', () => {
    assert.throws(() => maxTier('turbo', 'high'), /Unknown reasoning tier/);
    assert.throws(() => maxTier('high', 'ludicrous'), /Unknown reasoning tier/);
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

// [LAW:verifiable-goals] AC (copirate-determinism-5od.emv): a run record must carry a COMPLETE, versioned
// profile derived from the type — so that adding an axis to defaultEffortProfile and forgetting the
// recorder is a loud failure rather than a fact silently destroyed at write time.
describe('the recorded effort profile is complete and versioned', () => {
  test('the demanded axis set is READ OFF the type, so a new axis is demanded the moment it exists', () => {
    // Not a second list that a new axis would have to remember to join — the same keys, derived.
    assert.deepEqual(effortAxes(), Object.keys(defaultEffortProfile()));
  });

  test('every axis of the type is required of a current-schema record — the loop grows with the type', () => {
    // This is the "added an axis and forgot the recorder" failure, stated once against the type rather
    // than once per axis: whatever axes exist, omitting any one of them is refused BY NAME. A future axis
    // is covered by this test on the day it is added, with no edit here.
    for (const axis of effortAxes()) {
      const gapped = { ...defaultEffortProfile() };
      delete gapped[axis];
      assert.throws(
        () => completeEffort({ effort: gapped, effortSchema: EFFORT_SCHEMA }),
        new RegExp(`missing ${axis}`),
        `omitting '${axis}' at the current schema must be refused, not filled`,
      );
    }
  });

  test('producer and reader agree over the type: a recorded default profile round-trips unchanged', () => {
    const profile = defaultEffortProfile();
    const record = recordEffort(profile);
    assert.equal(record.effortSchema, EFFORT_SCHEMA);
    assert.deepEqual(completeEffort(record), profile);
  });

  test('the unversioned era resolves to the arm the code structurally had, in either spelling of absence', () => {
    // bfcd889 (2026-07-06) shipped scope-bounded reads before every stored run, so a record from before the
    // axis existed did not choose 'assigned' — it could not have done anything else.
    const era = { roundCap: 0, sweepCap: 2, reasoningTier: null };
    assert.equal(completeEffort({ effort: era }).readSet, 'assigned');
    assert.equal(completeEffort({ effort: { ...era, readSet: null } }).readSet, 'assigned');
    assert.equal(completeEffort({ effort: era, effortSchema: UNVERSIONED_EFFORT_SCHEMA }).readSet, 'assigned');
  });

  test('a back-filled axis never overwrites a value the record actually carries', () => {
    const era = { roundCap: 0, sweepCap: 2, reasoningTier: null, readSet: 'changed' };
    assert.equal(completeEffort({ effort: era }).readSet, 'changed');
    // ...and an axis no row names passes through untouched, which is what keeps reasoningTier's REAL null
    // (meaning "propose no raise") from being read as an absence and filled.
    assert.equal(completeEffort({ effort: era }).reasoningTier, null);
  });

  test('the back-fill is a historical fact, not a mirror of the current default', () => {
    // If DEFAULT_READ_SET ever moves, what those 40 stored runs did does not move with it. The row is
    // spelled out for exactly this reason, so the test states it rather than comparing to the default.
    assert.equal(EFFORT_SCHEMA_BACKFILL[UNVERSIONED_EFFORT_SCHEMA].readSet, 'assigned');
    // The current version supplies nothing: its records are complete by construction.
    assert.deepEqual(EFFORT_SCHEMA_BACKFILL[EFFORT_SCHEMA], {});
  });

  test('a schema with no row is refused, never interpreted through some other version\'s rules', () => {
    assert.throws(
      () => completeEffort({ effort: defaultEffortProfile(), effortSchema: 'copirate-effort/v99' }),
      /Unknown effort schema "copirate-effort\/v99"/,
    );
  });
});
