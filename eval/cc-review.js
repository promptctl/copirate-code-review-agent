'use strict';
// READING A `/code-review` SESSION — the pure half of the Claude Code arm: stream-json events in,
// findings and usage out. Kept apart from the producer's process/fs edge so every rule here is driven
// directly by a recorded transcript with nothing spawned. [LAW:effects-at-boundaries]
//
// WHAT THE LIVE PROBE SHOWED (2026-09-17, CLI 2.1.267) — this file is written against an observed
// transcript, never against documentation:
//   - Findings arrive as a typed payload — `{file, line, category, summary, failure_scenario, …}` — over
//     either of TWO transports: a `ReportFindings` tool call, or a fenced ```json block in the closing
//     message. Which one the skill picks varies run to run at the SAME level.
//   - The `result` event's text is PROSE ABOUT the review — a ranked recap at `high`, and at `low` a
//     narrative in which one of the two findings named no line at all. It is a second rendering of the
//     findings, not the findings, and reading it as the record is how a two-finding review gets recorded
//     as one. This parser reads the tool calls and never the prose. [LAW:one-source-of-truth]
//   - The skill is free NOT to call the tool (a `low` probe reported entirely in prose). That is not a
//     scorable review, and it refuses here rather than being scraped — see the two zeros, below.
//   - The `result` event's top-level `usage` is ALL ZEROS; the real figures live in `modelUsage`, keyed
//     by model id. A producer that read `usage` would record a free review. [LAW:no-silent-failure]
//   - A review that dispatches background agents emits SEVERAL `result` events, every one carrying the
//     same cumulative `modelUsage` and `total_cost_usd` — the session's running total, not that turn's.

const FINDINGS_TOOL = 'ReportFindings';

// [LAW:one-type-per-behavior] ONE findings payload, TWO TRANSPORTS. The skill emits the same typed value
// — `{file, line, summary, failure_scenario, …}` — either as a `ReportFindings` tool call or as a fenced
// JSON block in its closing message, and which one it picks varies run to run at the SAME level (both
// were observed at `medium`, minutes apart). They are two encodings of one value, not two sources of
// truth, so they are read by one parser through two readers rather than becoming two code paths with two
// notions of what a finding is. [LAW:dataflow-not-control-flow]
//
// This is emphatically NOT scraping prose. Both transports carry `file` and `line` explicitly; nothing is
// inferred from wording. A run that reports only in prose still refuses — see the two zeros, below.

// A fenced ```json block, as the closing message writes one.
const JSON_BLOCK = /```json\s*\n([\s\S]*?)```/g;

// [LAW:effects-at-boundaries] Pure. Is this a findings payload? The discriminator is the SHAPE the skill
// declares, so any other JSON the message happens to carry is passed over rather than half-read.
function isFindingsPayload(value) {
  return Array.isArray(value) && value.every(f => f && typeof f === 'object' && typeof f.file === 'string' && Number.isInteger(f.line));
}

// [LAW:effects-at-boundaries] Pure. Every findings payload the session emitted, in order, from either
// transport — so "the last report wins" is one rule over one list, not a precedence between channels.
function findingsPayloads(events) {
  const payloads = [];
  for (const event of events) {
    if (!event || !event.message || !Array.isArray(event.message.content)) continue;
    for (const block of event.message.content) {
      if (block && block.type === 'tool_use' && block.name === FINDINGS_TOOL && isFindingsPayload(block.input && block.input.findings)) {
        payloads.push(block.input.findings);
      }
      if (block && block.type === 'text' && typeof block.text === 'string') {
        for (const [, body] of block.text.matchAll(JSON_BLOCK)) {
          // A block that does not parse is not a findings payload — it is a code sample in the prose, and
          // this reader is not entitled to an opinion about it.
          let parsed = null;
          try { parsed = JSON.parse(body); } catch { parsed = null; }
          if (isFindingsPayload(parsed)) payloads.push(parsed);
        }
      }
    }
  }
  return payloads;
}

// [LAW:parse-dont-validate] In goes a recorded session, out come findings in the shape score.js's
// `parseProduced` demands — or a loud refusal. The failure arm is the whole point of this function.
//
// THE TWO ZEROS. "This review found nothing" is a real outcome and must be recordable, or a clean review
// becomes unmeasurable. "Zero findings because the reviewer never reported any" is a DIFFERENT fact, and
// it wears the identical shape: an empty array, a scorecard reading 0% recall, a table column that looks
// like a damning verdict on the arm. Nothing downstream could tell them apart — the answer-shaped void
// the laws name. So they are told apart HERE, where the evidence still exists: the skill reports an empty
// array when it found nothing, so a session that emitted `[]` scores as a clean review, while a session
// that emitted no payload at all did not produce a measurement and says so. A `low` probe reported
// entirely in prose, and one of its two findings named no line — unmatchable against a located ground
// truth, and exactly what this refusal keeps out of the table.
//
// LAST PAYLOAD WINS. The probe's `high` session reported twice with the same eight findings, and the
// skill also re-reports after applying fixes. The final payload is the review's conclusion; taking the
// union would count a re-report as a second set of findings. [LAW:one-source-of-truth]
function parseFindings(events, label) {
  const payloads = findingsPayloads(events);
  if (payloads.length === 0) {
    throw new Error(
      `${label}: the review reported no findings payload — neither a ${FINDINGS_TOOL} call nor a fenced ` +
      `JSON block carrying file and line. Its prose is not a substitute: a finding with no line cannot be ` +
      `matched against expected.json, and recording zero here would be indistinguishable from a clean review.`,
    );
  }
  return payloads[payloads.length - 1].map((f, i) => {
    const at = `${label} findings[${i}]`;
    if (f.file.trim() === '') throw new Error(`${at} has no 'file'.`);
    if (f.line <= 0) throw new Error(`${at} has no positive integer 'line', got ${JSON.stringify(f.line)}.`);
    if (typeof f.summary !== 'string' || f.summary.trim() === '') throw new Error(`${at} has no 'summary'.`);
    return {
      path: f.file.trim(),
      line: f.line,
      // The judge matches on CONTENT, so the body carries both halves the payload separates: what is
      // wrong, and the concrete way it breaks. `failure_scenario` is where this reviewer puts the detail
      // an expected.json finding is written in, so dropping it would understate the arm.
      body: [f.summary, f.failure_scenario].filter(part => typeof part === 'string' && part.trim() !== '').join('\n\n'),
      // The payload's `category` is a KIND ('correctness', 'efficiency'), never a severity, and the two
      // are not the same axis. Recording a kind in the severity slot would put a word there that means
      // something else to every reader of the scorecard. [LAW:no-silent-failure]
      severity: null,
    };
  });
}

// [LAW:parse-dont-validate] The terminal `result` event, or a refusal naming what the session did
// instead. Every arm of this is a way a spawned review fails to be a review, and each one reaches the
// scorer as a run that found nothing if it is let through. [LAW:no-silent-failure]
//
// The LAST result event is the session's, not the turn's: a review that dispatched background agents
// emits one per resumption, each carrying the same cumulative usage.
function parseResultEvent(events, label) {
  const results = events.filter(e => e && e.type === 'result');
  if (results.length === 0) {
    throw new Error(`${label}: the session emitted no 'result' event — it was killed or never finished, so nothing about it is a measurement.`);
  }
  // The TERMINAL result, and only it — the same value every other read in this function takes. A session
  // that dispatches background agents emits one result per resumption, and a segment that ended at its
  // turn limit is not the session's outcome: what establishes that a review happened is a CONCLUSION, and
  // this file checks that three ways — this terminal envelope, the tokens below, and the findings payload
  // `parseFindings` demands. A session that recovered and went on to conclude is a real, fully-priced
  // measurement, and scanning every event for a failure marker threw it away. [LAW:one-source-of-truth]
  // one rule for which event speaks for the session, applied to every fact read off it.
  const result = results[results.length - 1];
  if (result.is_error === true || result.subtype !== 'success') {
    throw new Error(`${label}: the review ended as ${JSON.stringify(result.subtype)}${result.is_error ? ' (is_error)' : ''} — a failed review is not a review that found nothing.`);
  }
  // A REVIEW THAT NEVER RAN, observed in the field: a credential at its weekly usage wall returns
  // `subtype: "success"`, `is_error: false`, zero tokens, `$0`, and the text "You've hit your weekly
  // limit". Every arm above passes it. Read on and it becomes an arm that reviewed four cases and found
  // nothing — the most damaging possible reading of this table, produced by a billing state rather than
  // by a reviewer. [LAW:no-silent-failure]
  //
  // The discriminator is mechanical, not a phrase match: a review that happened SPENT TOKENS. Anything
  // that keeps the session from working — a wall, a rejected key, a refusal to start — lands here, and
  // the result's own text is quoted so the operator reads the real cause instead of hunting a parser bug.
  const spent = Object.values(result.modelUsage ?? {}).reduce(
    (n, m) => n + (m.inputTokens ?? 0) + (m.cacheCreationInputTokens ?? 0) + (m.cacheReadInputTokens ?? 0) + (m.outputTokens ?? 0), 0,
  );
  if (spent === 0) {
    throw new Error(
      `${label}: the session reported success but spent NO tokens, so no review ran — the credential is ` +
      `walled, rejected, or the CLI refused to start. It says: ${JSON.stringify(String(result.result ?? '').trim().slice(0, 300))}`,
    );
  }
  return result;
}

// [LAW:one-source-of-truth] The tokens, the model, and the cost all come from `modelUsage` and the CLI's
// own `total_cost_usd` — the vendor's figure for its own call, not a second price table this harness
// would have to keep in step with Anthropic's.
//
// The token record is src/usage.js's disjoint one, so a `/code-review` run reduces through the SAME
// `parseUsage` boundary and the SAME cost basis as an engine replay, and the two arms' columns mean the
// same thing. `input_tokens` and `cache_creation` are both CACHE MISSES — bytes the model read fresh —
// and `cache_read` is the hit.
function usageFromResult(result, span, label) {
  const models = result.modelUsage;
  if (!models || typeof models !== 'object' || Object.keys(models).length === 0) {
    throw new Error(`${label}: the result carries no 'modelUsage', so the review's tokens and model are unrecoverable — a run with no recorded cost is not a free run.`);
  }
  const entries = Object.values(models);
  const sum = key => entries.reduce((n, m) => n + (m[key] ?? 0), 0);
  return {
    tokens: {
      inputCacheMiss: sum('inputTokens') + sum('cacheCreationInputTokens'),
      inputCacheHit: sum('cacheReadInputTokens'),
      output: sum('outputTokens'),
    },
    span,
    // Claude Code prices its own call against Anthropic's table and reports it; against a first-party
    // endpoint that IS the API price of the usage, which is what this column means for every other arm.
    cost: typeof result.total_cost_usd === 'number'
      ? { basis: 'dollars', usd: result.total_cost_usd }
      : { basis: 'unpriced', reason: 'not-reported' },
  };
}

// Which model actually served the review — EVERY model, because a review that dispatched subagents was
// served by more than one, and naming only the busiest would record an arm that did not run.
// [FRAMING:representation] Sorted, so the same set of models always renders the same arm label.
function modelOf(result) {
  const canonical = Object.entries(result.modelUsage).map(([id, m]) => m.canonicalModel ?? id);
  return [...new Set(canonical)].sort().join('+');
}

module.exports = { parseFindings, parseResultEvent, usageFromResult, modelOf, findingsPayloads, isFindingsPayload, FINDINGS_TOOL };
