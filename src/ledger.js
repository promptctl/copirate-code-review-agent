'use strict';
const { costMarker, parseCostMarker } = require('./usage');

// The append-only daily cost ledger: the persistent cross-run store of actual review spend, scoped to
// one repo-day, that the budget gradient (zai-budget-qzm) reads before deciding this review's effort.
//
// [LAW:one-source-of-truth] It mints NO new cost representation. A ledger entry IS the same
// machine-readable cost marker already embedded in every PR review body (usage.js: costMarker /
// parseCostMarker) — the ledger only widens that one representation from per-PR scope to repo-day
// scope. The day's spend is a SUM of immutable append-only records, never a mutable counter.
// [LAW:no-shared-mutable-globals] Append-only is race-free: each run posts one comment; the read sums
// the day's comments. There is no read-modify-write, so concurrent runs cannot clobber each other.
//
// [LAW:effects-at-boundaries] The store is a dedicated repo ISSUE; the two operations that touch it —
// readSpentToday (list + sum) and appendCost (post one entry) — are effects. The summing/filtering
// core (sumCostToday) is pure and testable without a fake API. Neither effect owns the "did this fail
// the run?" decision: on an API error they PROPAGATE (never swallow), so the run() boundary that wires
// them (zai-budget-qzm.5) owns warn-loud-and-continue for a failed append (the ledger then under-counts
// — an honest lower bound) and the spend-safe fallback for a failed read. [LAW:no-silent-failure]
//
// This module is handed its inputs as VALUES: the ledger issue number (discovered from a repo Actions
// variable at the run boundary) and the reference `now`. It reads neither env nor the clock, so the
// clock has a single explicit owner upstream. [LAW:no-ambient-temporal-coupling]

// [LAW:types-are-the-program] The entry sentinel: a machine-written ledger entry LEADS with this HTML
// comment (invisible in rendered markdown, like REVIEW_MARKER). It makes "is this comment a ledger
// entry" a checkable property, not a guess — the exact discipline summarizePriorReviews applies with
// its trailing REVIEW_MARKER gate. [LAW:no-silent-failure] Without it, a stray human comment on the
// ledger issue that merely QUOTED a cost marker would be summed — and the unsafe direction here is
// OVER-count (a phantom spend throttles effort down on bad data), so the gate matters.
const LEDGER_MARKER = '<!-- agent-review-cost-ledger-entry -->';

// [LAW:effects-at-boundaries] Pure: the body of one ledger entry — the sentinel then the reused cost
// marker. `cost` is the same discriminated value costMarker already consumes ({available, usd, reason}),
// so an unavailable cost writes an honest `unknown` marker: the entry still exists (a review happened),
// its cost is simply counted as unknown on read, never fabricated as zero. [LAW:no-silent-failure]
function ledgerEntryBody(cost) {
  return `${LEDGER_MARKER}\n${costMarker(cost)}`;
}

// [LAW:effects-at-boundaries] Pure: the UTC calendar date ('YYYY-MM-DD') of an ISO timestamp or Date.
// UTC (not local) so the day boundary is deterministic and DST-free — the same instant yields the same
// day on every runner. [LAW:no-silent-failure] a malformed timestamp makes toISOString throw ("Invalid
// time value") rather than silently miscounting: the read reds loudly and the boundary takes its safe
// fallback, never a quiet wrong day.
function utcDay(dateish) {
  return new Date(dateish).toISOString().slice(0, 10);
}

// [LAW:effects-at-boundaries] Pure: sum the cost of the ledger entries dated today (UTC of `now`).
// [LAW:single-enforcer] ONE definition of "a today ledger entry" gates the sum: a comment that LEADS
// with LEDGER_MARKER and whose created_at falls on today's UTC date. A comment failing either test —
// a human note, a quoted marker mid-prose, yesterday's entry — contributes nothing.
// [LAW:no-silent-failure] An entry inside the gate whose marker is 'unknown' or unparseable is counted
// as an unknownEntry, never dropped, so the caller can report the day's spend as an honest lower bound
// rather than a silently-partial sum — the same shape summarizePriorReviews returns for a PR.
function sumCostToday(comments, now) {
  const today = utcDay(now);
  let usd = 0;
  let knownEntries = 0;
  let unknownEntries = 0;
  for (const c of comments) {
    const body = typeof c.body === 'string' ? c.body : '';
    if (!body.trimStart().startsWith(LEDGER_MARKER)) continue;
    if (utcDay(c.created_at) !== today) continue;
    const cost = parseCostMarker(body);
    if (typeof cost === 'number') { usd += cost; knownEntries++; }
    else unknownEntries++;
  }
  return { usd, knownEntries, unknownEntries };
}

// [LAW:effects-at-boundaries] Effect: read the ledger issue's comments and return today's summed spend
// (the pure value the budget policy consumes). [LAW:no-silent-failure] pagination is exhausted so a
// busy day is summed in full, never truncated. An API error propagates — the boundary owns the safe
// fallback. `now` is passed in, not read here. [LAW:no-ambient-temporal-coupling]
async function readSpentToday(octokit, owner, repo, issueNumber, now) {
  const comments = [];
  let page = 1;
  while (true) {
    const { data } = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: issueNumber,
      per_page: 100,
      page,
    });
    comments.push(...data);
    if (data.length < 100) break;
    page++;
  }
  return sumCostToday(comments, now);
}

// [LAW:effects-at-boundaries] Effect: append this review's actual cost as one immutable ledger entry,
// posted AFTER the review submits (the cost is known only then). One create, no read-modify-write.
// [LAW:no-silent-failure] an API error propagates so the boundary warns loudly and continues (the
// ledger then under-counts — a known lower bound), never a silent drop.
async function appendCost(octokit, owner, repo, issueNumber, cost) {
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body: ledgerEntryBody(cost),
  });
}

module.exports = {
  LEDGER_MARKER,
  ledgerEntryBody,
  sumCostToday,
  readSpentToday,
  appendCost,
};
