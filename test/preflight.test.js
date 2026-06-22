'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { classifyProbe, probeConfig, preflight } = require('../src/preflight');

const anthropicConfig = (name, overrides = {}) => ({
  name,
  engine: 'claude-code',
  model: 'deepseek-v4-pro',
  endpoint: { kind: 'anthropic-messages', baseUrl: 'https://api.example.com/anthropic', apiKey: 'k', ...overrides },
});

// A fake fetch that yields a fixed status, or throws to simulate a network failure.
const fetchStatus = (status) => async () => ({ status });
const fetchThrow = (err) => async () => { throw err; };

test('classifyProbe: 2xx is healthy', () => {
  assert.deepEqual(classifyProbe({ status: 200 }), { healthy: true, reason: 'ok', hint: null });
  assert.equal(classifyProbe({ status: 204 }).healthy, true);
});

test('classifyProbe: 401/403 is an auth failure naming the credential', () => {
  for (const status of [401, 403]) {
    const v = classifyProbe({ status });
    assert.equal(v.healthy, false);
    assert.equal(v.reason, 'auth');
    assert.match(v.hint, /key is missing, wrong, or expired/);
  }
});

test('classifyProbe: 404 points at base URL / model', () => {
  const v = classifyProbe({ status: 404 });
  assert.equal(v.healthy, false);
  assert.equal(v.reason, 'endpoint');
  assert.match(v.hint, /base URL/);
});

test('classifyProbe: a network error is unreachable, not a false-OK', () => {
  const v = classifyProbe({ networkError: 'getaddrinfo ENOTFOUND' });
  assert.equal(v.healthy, false);
  assert.equal(v.reason, 'unreachable');
});

test('classifyProbe: other statuses (400, 5xx) are reachable-and-authed, never blocking', () => {
  // Auth failures are 401/403; anything else means the credential got past the door, so the probe
  // must not block a review that would otherwise run.
  for (const status of [400, 422, 429, 500, 503]) {
    const v = classifyProbe({ status });
    assert.equal(v.healthy, true, `HTTP ${status} must not block`);
    assert.equal(v.reason, 'reachable');
  }
});

test('probeConfig: healthy endpoint', async () => {
  const r = await probeConfig(anthropicConfig('deepseek-default'), fetchStatus(200));
  assert.deepEqual(r, { name: 'deepseek-default', skipped: false, healthy: true, reason: 'ok', hint: null });
});

test('probeConfig: bad key', async () => {
  const r = await probeConfig(anthropicConfig('deepseek-default'), fetchStatus(401));
  assert.equal(r.healthy, false);
  assert.equal(r.reason, 'auth');
});

test('probeConfig: a thrown fetch becomes unreachable', async () => {
  const r = await probeConfig(anthropicConfig('deepseek-default'), fetchThrow(new Error('connect ECONNREFUSED')));
  assert.equal(r.healthy, false);
  assert.equal(r.reason, 'unreachable');
  assert.match(r.hint, /ECONNREFUSED/);
});

test('probeConfig: an unobserved endpoint kind is skipped, never falsely probed', async () => {
  const config = {
    name: 'codex-default', engine: 'codex', model: 'gpt-5.4-mini',
    endpoint: { kind: 'openai-responses', baseUrl: 'https://api.openai.com/v1', apiKey: 'k' },
  };
  let called = false;
  const r = await probeConfig(config, async () => { called = true; return { status: 200 }; });
  assert.equal(called, false, 'must not hit the network for an unobserved kind');
  assert.equal(r.skipped, true);
});

test('preflight: chain is ok when any config is healthy (failover survives a dead primary)', async () => {
  const chain = [anthropicConfig('primary'), anthropicConfig('fallback')];
  // Probed in chain order: primary down (401), fallback healthy (200).
  let i = 0;
  const fetchSeq = async () => ({ status: [401, 200][i++] });
  const { ok, results } = await preflight(chain, fetchSeq);
  assert.equal(ok, true);
  assert.equal(results[0].healthy, false);
  assert.equal(results[1].healthy, true);
});

test('preflight: chain fails only when every probed config is down', async () => {
  const chain = [anthropicConfig('primary'), anthropicConfig('fallback')];
  const { ok, results } = await preflight(chain, fetchStatus(401));
  assert.equal(ok, false);
  assert.equal(results.every(r => !r.healthy), true);
});

test('preflight: all-skipped chain stays ok (nothing was actually validated)', async () => {
  const chain = [{
    name: 'codex-default', engine: 'codex', model: 'm',
    endpoint: { kind: 'openai-responses', baseUrl: 'https://x', apiKey: 'k' },
  }];
  let called = false;
  const { ok, results } = await preflight(chain, async () => { called = true; return { status: 200 }; });
  assert.equal(called, false);
  assert.equal(ok, true);
  assert.equal(results[0].skipped, true);
});
