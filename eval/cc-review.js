'use strict';
// READING A `/code-review` SESSION — the pure half of the Claude Code arm: stream-json events in,
// findings and usage out. Kept apart from the producer's process/fs edge so every rule here is driven
// directly by a recorded transcript with nothing spawned. [LAW:effects-at-boundaries]
//
// WHAT THE LIVE PROBE SHOWED (2026-09-17, CLI 2.1.267) — this file is written against an observed
// transcript, never against documentation:
//   - Findings arrive as `ReportFindings` TOOL CALLS, whose input is already typed:
//     `{file, line, category, summary, failure_scenario, short_summary, verdict}`.
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

// [LAW:effects-at-boundaries] Pure. Every call the session made to the findings tool, in order.
function findingsCalls(events) {
  return events
    .filter(e => e && e.type === 'assistant' && e.message && Array.isArray(e.message.content))
    .flatMap(e => e.message.content)
    .filter(block => block && block.type === 'tool_use' && block.name === FINDINGS_TOOL);
}

// [LAW:parse-dont-validate] In goes a recorded session, out come findings in the shape score.js's
// `parseProduced` demands — or a loud refusal. The failure arm is the whole point of this function.
//
// THE TWO ZEROS. "This review found nothing" is a real outcome and must be recordable, or a clean review
// becomes unmeasurable. "Zero findings because the reviewer never reported any" is a DIFFERENT fact, and
// it wears the identical shape: an empty array, a scorecard reading 0% recall, a table column that looks
// like a damning verdict on the arm. Nothing downstream could tell them apart — the answer-shaped void
// the laws name. So they are told apart HERE, where the evidence still exists: the skill reports an empty
// array when it found nothing, so a session that called the tool with `[]` scores as a clean review,
// while a session that never called it at all did not produce a measurement and says so.
//
// LAST CALL WINS. The probe's `high` session called the tool twice with the same eight findings; the
// skill also re-reports after applying fixes. The final call is the review's conclusion, and taking the
// union instead would count a re-report as a second set of findings. [LAW:one-source-of-truth]
function parseFindings(events, label) {
  const calls = findingsCalls(events);
  if (calls.length === 0) {
    throw new Error(
      `${label}: the review never called ${FINDINGS_TOOL}, so it reported no findings in the one form that ` +
      `carries a file and a line. Its prose is not a substitute — a finding with no line cannot be matched ` +
      `against expected.json, and recording zero here would be indistinguishable from a clean review.`,
    );
  }
  const raw = calls[calls.length - 1].input;
  if (!raw || !Array.isArray(raw.findings)) {
    throw new Error(`${label}: the final ${FINDINGS_TOOL} call carries no 'findings' array, got ${JSON.stringify(raw).slice(0, 200)}.`);
  }
  return raw.findings.map((f, i) => {
    const at = `${label} ${FINDINGS_TOOL}.findings[${i}]`;
    if (typeof f.file !== 'string' || f.file.trim() === '') throw new Error(`${at} has no 'file'.`);
    if (!Number.isInteger(f.line) || f.line <= 0) throw new Error(`${at} has no positive integer 'line', got ${JSON.stringify(f.line)}.`);
    if (typeof f.summary !== 'string' || f.summary.trim() === '') throw new Error(`${at} has no 'summary'.`);
    return {
      path: f.file.trim(),
      line: f.line,
      // The judge matches on CONTENT, so the body carries both halves the tool separates: what is wrong,
      // and the concrete way it breaks. `failure_scenario` is where this reviewer puts the detail an
      // expected.json finding is written in, so dropping it would understate the arm.
      body: [f.summary, f.failure_scenario].filter(part => typeof part === 'string' && part.trim() !== '').join('\n\n'),
      // The tool's `category` is a KIND ('correctness', 'efficiency'), never a severity, and the two are
      // not the same axis. Recording a kind in the severity slot would put a word there that means
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
  const failed = results.find(r => r.is_error === true || r.subtype !== 'success');
  if (failed) {
    throw new Error(`${label}: the review ended as ${JSON.stringify(failed.subtype)}${failed.is_error ? ' (is_error)' : ''} — a failed review is not a review that found nothing.`);
  }
  return results[results.length - 1];
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

module.exports = { parseFindings, parseResultEvent, usageFromResult, modelOf, findingsCalls, FINDINGS_TOOL };
