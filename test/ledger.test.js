'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { LEDGER_MARKER, ledgerEntryBody, sumCostToday, readSpentToday, appendCost } = require('../src/index.js');
const { costMarker, parseCost, parseCostRecord } = require('../src/usage');

// The resolved config every entry here is written under — costMarker records its model and endpoint
// host alongside the figure. These tests are about the DAY'S ACCOUNTING, not the recorded facts, so
// one config serves them all.
const CONFIG = {
  name: 'deepseek',
  engine: 'claude-code',
  model: 'deepseek-v4-pro',
  endpoint: { apiType: 'anthropic-messages', baseUrl: 'https://api.deepseek.com/anthropic', credential: { kind: 'api-key', value: 'k' } },
};
// A Usage value carrying the cost under test; the tokens are incidental here.
const usageOf = cost => ({ tokens: { inputCacheMiss: 10, inputCacheHit: 0, output: 5 }, cost });

// A machine-written ledger entry: the sentinel then the reused cost marker.
const entry = (usd, created_at) => ({ body: ledgerEntryBody(usageOf({ basis: 'dollars', usd }), CONFIG), created_at });
const unknownEntry = (created_at) => ({ body: ledgerEntryBody(usageOf({ basis: 'unpriced', reason: 'no-price' }), CONFIG), created_at });

const ZERO_TALLY = { total: 0, count: 0, unknownCount: 0 };

const NOON = new Date('2026-07-11T12:00:00Z'); // today (UTC) = 2026-07-11

describe('ledgerEntryBody', () => {
  test('leads with the sentinel, then the reused cost marker (one representation, not a second)', () => {
    assert.equal(
      ledgerEntryBody(usageOf({ basis: 'dollars', usd: 0.05 }), CONFIG),
      `${LEDGER_MARKER}\n${costMarker(usageOf({ basis: 'dollars', usd: 0.05 }), CONFIG)}`,
    );
  });

  // zai-timing-31d.2 — an entry records what a review SPENT; it has no round of its own to time, and
  // an absent duration is what that looks like. A ledger entry claiming a wall clock would put a
  // second, unrelated summand in front of any reader folding durations out of marker-bearing bodies.
  test('an entry records no duration — a spend line has no wall clock of its own', () => {
    const record = parseCostRecord(ledgerEntryBody(usageOf({ basis: 'dollars', usd: 0.05 }), CONFIG));
    assert.equal(record.totalMs, null);
    assert.deepEqual(record.cost, { basis: 'dollars', usd: 0.05 }); // …and it still records the spend
  });

  test('an unavailable cost writes an honest `unknown` marker, never a fabricated zero', () => {
    const body = ledgerEntryBody(usageOf({ basis: 'unpriced', reason: 'no-price' }), CONFIG);
    assert.ok(body.startsWith(`${LEDGER_MARKER}\n`), `entry must lead with the sentinel: ${body}`);
    // The figure is absent from the record, so it reads back as an unknown-cost round — never $0.
    assert.deepEqual(parseCost(body), { basis: 'unpriced', reason: 'not-reported' });
  });
});

describe('sumCostToday', () => {
  test('sums only entries dated today (UTC of now); yesterday and tomorrow are excluded', () => {
    const spent = sumCostToday([
      entry(0.10, '2026-07-11T03:00:00Z'), // today, early
      entry(0.20, '2026-07-11T23:59:59Z'), // today, late
      entry(9.99, '2026-07-10T23:59:59Z'), // yesterday — excluded
      entry(9.99, '2026-07-12T00:00:00Z'), // tomorrow — excluded
    ], NOON);
    assert.equal(Number(spent.total.toFixed(2)), 0.30);
    assert.equal(spent.count, 2);
  });

  test('the day boundary is UTC, not local — an entry just after UTC midnight counts, just before does not', () => {
    // now is early in the UTC day; a negative-offset LOCAL tz would call the 23:59:59Z instant "today",
    // but UTC-day comparison does not — proving the filter is UTC.
    const earlyUtc = new Date('2026-07-11T00:30:00Z');
    const spent = sumCostToday([
      entry(0.10, '2026-07-11T00:00:01Z'), // today (UTC) — included
      entry(0.10, '2026-07-10T23:59:59Z'), // yesterday (UTC) — excluded
    ], earlyUtc);
    assert.equal(spent.count, 1);
  });

  test('[LAW:single-enforcer] a comment NOT leading with the sentinel is excluded even if it carries a cost marker (human quote)', () => {
    const humanQuote = { body: `I see the bot posts ${LEDGER_MARKER} ${costMarker(usageOf({ basis: 'dollars', usd: 999 }), CONFIG)} — my own note`, created_at: '2026-07-11T10:00:00Z' };
    assert.deepEqual(sumCostToday([humanQuote], NOON), ZERO_TALLY); // not summed, not even counted as an entry
  });

  test('leading whitespace before the sentinel is tolerated (trimStart)', () => {
    const spent = sumCostToday([
      { body: `\n  ${ledgerEntryBody(usageOf({ basis: 'dollars', usd: 0.07 }), CONFIG)}`, created_at: '2026-07-11T10:00:00Z' },
    ], NOON);
    assert.equal(spent.count, 1);
  });

  test('[LAW:no-silent-failure] a today entry with an unknown cost is counted as unknown, never dropped', () => {
    const spent = sumCostToday([
      entry(0.05, '2026-07-11T09:00:00Z'),
      unknownEntry('2026-07-11T10:00:00Z'),
    ], NOON);
    assert.equal(Number(spent.total.toFixed(2)), 0.05);
    assert.equal(spent.count, 1);
    assert.equal(spent.unknownCount, 1); // the day's spend is an honest lower bound
  });

  // An entry posted before 1.69.0 for a Claude subscription run carries the legacy notional marker. Its
  // figure is that run's API-price cost, so it is the day's spend like any other — dropping it would
  // under-count the budget by every such review already on the ledger.
  test("a legacy subscription entry is counted as the API-price cost it records", () => {
    const legacy = { body: `${LEDGER_MARKER}\n<!-- agent-review-notional-usd:{"notionalUsd":63.59} -->`, created_at: '2026-07-11T10:00:00Z' };
    const spent = sumCostToday([entry(0.05, '2026-07-11T09:00:00Z'), legacy], NOON);
    assert.equal(Number(spent.total.toFixed(2)), 63.64);
    assert.equal(spent.count, 2);
    assert.equal(spent.unknownCount, 0);
  });

  test('a non-string body is tolerated (skipped, not a crash)', () => {
    assert.equal(sumCostToday([{ body: null, created_at: '2026-07-11T10:00:00Z' }], NOON).count, 0);
  });

  test('no comments yields zeroes', () => {
    assert.deepEqual(sumCostToday([], NOON), ZERO_TALLY);
  });

  test('[LAW:no-silent-failure] a real ledger entry with a corrupt timestamp fails loud, never a silent wrong-day', () => {
    assert.throws(() => sumCostToday([entry(0.05, 'not-a-date')], NOON), /Invalid time value/);
  });

  test('a NON-ledger comment with a bad/absent timestamp is skipped by the sentinel gate first — no crash', () => {
    // The gate is checked before the date parse, so a stray human comment cannot red the run on its timestamp.
    assert.equal(sumCostToday([{ body: 'a human note', created_at: 'garbage' }], NOON).count, 0);
  });
});

describe('readSpentToday', () => {
  const fakeOctokit = (pages) => ({
    rest: { issues: { listComments: async ({ page }) => ({ data: pages[page - 1] || [] }) } },
  });

  test('sums today across the ledger issue, filtering out other days', async () => {
    const octokit = fakeOctokit([[
      entry(0.05, '2026-07-11T08:00:00Z'),
      entry(0.03, '2026-07-11T09:00:00Z'),
      entry(9.99, '2026-07-10T09:00:00Z'), // yesterday — excluded
    ]]);
    const spent = await readSpentToday(octokit, 'o', 'r', 42, NOON);
    assert.equal(Number(spent.total.toFixed(2)), 0.08);
    assert.equal(spent.count, 2);
  });

  test('exhausts pagination — a full first page forces a second fetch (spend spans pages)', async () => {
    const full = Array.from({ length: 100 }, () => entry(0.01, '2026-07-11T08:00:00Z'));
    const octokit = fakeOctokit([full, [entry(0.01, '2026-07-11T08:00:00Z'), { body: 'human note', created_at: '2026-07-11T08:00:00Z' }]]);
    const spent = await readSpentToday(octokit, 'o', 'r', 42, NOON);
    assert.equal(spent.count, 101);
    assert.equal(Number(spent.total.toFixed(2)), 1.01);
  });

  test('an empty ledger issue yields zeroes', async () => {
    assert.deepEqual(await readSpentToday(fakeOctokit([[]]), 'o', 'r', 42, NOON), ZERO_TALLY);
  });

  test('the issue number is threaded to the API', async () => {
    const seen = [];
    const octokit = { rest: { issues: { listComments: async (args) => { seen.push(args.issue_number); return { data: [] }; } } } };
    await readSpentToday(octokit, 'o', 'r', 777, NOON);
    assert.deepEqual(seen, [777]);
  });
});

describe('appendCost', () => {
  const capturingOctokit = (calls) => ({
    rest: { issues: { createComment: async (args) => { calls.push(args); return { data: { id: 1 } }; } } },
  });

  test('posts exactly one comment carrying the sentinel + cost marker to the ledger issue', async () => {
    const calls = [];
    await appendCost(capturingOctokit(calls), 'o', 'r', 42, usageOf({ basis: 'dollars', usd: 0.05 }), CONFIG);
    assert.equal(calls.length, 1);
    assert.deepEqual(
      { owner: calls[0].owner, repo: calls[0].repo, issue_number: calls[0].issue_number },
      { owner: 'o', repo: 'r', issue_number: 42 },
    );
    assert.equal(calls[0].body, `${LEDGER_MARKER}\n${costMarker(usageOf({ basis: 'dollars', usd: 0.05 }), CONFIG)}`);
  });

  test('an unavailable cost still appends an entry, marked unknown (a review happened; its cost is unknown)', async () => {
    const calls = [];
    await appendCost(capturingOctokit(calls), 'o', 'r', 42, usageOf({ basis: 'unpriced', reason: 'not-reported' }), CONFIG);
    assert.ok(calls[0].body.startsWith(`${LEDGER_MARKER}\n`), `entry must lead with the sentinel: ${calls[0].body}`);
    assert.deepEqual(parseCost(calls[0].body), { basis: 'unpriced', reason: 'not-reported' });
  });

  test('[LAW:no-silent-failure] an API error propagates — the module never swallows a failed append', async () => {
    const octokit = { rest: { issues: { createComment: async () => { throw new Error('403 issues:write missing'); } } } };
    await assert.rejects(() => appendCost(octokit, 'o', 'r', 42, usageOf({ basis: 'dollars', usd: 0.05 }), CONFIG), /issues:write/);
  });

  test('round-trips through the ledger: an appended entry is summed by readSpentToday on the same day', async () => {
    const store = [];
    const octokit = {
      rest: {
        issues: {
          createComment: async ({ body }) => { store.push({ body, created_at: NOON.toISOString() }); return { data: {} }; },
          listComments: async ({ page }) => ({ data: page === 1 ? store : [] }),
        },
      },
    };
    await appendCost(octokit, 'o', 'r', 42, usageOf({ basis: 'dollars', usd: 0.05 }), CONFIG);
    await appendCost(octokit, 'o', 'r', 42, usageOf({ basis: 'dollars', usd: 0.03 }), CONFIG);
    const spent = await readSpentToday(octokit, 'o', 'r', 42, NOON);
    assert.equal(Number(spent.total.toFixed(2)), 0.08);
    assert.equal(spent.count, 2);
  });
});
