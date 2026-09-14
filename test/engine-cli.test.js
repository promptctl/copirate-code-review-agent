'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { makeCliAdapter } = require('../src/engine/cli');
const { promptOnStdin } = require('../src/engine/run');

// The shared CLI lifecycle, exercised through a spec that spawns a REAL child (a one-line node
// process that writes the collector's finish record and exits). What is under test here is the
// factory's own seam — what it hands the spec and what it puts on the returned usage — so the spec is
// as small as the contract allows rather than a stand-in for any particular engine.
// [LAW:behavior-not-structure] Every assertion below is about the value produceReview returns.
function specThatRecords(onExtract) {
  return {
    name: 'fake-cli',
    toolNames: { requestChange: 'request_change', finishReview: 'finish_review' },
    capabilities: { apiTypes: ['anthropic-messages'], credentialKinds: ['api-key'], reasoningEfforts: {} },
    materializeHome: () => fs.mkdtempSync(path.join(os.tmpdir(), 'fake-cli-home-')),
    buildCommand: ({ collector }) => ({
      command: process.execPath,
      args: ['-e', 'require("fs").writeFileSync(process.env.RECORDS, JSON.stringify({type:"finish",summary:"done"})+"\\n")'],
      env: { RECORDS: collector.recordsPath },
    }),
    meterUsage: () => () => null,
    session: promptOnStdin,
    assertSucceeded: () => {},
    classifyError: err => err,
    extractUsage: (output, config, startedAt) => onExtract(startedAt),
  };
}

const CONFIG = {
  name: 'fake',
  engine: 'fake-cli',
  model: 'deepseek-v4-pro',
  endpoint: { apiType: 'anthropic-messages', baseUrl: 'https://api.deepseek.com/anthropic', credential: { kind: 'api-key', value: 'k' } },
};

describe('makeCliAdapter — the spawn start instant (zai-cost-truth-p5o.1)', () => {
  // [LAW:one-source-of-truth] The instant a spawn is PRICED at and the instant its span RECORDS are
  // one clock read, not two. Two reads would be free to land on opposite sides of a rate boundary,
  // producing a review whose recorded span says off-peak and whose figure says peak — with nothing in
  // the record able to say which one lied. This test is the only thing that holds that claim: the
  // pricing itself would look perfectly correct with a second `new Date()` in the span.
  test('extractUsage is handed the same instant the recorded span reports as its start', async () => {
    let seen = null;
    const adapter = makeCliAdapter(specThatRecords((startedAt) => {
      seen = startedAt;
      return { tokens: { inputCacheMiss: 1, inputCacheHit: 2, output: 3 }, cost: { basis: 'dollars', usd: 0.5 } };
    }));

    const result = await adapter.produceReview({
      config: CONFIG,
      buildPromptFor: () => 'prompt',
      instructionsPath: null,
    });

    assert.ok(seen instanceof Date, 'the spawn start must reach extractUsage as a Date value');
    assert.equal(result.usage.span.from, seen.toISOString());
    assert.ok(Date.parse(result.usage.span.to) >= seen.getTime());
  });

  // The span is the HOST's clock, stamped by runEngine on every spawn — it cannot go missing the
  // way a provider's token count can. A spec that reported no usage still yields a record carrying
  // the spawn's span, with tokens and cost absent together (zai-timing-31d.4).
  test('a spec reporting no usage still reports its duration — span present, tokens and cost absent', async () => {
    const adapter = makeCliAdapter(specThatRecords(() => null));
    const result = await adapter.produceReview({
      config: CONFIG,
      buildPromptFor: () => 'prompt',
      instructionsPath: null,
    });
    assert.ok(result.usage.span, 'the host-stamped span survives a token-less spawn');
    assert.ok(Date.parse(result.usage.span.to) >= Date.parse(result.usage.span.from));
    assert.equal(result.usage.tokens, undefined);
    assert.equal(result.usage.cost, undefined);
    assert.equal(result.summary, 'done');
  });

  // A spawn that RAN and then failed the post-spawn steps (a throwing extractUsage, a ProtocolError
  // from an engine that never called finish_review) burned real wall clock; the throw carries the
  // span out, matching the invariant runEngine's own rejections hold. [LAW:no-silent-failure]
  test('a failure after the spawn ran still reports the duration it burned, on the error', async () => {
    const adapter = makeCliAdapter(specThatRecords(() => { throw new Error('usage payload was garbage'); }));
    await assert.rejects(
      adapter.produceReview({ config: CONFIG, buildPromptFor: () => 'prompt', instructionsPath: null }),
      err => {
        assert.match(err.message, /usage payload was garbage/);
        assert.ok(err.span, 'the post-spawn failure carries the spawn span');
        assert.ok(Date.parse(err.span.to) >= Date.parse(err.span.from));
        return true;
      },
    );
  });
});

// zai-token-cap-zya: every error out of produceReview carries what the spawn SPENT, so a spawn the cap
// killed is in the footer's total exactly as it is in the cap's. [LAW:one-source-of-truth]
describe('makeCliAdapter — a dead spawn\'s spend rides out on its error', () => {
  const { mintTokenCap } = require('../src/token-cap');
  const meteredSpec = {
    ...specThatRecords(() => { throw new Error('a killed spawn is never asked for its report'); }),
    buildCommand: () => ({
      command: process.execPath,
      args: ['-e', 'console.log(JSON.stringify({ used: 150 })); setTimeout(() => {}, 10000);'],
      env: { PATH: process.env.PATH },
    }),
    meterUsage: () => line => ({ inputCacheMiss: 100, inputCacheHit: JSON.parse(line).used - 100, output: 0 }),
  };
  const produce = (tokenCap) => makeCliAdapter(meteredSpec).produceReview({ config: CONFIG, buildPromptFor: () => 'prompt', instructionsPath: null, tokenCap });

  test('a spawn the cap killed carries its metered tokens, unpriced, with its span', async () => {
    const tokenCap = mintTokenCap(120);
    await assert.rejects(produce(tokenCap), (err) => {
      assert.equal(err.bound, 'tokens');
      assert.deepEqual(err.usage.tokens, { inputCacheMiss: 100, inputCacheHit: 50, output: 0 });
      assert.deepEqual(err.usage.cost, { basis: 'unpriced', reason: 'not-reported' });
      assert.ok(Date.parse(err.usage.span.to) >= Date.parse(err.usage.span.from));
      return true;
    });
    assert.match(tokenCap.describe(), /^150 of 120 tokens$/, 'the footer record and the cap charge the same spend');
  });

  test('a spawn refused before it ran carries a null usage — nothing was spent', async () => {
    const tokenCap = mintTokenCap(1);
    tokenCap.open().observe(1);
    await assert.rejects(produce(tokenCap), (err) => {
      assert.equal(err.bound, 'tokens');
      assert.equal(err.usage, null);
      return true;
    });
  });
});

// zai-worker-death-nt0: every error out of produceReview carries what the worker RECORDED before it
// died, read before the collector's directory is torn down. Exercised through a REAL child that drives
// the collector's file and then dies — the whole seam, not a stub of it. [LAW:behavior-not-structure]
describe('makeCliAdapter — a dead spawn\'s recorded findings ride out on its error', () => {
  const RECORD = JSON.stringify({ type: 'request_change', finding: { path: 'a.js', line: 3, body: 'bug one', severity: 4 } });
  function specThatRecordsThenDies(script) {
    return {
      ...specThatRecords(() => null),
      buildCommand: ({ collector }) => ({
        command: process.execPath,
        args: ['-e', script],
        env: { RECORDS: collector.recordsPath, RECORD },
      }),
    };
  }
  const produce = (adapter) => adapter.produceReview({ config: CONFIG, buildPromptFor: () => 'prompt', instructionsPath: null });

  test('a worker that records a finding and then crashes: the error carries the finding', async () => {
    const adapter = makeCliAdapter(specThatRecordsThenDies('require("fs").writeFileSync(process.env.RECORDS, process.env.RECORD+"\\n"); process.exit(3)'));
    await assert.rejects(produce(adapter), (err) => {
      assert.match(err.message, /exited with status 3/);
      assert.deepEqual(err.recorded.findings.map(f => [f.path, f.line, f.body, f.severity]), [['a.js', 3, 'bug one', 4]]);
      assert.deepEqual(err.recorded.assessments, []);
      return true;
    });
  });

  test('a worker that records a finding and exits without finishing: the ProtocolError carries the finding', async () => {
    const adapter = makeCliAdapter(specThatRecordsThenDies('require("fs").writeFileSync(process.env.RECORDS, process.env.RECORD+"\\n")'));
    await assert.rejects(produce(adapter), (err) => {
      assert.match(err.message, /did not call finish_review/);
      assert.equal(err.recorded.findings.length, 1);
      return true;
    });
  });

  test('a prompt that fails to build is stamped too — the chain never meets an error without the salvage', async () => {
    const adapter = makeCliAdapter(specThatRecordsThenDies('process.exit(0)'));
    await assert.rejects(adapter.produceReview({ config: CONFIG, buildPromptFor: () => { throw new Error('fixed prompt exceeds the window'); }, instructionsPath: null }), (err) => {
      assert.match(err.message, /exceeds the window/);
      assert.deepEqual(err.recorded, { findings: [], assessments: [] });
      return true;
    });
  });

  test('a worker that dies having recorded nothing carries the empty salvage — a value, never an absent field', async () => {
    const adapter = makeCliAdapter(specThatRecordsThenDies('process.exit(2)'));
    await assert.rejects(produce(adapter), (err) => {
      assert.deepEqual(err.recorded, { findings: [], assessments: [] });
      return true;
    });
  });
});
