'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { gitHubTransport, giteaTransport, resolveReviewTarget } = require('../src/index.js');

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
