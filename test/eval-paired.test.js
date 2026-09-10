'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parseArgs, planKey, canonicalize, readArm, pairArms, agreedCaseSet, agreedPlanSet, agreedInventory,
  binomialTailHalf, mcnemarExact, reducePaired, renderPairedMarkdown,
} = require('../eval/paired');
const { PLAN_SCHEMA } = require('../src/plan');
const { EFFORT_SCHEMA } = require('../src/effort');

// [LAW:verifiable-goals] AC (copirate-determinism-5od.w2r): an A/B over a pinned plan set reports
// discordant pairs and a paired p-value alongside the two pooled rates, and the pairing is by
// (case, plan, finding) and refuses to pair runs whose plans differ.
// [LAW:behavior-not-structure] These assert the reducer's CONTRACT — which pairs come out, which inputs
// are refused, and what the statistic equals against a hand-computed binomial — never its internals.

// ── fixtures ───────────────────────────────────────────────────────────────────────────────────────

const PLAN_ONE_SCOPE = { context: 'the shared context', scopes: [{ name: 'all', focus: 'everything', files: ['a.ts', 'b.ts'] }] };
const PLAN_TWO_SCOPES = {
  context: 'the shared context',
  scopes: [
    { name: 'first', focus: 'the first half', files: ['a.ts'] },
    { name: 'second', focus: 'the second half', files: ['b.ts'] },
  ],
};

// One run dir on disk, exactly as run-case.js + score.js leave it: meta.json, plan.json, findings.json
// (the marker that makes a dir a run), and scorecard.json. `found`/`missed` are must-find comment ids.
function writeRun(caseDir, name, { plan = PLAN_ONE_SCOPE, provenance = 'pinned', sweepCap = 2, found = [], missed = [], omit = null } = {}) {
  const dir = path.join(caseDir, name);
  fs.mkdirSync(dir, { recursive: true });
  const write = (file, value) => {
    if (omit === file) return;
    fs.writeFileSync(path.join(dir, file), JSON.stringify(value, null, 2) + '\n');
  };
  write('meta.json', {
    case: path.basename(caseDir),
    effort: { roundCap: 0, sweepCap, reasoningTier: null, readSet: 'assigned' },
    effortSchema: EFFORT_SCHEMA,
  });
  write('plan.json', { planSchema: PLAN_SCHEMA, provenance, scoutUsage: null, ...plan });
  write('findings.json', []);
  write('scorecard.json', {
    inventoryMustFind: { total: found.length + missed.length, found: found.length, foundIds: found, missedIds: missed },
  });
  return dir;
}

// An arm root: one case dir per entry, each holding its runs.
function writeArm(root, cases) {
  fs.mkdirSync(root, { recursive: true });
  for (const [caseName, runs] of Object.entries(cases)) {
    const caseDir = path.join(root, caseName);
    fs.mkdirSync(caseDir, { recursive: true });
    runs.forEach((run, i) => writeRun(caseDir, `2026-09-10T0${i}-00-00-000Z-run1`, run));
  }
  return root;
}

function tmpRoot(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'paired-test-')), name);
}

// ── arg parsing ────────────────────────────────────────────────────────────────────────────────────

test('parseArgs takes two arm roots and an optional --out', () => {
  const o = parseArgs(['eval/out/a', 'eval/out/b', '--out=eval/out/p']);
  assert.equal(o.armA, 'eval/out/a');
  assert.equal(o.armB, 'eval/out/b');
  assert.equal(o.out, 'eval/out/p');
  assert.equal(parseArgs(['-h']).help, true);
});

test('parseArgs refuses missing, extra, and self-paired arms', () => {
  assert.throws(() => parseArgs(['eval/out/a']), /Missing arm roots/);
  assert.throws(() => parseArgs(['a', 'b', 'c']), /Unexpected third positional/);
  assert.throws(() => parseArgs(['a', './a']), /resolve to/);
  assert.throws(() => parseArgs(['a', 'b', '--nope=1']), /Unknown option/);
  assert.throws(() => parseArgs(['a', 'b', '--out']), /requires a non-empty value/);
});

// ── plan identity ──────────────────────────────────────────────────────────────────────────────────

test('planKey is the partition, not the producer: provenance and scout price do not change it', () => {
  const scouted = { ...PLAN_ONE_SCOPE, provenance: 'scout', scoutUsage: { tokens: 122000 } };
  const pinned = { ...PLAN_ONE_SCOPE, provenance: 'pinned', scoutUsage: null };
  assert.equal(planKey(scouted), planKey(pinned));
});

test('planKey distinguishes different partitions and survives key reordering', () => {
  assert.notEqual(planKey(PLAN_ONE_SCOPE), planKey(PLAN_TWO_SCOPES));
  const reordered = { scopes: [{ files: ['a.ts', 'b.ts'], focus: 'everything', name: 'all' }], context: 'the shared context' };
  assert.equal(planKey(reordered), planKey(PLAN_ONE_SCOPE));
  // A differing context is a differing plan: it is prefixed onto every worker's focus.
  assert.notEqual(planKey({ ...PLAN_ONE_SCOPE, context: 'other' }), planKey(PLAN_ONE_SCOPE));
  assert.deepEqual(canonicalize({ b: 1, a: [{ d: 2, c: 3 }] }), { a: [{ c: 3, d: 2 }], b: 1 });
});

// ── pairing ────────────────────────────────────────────────────────────────────────────────────────

test('pairs are keyed by (case, plan, finding) across every replicate', () => {
  const a = writeArm(tmpRoot('armA'), {
    'case-one': [{ found: [1], missed: [2] }, { found: [1, 2], missed: [] }],
    'case-two': [{ found: [7], missed: [] }, { found: [], missed: [7] }],
  });
  const b = writeArm(tmpRoot('armB'), {
    'case-one': [{ sweepCap: 0, found: [], missed: [1, 2] }, { sweepCap: 0, found: [2], missed: [1] }],
    'case-two': [{ sweepCap: 0, found: [7], missed: [] }, { sweepCap: 0, found: [7], missed: [] }],
  });
  const { pairs, blocks } = pairArms(readArm(a, 'A'), readArm(b, 'B'));

  // 2 cases × 1 plan each × 2 replicates × (2, 1) findings = 6 pairs.
  assert.equal(pairs.length, 6);
  assert.deepEqual(
    pairs.map(p => `${p.case}/${p.replicate}/${p.findingId}:${p.a ? 'A' : '-'}${p.b ? 'B' : '-'}`),
    ['case-one/0/1:A-', 'case-one/0/2:--', 'case-one/1/1:A-', 'case-one/1/2:AB', 'case-two/0/7:AB', 'case-two/1/7:-B'],
  );
  // Every pair's two halves ran the same plan — that is what the pairing asserts.
  assert.equal(new Set(pairs.map(p => p.planKey)).size, 1);
  assert.deepEqual(blocks.map(bl => ({ case: bl.case, scopeCount: bl.scopeCount, replicates: bl.replicates, findings: bl.findings, provenance: bl.provenance })), [
    { case: 'case-one', scopeCount: 1, replicates: 2, findings: 2, provenance: 'pinned' },
    { case: 'case-two', scopeCount: 1, replicates: 2, findings: 1, provenance: 'pinned' },
  ]);
});

test('a case replayed against several distinct plans blocks on each of them', () => {
  const runs = [{ plan: PLAN_ONE_SCOPE, found: [1], missed: [] }, { plan: PLAN_TWO_SCOPES, found: [], missed: [1] }];
  const a = writeArm(tmpRoot('armA'), { 'case-one': runs });
  const b = writeArm(tmpRoot('armB'), { 'case-one': runs.map(r => ({ ...r, sweepCap: 0 })) });
  const { pairs, blocks } = pairArms(readArm(a, 'A'), readArm(b, 'B'));
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.map(bl => bl.scopeCount).sort(), [1, 2]);
  assert.equal(pairs.length, 2);
  assert.equal(new Set(pairs.map(p => p.planKey)).size, 2);
});

// ── the refusals ───────────────────────────────────────────────────────────────────────────────────

test('runs whose plans differ are refused, not paired', () => {
  const a = writeArm(tmpRoot('armA'), { 'case-one': [{ plan: PLAN_ONE_SCOPE, found: [1], missed: [] }] });
  const b = writeArm(tmpRoot('armB'), { 'case-one': [{ plan: PLAN_TWO_SCOPES, sweepCap: 0, found: [1], missed: [] }] });
  assert.throws(
    () => pairArms(readArm(a, 'A'), readArm(b, 'B')),
    /did not replay the same plans[\s\S]*1 scope\(s\) ×1[\s\S]*2 scope\(s\) ×1/,
  );
});

test('unequal replicate counts within a block are refused rather than trimmed to the shorter arm', () => {
  const a = writeArm(tmpRoot('armA'), { 'case-one': [{ found: [1], missed: [] }, { found: [1], missed: [] }] });
  const b = writeArm(tmpRoot('armB'), { 'case-one': [{ sweepCap: 0, found: [1], missed: [] }] });
  assert.throws(() => pairArms(readArm(a, 'A'), readArm(b, 'B')), /did not replay the same plans/);
});

test('a case present in only one arm is refused, not silently intersected', () => {
  const a = writeArm(tmpRoot('armA'), { 'case-one': [{ found: [1], missed: [] }], 'case-two': [{ found: [7], missed: [] }] });
  const b = writeArm(tmpRoot('armB'), { 'case-one': [{ sweepCap: 0, found: [1], missed: [] }] });
  assert.throws(() => pairArms(readArm(a, 'A'), readArm(b, 'B')), /different case sets[\s\S]*case-two/);
});

test('a run that recorded no plan cannot be paired and says so by name', () => {
  const a = writeArm(tmpRoot('armA'), { 'case-one': [{ found: [1], missed: [], omit: 'plan.json' }] });
  assert.throws(() => readArm(a, 'A'), /recorded no plan[\s\S]*no plan\.json/);
});

test('an unscored run is refused before it can be paired', () => {
  const a = writeArm(tmpRoot('armA'), { 'case-one': [{ found: [1], missed: [], omit: 'scorecard.json' }] });
  assert.throws(() => readArm(a, 'A'), /is unscored/);
});

test('an arm root that blended two efforts is refused', () => {
  const a = writeArm(tmpRoot('armA'), { 'case-one': [{ sweepCap: 2, found: [1], missed: [] }, { sweepCap: 0, found: [1], missed: [] }] });
  assert.throws(() => readArm(a, 'A'), /ran at effort roundCap=0 sweepCap=0 .* but earlier runs ran at roundCap=0 sweepCap=2 /);
});

test('a case whose must-find inventory moved between replays is refused', () => {
  const a = writeArm(tmpRoot('armA'), { 'case-one': [{ found: [1], missed: [2] }] });
  const b = writeArm(tmpRoot('armB'), { 'case-one': [{ sweepCap: 0, found: [1], missed: [] }] });
  assert.throws(() => pairArms(readArm(a, 'A'), readArm(b, 'B')), /inventory moved between these replays/);
});

// ── the statistic ──────────────────────────────────────────────────────────────────────────────────

// Hand-computed exact binomial sums, not a remembered table: sum_{i<=k} C(n,i) / 2^n in integer
// arithmetic, so the assertion is independent of the log-space implementation under test.
function exactTail(n, k) {
  let choose = 1;
  let sum = 0;
  for (let i = 0; i <= k; i++) {
    sum += choose;
    choose = (choose * (n - i)) / (i + 1);
  }
  return sum / 2 ** n;
}

test('binomialTailHalf matches an exact integer-arithmetic binomial sum', () => {
  for (const [n, k] of [[9, 1], [10, 5], [20, 3], [1, 0], [100, 40]]) {
    assert.ok(Math.abs(binomialTailHalf(n, k) - exactTail(n, k)) < 1e-12, `n=${n} k=${k}`);
  }
});

test('mcnemarExact is the two-sided sign test on the discordant pairs', () => {
  // b=8, c=1: (C(9,0)+C(9,1))/2^9 = 10/512, doubled = 0.0390625. (The log-space sum is exact to ~1e-16,
  // not bit-exact, so every p assertion here carries a tolerance.)
  assert.ok(Math.abs(mcnemarExact(8, 1) - 0.0390625) < 1e-12);
  // Symmetric in its arguments — which arm won does not change the evidence that one did.
  assert.equal(mcnemarExact(1, 8), mcnemarExact(8, 1));
  // Perfectly balanced discordance is no evidence at all, and is capped at 1 rather than exceeding it.
  assert.equal(mcnemarExact(5, 5), 1);
  // No discordant pairs: the arms disagreed nowhere, so there is no evidence of a difference.
  assert.equal(mcnemarExact(0, 0), 1);
});

test('reducePaired reports discordant pairs, both pooled rates, and the resolution it bought', () => {
  const pair = (a, b) => ({ case: 'c', planKey: 'k', replicate: 0, findingId: '1', a, b });
  const pairs = [
    ...Array.from({ length: 10 }, () => pair(true, true)),
    ...Array.from({ length: 8 }, () => pair(true, false)),
    pair(false, true),
    ...Array.from({ length: 81 }, () => pair(false, false)),
  ];
  const s = reducePaired(pairs);
  assert.equal(s.pairs, 100);
  assert.deepEqual([s.bothFound, s.discordantAB, s.discordantBA, s.bothMissed], [10, 8, 1, 81]);
  assert.equal(s.discordant, 9);
  assert.equal(s.rateA, 0.18);
  assert.equal(s.rateB, 0.11);
  assert.ok(Math.abs(s.difference - 0.07) < 1e-12);
  assert.ok(Math.abs(s.standardError - Math.sqrt(9) / 100) < 1e-12);
  assert.ok(Math.abs(s.mde95 - 1.96 * 0.03) < 1e-12);
  assert.ok(Math.abs(s.p - 0.0390625) < 1e-12);
});

test('reducePaired over an empty set is a typed absence, never a rate of zero', () => {
  const s = reducePaired([]);
  assert.equal(s.pairs, 0);
  assert.equal(s.rateA, null);
  assert.equal(s.rateB, null);
  assert.equal(s.difference, null);
  assert.equal(s.mde95, null);
  assert.equal(s.p, 1);
});

// ── the report ─────────────────────────────────────────────────────────────────────────────────────

test('the report states discordant pairs, the paired p-value, and both pooled rates', () => {
  const pair = (a, b) => ({ case: 'c', planKey: 'k', replicate: 0, findingId: '1', a, b });
  const stat = reducePaired([...Array.from({ length: 8 }, () => pair(true, false)), pair(false, true), pair(true, true)]);
  const md = renderPairedMarkdown({
    armA: { label: 'ab-sweep2', root: '/x/ab-sweep2', effort: 'sweepCap=2' },
    armB: { label: 'ab-sweep0', root: '/x/ab-sweep0', effort: 'sweepCap=0' },
    cases: ['case-one'],
    blocks: [{ case: 'case-one', scopeCount: 3, provenance: 'pinned', replicates: 5, findings: 2, stat }],
    stat,
  });
  assert.match(md, /8 pair\(s\) found only by A, 1 only by B/);
  assert.match(md, /exact McNemar \*\*p = 0\.0391\*\*/);
  assert.match(md, /A 90\.0% vs B 20\.0%/);
  assert.match(md, /approximate 95% resolution \*\*58\.8%\*\*/);
  assert.match(md, /VERDICT: arm A found more/);
  assert.match(md, /\| `case-one` \| 3 \| pinned \| 5 \| 2 \| 8 \| 1 \| 1 \| 0 \|/);
});

test('a null result names the effect it could not have seen', () => {
  const stat = reducePaired([{ case: 'c', planKey: 'k', replicate: 0, findingId: '1', a: true, b: true }]);
  const md = renderPairedMarkdown({
    armA: { label: 'a', root: '/x/a', effort: 'e' },
    armB: { label: 'b', root: '/x/b', effort: 'e' },
    cases: ['c'], blocks: [], stat,
  });
  assert.match(md, /VERDICT: no measured difference/);
  assert.match(md, /against an approximate 95% resolution of 0\.0%/);
});

// ── the shared checkpoints, directly ────────────────────────────────────────────────────────────────

test('agreedCaseSet, agreedPlanSet and agreedInventory are the refusals, and pass what lines up', () => {
  const arm = (label, runs) => ({ label, root: `/x/${label}`, runs });
  const run = (caseName, key, ids) => ({ dir: `/x/${caseName}`, case: caseName, planKey: key, provenance: 'pinned', outcomes: new Map(ids.map(id => [id, true])) });
  const a = arm('A', [run('c', '{"scopes":[1]}', ['1'])]);
  const b = arm('B', [run('c', '{"scopes":[1]}', ['1'])]);
  assert.deepEqual(agreedCaseSet(a, b), ['c']);
  assert.deepEqual(agreedInventory('c', [...a.runs, ...b.runs]), ['1']);
  const byPlan = (runs) => new Map(runs.map(r => [r.planKey, [r]]));
  assert.deepEqual(agreedPlanSet('c', a, byPlan(a.runs), b, byPlan(b.runs)), ['{"scopes":[1]}']);
});
