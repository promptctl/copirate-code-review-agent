'use strict';
// Reading a `/code-review` session. Every fixture here is shaped as the LIVE PROBE of 2026-09-17
// (CLI 2.1.267) showed a real transcript — the shapes are observed, not assumed, which is the whole
// reason this parser is trusted to price an arm. [LAW:behavior-not-structure] the assertions are about
// what the reader concludes from a session, never about how it walks the events.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { parseFindings, parseResultEvent, usageFromResult, modelOf, FINDINGS_TOOL } = require('../eval/cc-review');

const toolUse = findings => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name: FINDINGS_TOOL, input: { level: null, findings } }] },
});
const text = body => ({ type: 'assistant', message: { content: [{ type: 'text', text: body }] } });
// The result event as the probe showed one: `usage` all zeros, the real figures in `modelUsage`.
const resultEvent = (over = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'Review complete — 1 finding reported.',
  total_cost_usd: 0.25,
  usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
  modelUsage: { 'claude-sonnet-5': { inputTokens: 4, cacheCreationInputTokens: 100, cacheReadInputTokens: 900, outputTokens: 50, costUSD: 0.25, canonicalModel: 'claude-sonnet-5' } },
  ...over,
});
const finding = (over = {}) => ({ file: 'evals/tasks/lib.sh', line: 34, category: 'correctness', summary: 'task_die hardcodes exit 1.', failure_scenario: 'chmod -x check.sh and the harness reports a real FAIL.', ...over });

// The same typed payload, spelled the other way: a fenced JSON block in the closing message. Both were
// observed at `medium` minutes apart, so a reader that knew only one transport refuses half the arm's
// real runs — each of which cost real money to produce.
const jsonBlock = findings => ({
  type: 'assistant',
  message: { content: [{ type: 'text', text: `Here are the findings.\n\n\`\`\`json\n${JSON.stringify(findings, null, 2)}\n\`\`\`\n` }] },
});

describe('findings come from the typed payload, over either transport', () => {
  test('the typed payload becomes the shape the scorer takes', () => {
    const [f] = parseFindings([toolUse([finding()])], 'run');
    assert.equal(f.path, 'evals/tasks/lib.sh');
    assert.equal(f.line, 34);
    // Both halves ride into the body: the judge matches on content, and `failure_scenario` is where this
    // reviewer puts the detail an expected.json finding is written in.
    assert.match(f.body, /task_die hardcodes exit 1/);
    assert.match(f.body, /chmod -x check\.sh/);
    // `category` is a KIND, not a severity — putting it in the severity slot would say something else.
    assert.equal(f.severity, null);
  });

  test('the same payload in a fenced JSON block reads identically to the tool call', () => {
    const viaTool = parseFindings([toolUse([finding()])], 'run');
    const viaBlock = parseFindings([jsonBlock([finding()])], 'run');
    assert.deepEqual(viaBlock, viaTool);
  });

  // A findings payload is recognised by the SHAPE the skill declares, so other JSON in the message — a
  // code sample, a config snippet — is passed over rather than half-read as findings.
  test('other JSON in the message is not mistaken for findings', () => {
    const noise = { type: 'assistant', message: { content: [{ type: 'text', text: '```json\n{"retries": 3}\n```\n```json\n[{"note":"no line here"}]\n```' }] } };
    assert.throws(() => parseFindings([noise], 'run'), /reported no findings payload/);
    // …and a real payload alongside it is still found.
    assert.equal(parseFindings([noise, jsonBlock([finding()])], 'run').length, 1);
  });

  test('a malformed JSON block is not a findings payload, and does not crash the read', () => {
    const broken = { type: 'assistant', message: { content: [{ type: 'text', text: '```json\n[{"file": "a.js", "line":\n```' }] } };
    assert.throws(() => parseFindings([broken], 'run'), /reported no findings payload/);
  });

  test('a review that found nothing scores as a clean review, not as a broken one', () => {
    assert.deepEqual(parseFindings([toolUse([])], 'run'), []);
    assert.deepEqual(parseFindings([jsonBlock([])], 'run'), []);
  });

  // THE TWO ZEROS. The probe's `low` run reported entirely in prose, and one of its two findings named no
  // line at all — so scraping that prose records a two-finding review as one, and recording zero would be
  // indistinguishable from the clean review above. Neither is allowed to happen quietly.
  test('a review that never called the tool refuses — its zero would read as a clean review', () => {
    assert.throws(
      () => parseFindings([text('`evals/tasks/lib.sh:31` — this network check re-runs on every call.'), resultEvent()], 'run'),
      /reported no findings payload/,
    );
  });

  // The probe's `high` session called the tool twice with the same eight findings, and the skill also
  // re-reports after applying fixes. The conclusion is the last call, never the union of all of them.
  test('the last report wins, so a re-report is not counted as a second set of findings', () => {
    const findings = parseFindings([toolUse([finding(), finding({ line: 96 })]), toolUse([finding({ line: 78 })])], 'run');
    assert.deepEqual(findings.map(f => f.line), [78]);
    // One rule over one ordered list, so it holds across transports too — not a precedence between them.
    assert.deepEqual(parseFindings([toolUse([finding()]), jsonBlock([finding({ line: 78 })])], 'run').map(f => f.line), [78]);
  });

  test('a finding with no usable location refuses rather than landing unmatched against the ground truth', () => {
    // A payload item with no integer line is not a findings payload at all — it never reaches the mapper,
    // so it cannot land in the table as a finding pointing nowhere.
    for (const bad of [{ line: null }, { line: '34' }, { line: 1.5 }]) {
      assert.throws(() => parseFindings([toolUse([finding(bad)])], 'run'), /reported no findings payload/, JSON.stringify(bad));
    }
    assert.throws(() => parseFindings([toolUse([finding({ line: 0 })])], 'run'), /positive integer 'line'/);
    assert.throws(() => parseFindings([toolUse([finding({ file: '  ' })])], 'run'), /has no 'file'/);
    assert.throws(() => parseFindings([toolUse([finding({ summary: '' })])], 'run'), /has no 'summary'/);
  });
});

describe('the session envelope', () => {
  test('a session with no result event is not a measurement', () => {
    assert.throws(() => parseResultEvent([toolUse([])], 'run'), /no 'result' event/);
  });

  // A review that dispatches background agents emits several result events — the probe's `high` run
  // emitted four, each carrying the same cumulative usage. The session's answer is the last one.
  test('several result events reduce to the last, which carries the session total', () => {
    const first = resultEvent({ num_turns: 0 });
    const last = resultEvent({ num_turns: 10 });
    assert.equal(parseResultEvent([first, toolUse([]), last], 'run'), last);
  });

  // OBSERVED IN THE FIELD, and the most dangerous shape found while building this: a credential at its
  // weekly usage wall returns success, no error, zero tokens, $0, and prose saying so. Every other check
  // passes it, and it would enter the table as an arm that reviewed every case and found nothing — a
  // verdict produced by a billing state rather than by a reviewer. [LAW:no-silent-failure]
  test('a walled credential is refused as the non-review it is, quoting what the session said', () => {
    const walled = resultEvent({ result: "You've hit your weekly limit · resets Sep 20 at 1pm", total_cost_usd: 0, modelUsage: {} });
    assert.throws(() => parseResultEvent([walled], 'run'), /spent NO tokens/);
    assert.throws(() => parseResultEvent([walled], 'run'), /weekly limit/);
  });

  // The discriminator is the tokens, not the wording — a wall phrased differently, a rejected key, or a
  // CLI that refused to start all land here without this parser learning any new prose.
  test('any zero-token session is refused, whatever it says', () => {
    assert.throws(
      () => parseResultEvent([resultEvent({ result: 'ok', modelUsage: { 'claude-sonnet-5': { inputTokens: 0, outputTokens: 0 } } })], 'run'),
      /spent NO tokens/,
    );
  });

  test('a failed review is refused — it is not a review that found nothing', () => {
    assert.throws(() => parseResultEvent([resultEvent({ subtype: 'error_max_turns' })], 'run'), /error_max_turns/);
    assert.throws(() => parseResultEvent([resultEvent({ is_error: true })], 'run'), /is_error/);
  });
});

describe('what the review cost', () => {
  // THE TRAP the probe exposed: the result's top-level `usage` is all zeros. A producer reading it would
  // record a free review, and every cost column in the report would be a lie. [LAW:no-silent-failure]
  test('tokens come from modelUsage, never from the zeroed top-level usage', () => {
    const usage = usageFromResult(resultEvent(), { from: 'a', to: 'b' }, 'run');
    assert.deepEqual(usage.tokens, { inputCacheMiss: 104, inputCacheHit: 900, output: 50 });
    assert.deepEqual(usage.cost, { basis: 'dollars', usd: 0.25 });
    assert.deepEqual(usage.span, { from: 'a', to: 'b' });
  });

  test('a result with no modelUsage refuses — a run with no recorded cost is not a free run', () => {
    assert.throws(() => usageFromResult(resultEvent({ modelUsage: {} }), {}, 'run'), /no 'modelUsage'/);
  });

  test('an unreported cost is unpriced, never zero', () => {
    assert.deepEqual(usageFromResult(resultEvent({ total_cost_usd: null }), {}, 'run').cost, { basis: 'unpriced', reason: 'not-reported' });
  });

  test('a review served by several models names all of them, so the arm is not recorded as one that did not run', () => {
    const many = resultEvent({ modelUsage: {
      'claude-sonnet-5[1m]': { outputTokens: 10, canonicalModel: 'claude-sonnet-5' },
      'claude-haiku-4-5-20251001': { outputTokens: 5, canonicalModel: 'claude-haiku-4-5' },
    } });
    assert.equal(modelOf(many), 'claude-haiku-4-5+claude-sonnet-5');
    // The same set always renders the same label, whatever order the CLI listed it in.
    assert.equal(modelOf(resultEvent()), 'claude-sonnet-5');
  });
});
