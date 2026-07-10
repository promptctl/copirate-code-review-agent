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

const { readCollectedReview } = require('../src/collector');
const { ProtocolError } = require('../src/failover');

// Write the given records (objects) as one JSON line each into a fresh temp records.jsonl.
function writeRecords(records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-read-'));
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
      { type: 'request_change', finding: { path: 'a.js', line: 3, body: 'bug one', severity: 'blocking' } },
      finish('first'),
      { type: 'request_change', finding: { path: 'b.js', line: 9, body: 'bug two', severity: 'advisory' } },
      finish('second'),
    ]);
    const review = readCollectedReview(p);
    assert.equal(review.summary, 'second');
    assert.equal(review.findings.length, 2);
  });

  it('zero finish entries throw a ProtocolError (recoverable, not a plain Error)', () => {
    const p = writeRecords([
      { type: 'request_change', finding: { path: 'a.js', line: 1, body: 'orphan', severity: 'advisory' } },
    ]);
    assert.throws(() => readCollectedReview(p), err => err instanceof ProtocolError && !(err instanceof TypeError));
    assert.equal(warnings.length, 0);
  });

  it('a missing records file throws a ProtocolError', () => {
    const missing = path.join(os.tmpdir(), 'collector-read-does-not-exist', 'records.jsonl');
    assert.throws(() => readCollectedReview(missing), err => err instanceof ProtocolError);
  });
});
