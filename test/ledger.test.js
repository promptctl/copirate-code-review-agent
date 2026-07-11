'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { LEDGER_MARKER, ledgerEntryBody, sumCostToday, readSpentToday, appendCost } = require('../src/index.js');
const { costMarker } = require('../src/usage');

// A machine-written ledger entry: the sentinel then the reused cost marker.
const entry = (usd, created_at) => ({ body: ledgerEntryBody({ available: true, usd }), created_at });
const unknownEntry = (created_at) => ({ body: ledgerEntryBody({ available: false, reason: 'no-price' }), created_at });

const NOON = new Date('2026-07-11T12:00:00Z'); // today (UTC) = 2026-07-11

describe('ledgerEntryBody', () => {
  test('leads with the sentinel, then the reused cost marker (one representation, not a second)', () => {
    assert.equal(
      ledgerEntryBody({ available: true, usd: 0.05 }),
      `${LEDGER_MARKER}\n${costMarker({ available: true, usd: 0.05 })}`,
    );
  });

  test('an unavailable cost writes an honest `unknown` marker, never a fabricated zero', () => {
    assert.equal(ledgerEntryBody({ available: false, reason: 'no-price' }), `${LEDGER_MARKER}\n<!-- agent-review-cost-usd:unknown -->`);
  });
});

describe('sumCostToday', () => {
  test('sums only entries dated today (UTC of now); yesterday and tomorrow are excluded', () => {
    const { usd, knownEntries } = sumCostToday([
      entry(0.10, '2026-07-11T03:00:00Z'), // today, early
      entry(0.20, '2026-07-11T23:59:59Z'), // today, late
      entry(9.99, '2026-07-10T23:59:59Z'), // yesterday — excluded
      entry(9.99, '2026-07-12T00:00:00Z'), // tomorrow — excluded
    ], NOON);
    assert.equal(Number(usd.toFixed(2)), 0.30);
    assert.equal(knownEntries, 2);
  });

  test('the day boundary is UTC, not local — an entry just after UTC midnight counts, just before does not', () => {
    // now is early in the UTC day; a negative-offset LOCAL tz would call the 23:59:59Z instant "today",
    // but UTC-day comparison does not — proving the filter is UTC.
    const earlyUtc = new Date('2026-07-11T00:30:00Z');
    const { knownEntries } = sumCostToday([
      entry(0.10, '2026-07-11T00:00:01Z'), // today (UTC) — included
      entry(0.10, '2026-07-10T23:59:59Z'), // yesterday (UTC) — excluded
    ], earlyUtc);
    assert.equal(knownEntries, 1);
  });

  test('[LAW:single-enforcer] a comment NOT leading with the sentinel is excluded even if it carries a cost marker (human quote)', () => {
    const humanQuote = { body: `I see the bot posts ${LEDGER_MARKER} ${costMarker({ available: true, usd: 999 })} — my own note`, created_at: '2026-07-11T10:00:00Z' };
    const { usd, knownEntries, unknownEntries } = sumCostToday([humanQuote], NOON);
    assert.equal(usd, 0); // the human's $999 is NOT summed
    assert.equal(knownEntries, 0);
    assert.equal(unknownEntries, 0); // not even counted as an entry — it is not one
  });

  test('leading whitespace before the sentinel is tolerated (trimStart)', () => {
    const { knownEntries } = sumCostToday([
      { body: `\n  ${ledgerEntryBody({ available: true, usd: 0.07 })}`, created_at: '2026-07-11T10:00:00Z' },
    ], NOON);
    assert.equal(knownEntries, 1);
  });

  test('[LAW:no-silent-failure] a today entry with an unknown cost is counted as unknown, never dropped', () => {
    const { usd, knownEntries, unknownEntries } = sumCostToday([
      entry(0.05, '2026-07-11T09:00:00Z'),
      unknownEntry('2026-07-11T10:00:00Z'),
    ], NOON);
    assert.equal(Number(usd.toFixed(2)), 0.05);
    assert.equal(knownEntries, 1);
    assert.equal(unknownEntries, 1); // the day's spend is an honest lower bound
  });

  test('a non-string body is tolerated (skipped, not a crash)', () => {
    const { knownEntries } = sumCostToday([{ body: null, created_at: '2026-07-11T10:00:00Z' }], NOON);
    assert.equal(knownEntries, 0);
  });

  test('no comments yields zeroes', () => {
    assert.deepEqual(sumCostToday([], NOON), { usd: 0, knownEntries: 0, unknownEntries: 0 });
  });

  test('[LAW:no-silent-failure] a real ledger entry with a corrupt timestamp fails loud, never a silent wrong-day', () => {
    assert.throws(() => sumCostToday([entry(0.05, 'not-a-date')], NOON), /Invalid time value/);
  });

  test('a NON-ledger comment with a bad/absent timestamp is skipped by the sentinel gate first — no crash', () => {
    // The gate is checked before the date parse, so a stray human comment cannot red the run on its timestamp.
    const { knownEntries } = sumCostToday([{ body: 'a human note', created_at: 'garbage' }], NOON);
    assert.equal(knownEntries, 0);
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
    const { usd, knownEntries } = await readSpentToday(octokit, 'o', 'r', 42, NOON);
    assert.equal(Number(usd.toFixed(2)), 0.08);
    assert.equal(knownEntries, 2);
  });

  test('exhausts pagination — a full first page forces a second fetch (spend spans pages)', async () => {
    const full = Array.from({ length: 100 }, () => entry(0.01, '2026-07-11T08:00:00Z'));
    const octokit = fakeOctokit([full, [entry(0.01, '2026-07-11T08:00:00Z'), { body: 'human note', created_at: '2026-07-11T08:00:00Z' }]]);
    const { usd, knownEntries } = await readSpentToday(octokit, 'o', 'r', 42, NOON);
    assert.equal(knownEntries, 101);
    assert.equal(Number(usd.toFixed(2)), 1.01);
  });

  test('an empty ledger issue yields zeroes', async () => {
    assert.deepEqual(await readSpentToday(fakeOctokit([[]]), 'o', 'r', 42, NOON), { usd: 0, knownEntries: 0, unknownEntries: 0 });
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
    await appendCost(capturingOctokit(calls), 'o', 'r', 42, { available: true, usd: 0.05 });
    assert.equal(calls.length, 1);
    assert.deepEqual(
      { owner: calls[0].owner, repo: calls[0].repo, issue_number: calls[0].issue_number },
      { owner: 'o', repo: 'r', issue_number: 42 },
    );
    assert.equal(calls[0].body, `${LEDGER_MARKER}\n${costMarker({ available: true, usd: 0.05 })}`);
  });

  test('an unavailable cost still appends an entry, marked unknown (a review happened; its cost is unknown)', async () => {
    const calls = [];
    await appendCost(capturingOctokit(calls), 'o', 'r', 42, { available: false, reason: 'not-reported' });
    assert.equal(calls[0].body, `${LEDGER_MARKER}\n<!-- agent-review-cost-usd:unknown -->`);
  });

  test('[LAW:no-silent-failure] an API error propagates — the module never swallows a failed append', async () => {
    const octokit = { rest: { issues: { createComment: async () => { throw new Error('403 issues:write missing'); } } } };
    await assert.rejects(() => appendCost(octokit, 'o', 'r', 42, { available: true, usd: 0.05 }), /issues:write/);
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
    await appendCost(octokit, 'o', 'r', 42, { available: true, usd: 0.05 });
    await appendCost(octokit, 'o', 'r', 42, { available: true, usd: 0.03 });
    const { usd, knownEntries } = await readSpentToday(octokit, 'o', 'r', 42, NOON);
    assert.equal(Number(usd.toFixed(2)), 0.08);
    assert.equal(knownEntries, 2);
  });
});
