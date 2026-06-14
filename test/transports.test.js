'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { gitHubTransport, giteaTransport, resolveReviewTarget, prIsFromFork } = require('../src/index.js');

describe('gitHubTransport.toComment', () => {
  test('maps finding to GitHub inline comment shape', () => {
    const transport = gitHubTransport([]);
    const comment = transport.toComment({ path: 'src/foo.js', line: 42, body: 'fix this' });
    assert.deepEqual(comment, { path: 'src/foo.js', line: 42, side: 'RIGHT', body: 'fix this' });
  });

  test('uses RIGHT side always', () => {
    const transport = gitHubTransport([]);
    const comment = transport.toComment({ path: 'a.js', line: 1, body: 'x' });
    assert.equal(comment.side, 'RIGHT');
  });
});

describe('giteaTransport.toComment', () => {
  test('maps finding to Gitea new_position comment shape', () => {
    const transport = giteaTransport([]);
    const comment = transport.toComment({ path: 'src/bar.js', line: 7, body: 'fix that' });
    assert.deepEqual(comment, { path: 'src/bar.js', new_position: 7, body: 'fix that' });
  });

  test('has no side field', () => {
    const transport = giteaTransport([]);
    const comment = transport.toComment({ path: 'f.js', line: 1, body: 'x' });
    assert.equal('side' in comment, false);
  });

  test('has no line field (uses new_position instead)', () => {
    const transport = giteaTransport([]);
    const comment = transport.toComment({ path: 'f.js', line: 5, body: 'x' });
    assert.equal('line' in comment, false);
    assert.equal(comment.new_position, 5);
  });
});

describe('prIsFromFork', () => {
  test('same-repo branch PR (head id == base id) is not a fork', () => {
    const pr = { head: { repo: { id: 100 } }, base: { repo: { id: 100 } } };
    assert.equal(prIsFromFork(pr), false);
  });

  test('cross-repo PR (head id != base id) is a fork', () => {
    const pr = { head: { repo: { id: 200 } }, base: { repo: { id: 100 } } };
    assert.equal(prIsFromFork(pr), true);
  });

  test('deleted fork head (head.repo null) is treated as a fork', () => {
    const pr = { head: { repo: null }, base: { repo: { id: 100 } } };
    assert.equal(prIsFromFork(pr), true);
  });

  test('missing head object entirely is treated as a fork', () => {
    const pr = { base: { repo: { id: 100 } } };
    assert.equal(prIsFromFork(pr), true);
  });

  test('missing base repo fails loud (malformed PR data, not a silent skip)', () => {
    const pr = { head: { repo: { id: 100 } }, base: {} };
    assert.throws(() => prIsFromFork(pr), /no base repository/);
  });
});

describe('resolveReviewTarget', () => {
  test('explicit inputs take precedence over payload', () => {
    const payload = { pull_request: { number: 1, head: { sha: 'aaa' } } };
    const result = resolveReviewTarget('99', 'bbb', payload);
    assert.equal(result.pullNumber, 99);
    assert.equal(result.headSha, 'bbb');
  });

  test('falls back to payload when inputs are empty', () => {
    const payload = { pull_request: { number: 42, head: { sha: 'deadbeef' } } };
    const result = resolveReviewTarget('', '', payload);
    assert.equal(result.pullNumber, 42);
    assert.equal(result.headSha, 'deadbeef');
  });

  test('numeric string PR_NUMBER is coerced to integer', () => {
    const result = resolveReviewTarget('17', 'sha', {});
    assert.equal(result.pullNumber, 17);
  });

  test('missing payload returns undefined for both fields', () => {
    const result = resolveReviewTarget('', '', {});
    assert.equal(result.pullNumber, undefined);
    assert.equal(result.headSha, undefined);
  });

  test('partial explicit input: only PR_NUMBER provided', () => {
    const payload = { pull_request: { number: 1, head: { sha: 'fromPayload' } } };
    const result = resolveReviewTarget('5', '', payload);
    assert.equal(result.pullNumber, 5);
    assert.equal(result.headSha, 'fromPayload');
  });
});
