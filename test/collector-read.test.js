'use strict';
// Unit tests for readCollectedReview's finish gate — the recoverable-protocol-slip contract.
// [LAW:behavior-not-structure] These write a records.jsonl directly and assert what readCollectedReview
// returns/throws, never how it is implemented — no MCP handshake needed to exercise the gate itself.
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const core = require('@actions/core');

const { readCollectedReview, readRecordedFindings } = require('../src/collector');
const { ProtocolError } = require('../src/failover');

// Every temp dir writeRecords creates, torn down in afterEach so the suite leaves no residue in a
// persistent environment. [LAW:no-silent-failure] cleanup is unconditional, not left to the OS.
const createdDirs = [];

// Write the given records (objects) as one JSON line each into a fresh temp records.jsonl.
function writeRecords(records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-read-'));
  createdDirs.push(dir);
  const recordsPath = path.join(dir, 'records.jsonl');
  fs.writeFileSync(recordsPath, records.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return recordsPath;
}

const finish = summary => ({ type: 'finish', summary });

// [LAW:effects-at-boundaries] Capture core.warning by swapping the shared module instance's method —
// node caches the module, so this is the exact function collector.js calls. Restored after each test.
let warnings;
let realWarning;
beforeEach(() => {
  warnings = [];
  realWarning = core.warning;
  core.warning = msg => warnings.push(msg);
});
afterEach(() => {
  core.warning = realWarning;
  while (createdDirs.length) fs.rmSync(createdDirs.pop(), { recursive: true, force: true });
});

describe('readCollectedReview — finish gate', () => {
  it('returns the single finish summary with no warning', () => {
    const p = writeRecords([finish('the one verdict')]);
    const review = readCollectedReview(p);
    assert.equal(review.summary, 'the one verdict');
    assert.equal(warnings.length, 0);
  });

  it('two finish entries yield the LAST summary and a warning naming the count', () => {
    const p = writeRecords([finish('first word'), finish('final word')]);
    const review = readCollectedReview(p);
    assert.equal(review.summary, 'final word'); // the model's final word wins
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /finish_review 2 times/);
  });

  it('preserves sibling findings across a double finish_review (nothing discarded)', () => {
    // The whole point of the fix: a duplicate finish must not throw away already-recorded findings.
    const p = writeRecords([
      { type: 'request_change', finding: { path: 'a.js', line: 3, body: 'bug one', severity: 4 } },
      finish('first'),
      { type: 'request_change', finding: { path: 'b.js', line: 9, body: 'bug two', severity: 3 } },
      finish('second'),
    ]);
    const review = readCollectedReview(p);
    assert.equal(review.summary, 'second');
    assert.equal(review.findings.length, 2);
  });

  it('zero finish entries throw a ProtocolError (recoverable, not a plain Error)', () => {
    const p = writeRecords([
      { type: 'request_change', finding: { path: 'a.js', line: 1, body: 'orphan', severity: 2 } },
    ]);
    assert.throws(() => readCollectedReview(p), err => err instanceof ProtocolError);
    assert.equal(warnings.length, 0);
  });

  it('a missing records file throws a ProtocolError', () => {
    const missing = path.join(os.tmpdir(), 'collector-read-does-not-exist', 'records.jsonl');
    assert.throws(() => readCollectedReview(missing), err => err instanceof ProtocolError);
  });
});

describe('readCollectedReview — dependency assessments', () => {
  it('collects assessment records as typed values alongside findings and the finish', () => {
    const p = writeRecords([
      { type: 'assessment', assessment: { module: 'github.com/a/b', impact: 'adds retries', affected: false, verdict: 'safe' } },
      { type: 'request_change', finding: { path: 'a.js', line: 3, body: 'bug', severity: 4 } },
      finish('done'),
    ]);
    const review = readCollectedReview(p);
    assert.equal(review.findings.length, 1);
    assert.equal(review.assessments.length, 1);
    assert.deepEqual(review.assessments[0], { module: 'github.com/a/b', impact: 'adds retries', affected: false, callSite: null, verdict: 'safe' });
  });

  it('a run with no assessment records yields an empty assessments list, never undefined', () => {
    const p = writeRecords([finish('nothing to assess')]);
    const review = readCollectedReview(p);
    assert.deepEqual(review.assessments, []);
  });

  it('an assessment with an invalid verdict throws at the read boundary', () => {
    const p = writeRecords([
      { type: 'assessment', assessment: { module: 'github.com/a/b', impact: 'x', affected: true, verdict: 'maybe' } },
      finish('done'),
    ]);
    assert.throws(() => readCollectedReview(p), /invalid verdict/);
  });
});

// zai-worker-death-nt0: the salvage read. A worker drives the collector as it goes, so a worker that
// dies (overflow, crash, deadline kill, forgotten finish) has left records behind; this reader returns
// them with NO finish gate — absence of a finish is the death the caller already holds as its error.
describe('readRecordedFindings — what a worker recorded, whether or not it lived to finish', () => {
  it('returns the findings and assessments of a records file with no finish, parsed as the finish gate would parse them', () => {
    const p = writeRecords([
      { type: 'assessment', assessment: { module: 'github.com/a/b', impact: 'adds retries', affected: false, verdict: 'safe' } },
      { type: 'request_change', finding: { path: 'a.js', line: 3, body: 'bug one', severity: 4 } },
      { type: 'request_change', finding: { path: 'b.js', line: 9, body: 'bug two', severity: 3 } },
    ]);
    const recorded = readRecordedFindings(p);
    assert.deepEqual(recorded.findings.map(f => [f.path, f.line, f.body, f.severity]), [['a.js', 3, 'bug one', 4], ['b.js', 9, 'bug two', 3]]);
    assert.deepEqual(recorded.assessments.map(a => a.module), ['github.com/a/b']);
    assert.equal(warnings.length, 0);
  });

  it('a finished review reads the same records the finish gate does', () => {
    const p = writeRecords([{ type: 'request_change', finding: { path: 'a.js', line: 3, body: 'bug', severity: 4 } }, finish('done')]);
    assert.deepEqual(readRecordedFindings(p).findings, readCollectedReview(p).findings);
  });

  it('no records file at all is the empty salvage — a worker that never drove the collector recorded nothing', () => {
    assert.deepEqual(readRecordedFindings(path.join(os.tmpdir(), 'collector-read-never-written', 'records.jsonl')), { findings: [], assessments: [] });
  });

  it('an empty records file is the empty salvage too, never a throw', () => {
    const p = writeRecords([]);
    assert.deepEqual(readRecordedFindings(p), { findings: [], assessments: [] });
  });
});
