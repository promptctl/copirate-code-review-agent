'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { gitHubTransport, giteaTransport, resolveReviewTarget, prIsFromFork, countPriorReviews, roundCapReached, parseMaxRounds, REVIEW_MARKER } = require('../src/index.js');

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

describe('roundCapReached', () => {
  test('not reached below the cap', () => {
    assert.equal(roundCapReached(4, 5), false);
  });

  test('reached exactly at the cap (yields exactly maxRounds reviews)', () => {
    assert.equal(roundCapReached(5, 5), true);
  });

  test('reached above the cap', () => {
    assert.equal(roundCapReached(6, 5), true);
  });

  test('maxRounds 0 is the unlimited sentinel — never reached', () => {
    assert.equal(roundCapReached(0, 0), false);
    assert.equal(roundCapReached(1000, 0), false);
  });

  test('negative maxRounds is treated as unlimited, never reached', () => {
    assert.equal(roundCapReached(1000, -1), false);
  });

  test('zero prior reviews under a positive cap always runs', () => {
    assert.equal(roundCapReached(0, 5), false);
  });
});

describe('parseMaxRounds', () => {
  test('a run of digits parses to that integer', () => {
    assert.equal(parseMaxRounds('5'), 5);
    assert.equal(parseMaxRounds('0'), 0);
    assert.equal(parseMaxRounds('42'), 42);
  });

  test('surrounding whitespace is trimmed', () => {
    assert.equal(parseMaxRounds('  7 '), 7);
  });

  test('empty (explicitly cleared) is the unlimited sentinel 0', () => {
    assert.equal(parseMaxRounds(''), 0);
    assert.equal(parseMaxRounds('   '), 0);
  });

  test('[LAW:no-silent-failure] non-numeric input throws — never silently becomes 0/unlimited', () => {
    assert.throws(() => parseMaxRounds('five'), /non-negative integer/);
    assert.throws(() => parseMaxRounds('abc'), /got "abc"/);
  });

  test('[LAW:no-silent-failure] a partly-numeric value throws rather than parseInt-truncating to a cap the user never wrote', () => {
    assert.throws(() => parseMaxRounds('3x'), /non-negative integer/);
    assert.throws(() => parseMaxRounds('3abc'), /non-negative integer/);
  });

  test('a negative value is rejected (not a non-negative integer)', () => {
    assert.throws(() => parseMaxRounds('-1'), /non-negative integer/);
  });
});

describe('countPriorReviews', () => {
  // A fake octokit whose listReviews returns fixed pages; asserts the marker filter and pagination.
  const fakeOctokit = (pages) => ({
    rest: { pulls: { listReviews: async ({ page }) => ({ data: pages[page - 1] || [] }) } },
  });

  test('counts only reviews whose body ENDS with the marker (the trailing sentinel)', async () => {
    const octokit = fakeOctokit([[
      { body: `some verdict\n\n${REVIEW_MARKER}` },
      { body: 'a human review, no marker' },
      { body: `another round\n\n${REVIEW_MARKER}\n` }, // trailing whitespace tolerated
      { body: null }, // dismissed/empty review body
    ]]);
    assert.equal(await countPriorReviews(octokit, 'o', 'r', 1), 2);
  });

  test('a human review that merely QUOTES the marker mid-body is not counted', async () => {
    const octokit = fakeOctokit([[
      { body: `I see the action posts \`${REVIEW_MARKER}\` — but here is my own comment.` },
      { body: `real round\n\n${REVIEW_MARKER}` },
    ]]);
    assert.equal(await countPriorReviews(octokit, 'o', 'r', 1), 1);
  });

  test('returns 0 when the PR has no reviews', async () => {
    assert.equal(await countPriorReviews(fakeOctokit([[]]), 'o', 'r', 1), 0);
  });

  test('exhausts pagination — a full first page forces a second fetch', async () => {
    const full = Array.from({ length: 100 }, () => ({ body: REVIEW_MARKER }));
    const octokit = fakeOctokit([full, [{ body: REVIEW_MARKER }, { body: 'no marker' }]]);
    assert.equal(await countPriorReviews(octokit, 'o', 'r', 1), 101);
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
