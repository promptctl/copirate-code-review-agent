'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { mintSpendMeter, attributedConfig, guardSpend } = require('../src/spend');

// zai-billing-g04: a run's spend has one owner, and every exit reads it. These assert the meter and the
// guard as a caller sees them; the wiring into a real review is asserted in multiscope and pr-review-gate.

const usage = (n) => ({ tokens: { inputCacheMiss: n, inputCacheHit: 0, output: 0 }, cost: { basis: 'dollars', usd: n } });
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

describe('mintSpendMeter', () => {
  test('records the usage of an attempt whichever way it settles', async () => {
    const spend = mintSpendMeter();
    const a = { name: 'a' };
    await spend.attempt(a, async () => ({ usage: usage(1) }));
    await assert.rejects(spend.attempt(a, async () => { throw Object.assign(new Error('died'), { usage: usage(2) }); }), /died/);
    assert.deepEqual(spend.usages(), [usage(1), usage(2)]);
    assert.deepEqual(spend.configs(), [a]);
  });

  test('close refuses an attempt not yet started, and resolves only once every started attempt is recorded', async () => {
    const spend = mintSpendMeter();
    const inFlight = deferred();
    const attempt = spend.attempt({ name: 'a' }, () => inFlight.promise);
    let closed = false;
    const closing = spend.close().then(() => { closed = true; });
    await assert.rejects(spend.attempt({ name: 'a' }, async () => ({ usage: usage(9) })), /spawn refused/);
    await new Promise(setImmediate);
    assert.equal(closed, false, 'close resolved while an attempt was still running');
    inFlight.resolve({ usage: usage(3) });
    await attempt;
    await closing;
    // The in-flight attempt's usage is in by the time close resolves; the refused one ran nothing.
    assert.deepEqual(spend.usages(), [usage(3)]);
  });
});

describe('attributedConfig', () => {
  const zai = { name: 'zai', model: 'glm-5', endpoint: { baseUrl: 'https://api.z.ai' } };
  test('a run that recorded nothing is attributed to the fallback', () => {
    assert.equal(attributedConfig([], zai), zai);
  });
  test('spend on configs sharing a model and endpoint is attributed to the last of them', () => {
    const again = { ...zai, name: 'zai-retry' };
    assert.equal(attributedConfig([zai, again], zai), again);
  });
  test('spend a failover spread across models records neither model nor endpoint', () => {
    const other = { name: 'ds', model: 'deepseek-v4', endpoint: { baseUrl: 'https://api.deepseek.com' } };
    const attributed = attributedConfig([zai, other], other);
    assert.equal(attributed.model, undefined);
    assert.equal(attributed.endpoint, undefined);
    assert.equal(attributed.name, 'ds');
  });
});

describe('guardSpend', () => {
  // The signal registration is injected, so the signal arm is driven without signalling this process.
  function harness() {
    const spend = mintSpendMeter();
    const recorded = [];
    let finalizer = null;
    const guard = guardSpend({
      spend,
      record: async (cause) => { recorded.push({ cause, usages: spend.usages() }); },
      onSignal: (f) => { finalizer = f; return () => { finalizer = null; }; },
    });
    return { spend, guard, recorded, signal: (name) => (finalizer ? finalizer(name) : undefined) };
  }

  test('a throw records the spend once, naming the failure, however many exits claim it', async () => {
    const { guard, recorded, signal } = harness();
    const first = guard.failed(new Error('API Error: Rate limit reached'));
    const second = guard.failed(new Error('a second throw'));
    assert.equal(first, second);
    await Promise.all([first, second, signal('SIGTERM')]);
    assert.equal(recorded.length, 1);
    assert.match(recorded[0].cause, /^The run failed: API Error: Rate limit reached$/);
  });

  test('a signal records the spend, naming the signal, after the attempts it stopped have settled', async () => {
    const { spend, recorded, signal } = harness();
    const killed = deferred();
    const attempt = spend.attempt({ name: 'a' }, () => killed.promise).catch(() => {});
    const finalizing = signal('SIGTERM');
    // The reaper's SIGKILL makes the in-flight spawn reject with what it metered, a moment later.
    killed.reject(Object.assign(new Error('killed'), { usage: usage(7) }));
    await Promise.all([finalizing, attempt]);
    assert.equal(recorded.length, 1);
    assert.match(recorded[0].cause, /stopped by SIGTERM/);
    assert.deepEqual(recorded[0].usages, [usage(7)]);
  });

  test('a signal while the review is being delivered records nothing — its marker is already on the way', async () => {
    const { guard, recorded, signal } = harness();
    guard.delivering();
    assert.equal(signal('SIGTERM'), undefined);
    assert.equal(recorded.length, 0);
  });

  test('a throw while delivering means the host refused the review, so the spend is recorded', async () => {
    const { guard, recorded } = harness();
    guard.delivering();
    await guard.failed(new Error('HttpError: Resource not accessible by integration'));
    assert.equal(recorded.length, 1);
  });

  test('once the review is delivered the guard stops listening for signals', () => {
    const { guard, recorded, signal } = harness();
    guard.done();
    assert.equal(signal('SIGTERM'), undefined);
    assert.equal(recorded.length, 0);
  });
});
