'use strict';

const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { TransientError, produceReview, buildAttributionFooter } = require('../src/failover');

// Stub config factory — minimal ReviewConfig values needed by the policy and footer.
function cfg(name, engine = 'claude-code', model = 'glm-5.1', reasoning) {
  const c = { name, engine, model, endpoint: { kind: 'anthropic-messages', baseUrl: 'https://x', apiKey: 'k' } };
  if (reasoning) c.reasoning = reasoning;
  return c;
}

const FAKE_REVIEW = { summary: 'ok', findings: [] };
const NO_SLEEP = async () => {}; // [LAW:effects-at-boundaries] inject no-op sleep for fast tests

// Produce a produceOnce stub that:
//   - throws TransientError for the first `throwCount` calls on each config
//   - then returns FAKE_REVIEW
// callLog receives { config, attempt } for every call.
function makeStub(throwsByConfig = {}, callLog = []) {
  const counters = {};
  return async function produceOnce(config) {
    const count = (counters[config.name] = (counters[config.name] ?? 0) + 1);
    callLog.push({ config: config.name, attempt: count });
    const limit = throwsByConfig[config.name] ?? 0;
    if (count <= limit) throw new TransientError(`overloaded on ${config.name}`);
    return FAKE_REVIEW;
  };
}

// ────────────────────────────────────────────────────────────────────────────
// buildAttributionFooter
// ────────────────────────────────────────────────────────────────────────────

describe('buildAttributionFooter', () => {
  it('formats config/engine/model', () => {
    const footer = buildAttributionFooter(cfg('zai-glm'));
    assert.match(footer, /config `zai-glm`/);
    assert.match(footer, /claude-code/);
    assert.match(footer, /glm-5\.1/);
  });

  it('includes reasoning when set', () => {
    const footer = buildAttributionFooter(cfg('codex-xhigh', 'codex', 'gpt-5.5', 'xhigh'));
    assert.match(footer, /reasoning `xhigh`/);
  });

  it('omits reasoning when not set', () => {
    const footer = buildAttributionFooter(cfg('no-reason', 'opencode', 'openai/gpt-4o'));
    assert.doesNotMatch(footer, /reasoning/);
  });

  it('uses placeholder when model is empty string', () => {
    const c = cfg('empty-model');
    c.model = '';
    const footer = buildAttributionFooter(c);
    assert.match(footer, /\(default model\)/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// produceReview — success paths
// ────────────────────────────────────────────────────────────────────────────

describe('produceReview — success on first attempt', () => {
  it('returns review, configUsed=chain[0], attempts=1 on immediate success', async () => {
    const chain = [cfg('primary')];
    const result = await produceReview(chain, () => 'prompt', {}, makeStub(), NO_SLEEP);
    assert.deepEqual(result.review, FAKE_REVIEW);
    assert.equal(result.configUsed.name, 'primary');
    assert.equal(result.attempts, 1);
  });

  it('configUsed reflects the actual config that succeeded after first exhausts', async () => {
    const chain = [cfg('first'), cfg('second')];
    // first will throw 3 times (PER_CONFIG_LIMIT), then chain advances to second
    const callLog = [];
    const stub = makeStub({ first: 3 }, callLog);
    const result = await produceReview(chain, () => 'p', {}, stub, NO_SLEEP);
    assert.equal(result.configUsed.name, 'second');
    // first exhausted 3 attempts, second succeeded on 1st = 4 total
    assert.equal(result.attempts, 4);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// produceReview — same-config retries (2 retries = 3 total per config)
// ────────────────────────────────────────────────────────────────────────────

describe('produceReview — same-config retry', () => {
  it('retries same config up to 3 total attempts before advancing', async () => {
    const chain = [cfg('a'), cfg('b')];
    const log = [];
    const stub = makeStub({ a: 2 }, log); // a throws twice, then succeeds
    const result = await produceReview(chain, () => 'p', {}, stub, NO_SLEEP);
    assert.equal(result.configUsed.name, 'a');
    assert.equal(result.attempts, 3);
    assert.deepEqual(log.map(e => e.config), ['a', 'a', 'a']);
  });

  it('advances to next config after 3 transient failures on same config', async () => {
    const chain = [cfg('a'), cfg('b')];
    const log = [];
    const stub = makeStub({ a: 3 }, log); // a fails 3 times (all per-config budget); b succeeds
    const result = await produceReview(chain, () => 'p', {}, stub, NO_SLEEP);
    assert.equal(result.configUsed.name, 'b');
    assert.equal(result.attempts, 4); // 3 on a + 1 on b
    assert.equal(log.filter(e => e.config === 'a').length, 3);
    assert.equal(log.filter(e => e.config === 'b').length, 1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// produceReview — non-transient errors surface immediately
// ────────────────────────────────────────────────────────────────────────────

describe('produceReview — non-transient errors', () => {
  it('throws immediately on non-transient error, no failover', async () => {
    const chain = [cfg('a'), cfg('b')];
    const fatal = new Error('bad envelope');
    let bCalled = false;
    const stub = async (config) => {
      if (config.name === 'a') throw fatal;
      bCalled = true;
      return FAKE_REVIEW;
    };
    await assert.rejects(() => produceReview(chain, () => 'p', {}, stub, NO_SLEEP), err => err === fatal);
    assert.equal(bCalled, false, 'second config must never be tried on non-transient error');
  });

  it('does not retry non-transient even on chain with one entry', async () => {
    const chain = [cfg('only')];
    let callCount = 0;
    const stub = async () => { callCount++; throw new Error('non-transient'); };
    await assert.rejects(() => produceReview(chain, () => 'p', {}, stub, NO_SLEEP));
    assert.equal(callCount, 1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// produceReview — budget exhaustion
// ────────────────────────────────────────────────────────────────────────────

describe('produceReview — budget exhaustion', () => {
  it('throws immediately on empty chain (never assigns lastErr)', async () => {
    await assert.rejects(
      () => produceReview([], () => 'p', {}, makeStub(), NO_SLEEP),
      err => err instanceof Error && err.message.includes('chain must not be empty'),
    );
  });

  it('succeeds after 2 same-config retries; backoff sleeps fired once per retry', async () => {
    const chain = [cfg('only')];
    const transient = new TransientError('server down');
    let sleepCalls = 0;
    const trackSleep = async () => { sleepCalls++; };
    let calls = 0;
    const stub = async () => {
      calls++;
      if (calls <= 2) throw transient;
      return FAKE_REVIEW;
    };
    const result = await produceReview(chain, () => 'p', {}, stub, trackSleep);
    assert.equal(result.configUsed.name, 'only');
    assert.equal(result.attempts, 3);
    assert.equal(sleepCalls, 2);
  });

  it('throws last TransientError when budget is already expired on first failure', async () => {
    // budgetMs=0 makes deadline = Date.now()+0; the first attempt fails transient,
    // then budgetLeft === 0 fires and re-throws lastErr as the original TransientError.
    const chain = [cfg('only')];
    const transient = new TransientError('rate limited');
    const stub = async () => { throw transient; };
    await assert.rejects(
      () => produceReview(chain, () => 'p', {}, stub, NO_SLEEP, 0),
      err => err === transient && err instanceof TransientError,
    );
  });

  it('terminates chain-restart loop via sleepFn sentinel; each config gets full per-config retries', async () => {
    // Chain of two configs, both always transient. Sweep 1 produces:
    //   per-config sleeps: aa×2 + bb×2 = 4 (2 retries each; 3rd attempt just warns, no sleep)
    //   sweep-restart sleep:               1  → call 5 → SENTINEL
    // All sleepFn calls are fast async no-ops; SENTINEL propagates before sweep 2 starts.
    const chain = [cfg('aa'), cfg('bb')];
    const transient = new TransientError('never available');
    const SENTINEL = new Error('test-stop-sentinel');
    let sleepCallCount = 0;
    const sleepFn = async () => {
      sleepCallCount++;
      if (sleepCallCount >= 5) throw SENTINEL;
    };
    let callCount = 0;
    const stub = async () => { callCount++; throw transient; };
    await assert.rejects(
      () => produceReview(chain, () => 'p', {}, stub, sleepFn),
      err => err === SENTINEL,
    );
    // Both configs ran 3 attempts each in sweep 1 (6 total).
    // sleepFn was called exactly 5 times (4 per-config retries + 1 sweep restart = SENTINEL).
    assert.equal(callCount, 6);
    assert.equal(sleepCallCount, 5);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// produceReview — chain with single config (no failover target)
// ────────────────────────────────────────────────────────────────────────────

describe('produceReview — single-config chain', () => {
  it('succeeds after 2 transient failures on a single-config chain', async () => {
    const chain = [cfg('solo')];
    const log = [];
    const stub = makeStub({ solo: 2 }, log); // fails twice, third succeeds
    const result = await produceReview(chain, () => 'p', {}, stub, NO_SLEEP);
    assert.equal(result.configUsed.name, 'solo');
    assert.equal(result.attempts, 3);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// produceReview — configUsed is always the config that succeeded
// ────────────────────────────────────────────────────────────────────────────

describe('produceReview — configUsed', () => {
  it('configUsed is chain[0] on first-attempt success', async () => {
    const chain = [cfg('alpha'), cfg('beta')];
    const result = await produceReview(chain, () => 'p', {},makeStub(), NO_SLEEP);
    assert.equal(result.configUsed.name, 'alpha');
  });

  it('configUsed is last config in chain when first two exhaust', async () => {
    const chain = [cfg('x'), cfg('y'), cfg('z')];
    // x exhausts 3 retries, y exhausts 3 retries, z succeeds
    const log = [];
    const stub = makeStub({ x: 3, y: 3 }, log);
    const result = await produceReview(chain, () => 'p', {}, stub, NO_SLEEP);
    assert.equal(result.configUsed.name, 'z');
    assert.equal(result.attempts, 7); // 3+3+1
  });
});
