'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const core = require('@actions/core');
const { runEngine, appendBounded, MAX_RETAINED_OUTPUT } = require('../src/engine/run.js');

// appendBounded is the single retention policy shared by stdout and stderr: append, then keep
// only the trailing MAX_RETAINED_OUTPUT bytes, reporting whether it clipped. These assert the
// contract directly (fast, pure).
describe('appendBounded', () => {
  test('under the cap, retains everything in order and reports no clip', () => {
    assert.deepEqual(appendBounded('foo', 'bar'), { text: 'foobar', clipped: false });
    assert.deepEqual(appendBounded('', ''), { text: '', clipped: false });
  });

  test('over the cap, retains exactly the trailing window and reports the clip', () => {
    const out = appendBounded('', 'a'.repeat(MAX_RETAINED_OUTPUT + 10));
    assert.equal(out.text.length, MAX_RETAINED_OUTPUT);
    assert.equal(out.clipped, true);
  });

  test('preserves the NEWEST bytes (tail) and discards the OLDEST (head)', () => {
    // The terminal turn.completed/turn.failed events are emitted LAST, so the tail is what the
    // caller needs; an old head fragment is the safe thing to drop.
    const out = appendBounded('OLDEST_MARKER', 'b'.repeat(MAX_RETAINED_OUTPUT));
    assert.equal(out.text.length, MAX_RETAINED_OUTPUT);
    assert.ok(!out.text.includes('OLDEST_MARKER'));
    assert.ok(out.text.endsWith('b'));
    assert.equal(out.clipped, true);
  });
});

// Run fn with core.warning captured; restore it after. core is a shared module singleton, so the
// same instance runEngine holds is the one patched here. [LAW:effects-at-boundaries]
async function captureWarnings(fn) {
  const original = core.warning;
  const warnings = [];
  core.warning = msg => warnings.push(msg);
  try { await fn(); } finally { core.warning = original; }
  return warnings;
}

// A fake engine whose spawned process emits MORE than the retained cap of stdout, then optionally
// a terminal success line. runEngine reads only stdout (findings flow out-of-band via the
// collector elsewhere), so the collector argument is irrelevant here.
function makeAdapter({ emitTerminal }) {
  const overflow = MAX_RETAINED_OUTPUT + 256 * 1024;
  const script =
    `const big='x'.repeat(65536);` +
    `let w=0; while(w<${overflow}){process.stdout.write(big); w+=big.length;}` +
    (emitTerminal ? `process.stdout.write('\\n'+JSON.stringify({type:'turn.completed'})+'\\n');` : ``);
  return {
    name: 'fake',
    timeoutMs: 30_000,
    buildCommand: () => ({
      command: process.execPath,
      args: ['-e', script],
      env: { PATH: process.env.PATH },
    }),
    // Mirror the real adapters: completion is judged by the presence of the terminal event.
    assertSucceeded: stdout => {
      const completed = stdout.split('\n').some(line => {
        try { return JSON.parse(line).type === 'turn.completed'; } catch { return false; }
      });
      if (!completed) throw new Error('fake review did not complete: turn.completed not emitted.');
    },
    classifyError: err => err,
  };
}

describe('runEngine with an oversized engine stream', () => {
  // The bug this guards: a 1MB stdout ceiling killed every substantial, law-comment-dense review
  // mid-flight, so the reviewer was effectively non-functional on real PRs (slopspot-tooling-yjz).
  test('a stream larger than the retained cap that ends in a terminal success COMPLETES (not killed on size), and the truncation is announced loudly', async () => {
    let stdout;
    const warnings = await captureWarnings(async () => {
      stdout = await runEngine(makeAdapter({ emitTerminal: true }), {}, 'prompt', '/tmp', {}, process.cwd());
    });
    assert.ok(stdout.length <= MAX_RETAINED_OUTPUT, `retained ${stdout.length} exceeds cap ${MAX_RETAINED_OUTPUT}`);
    assert.ok(stdout.includes('turn.completed'), 'the terminal event the caller needs survives in the tail');
    // [LAW:no-silent-failure] the information loss is loud, so a stream-summed usage cannot quietly undercount.
    assert.ok(warnings.some(w => /retention window/.test(w) && /lower bound/.test(w)), 'truncation warning emitted');
  });

  test('a stream UNDER the cap completes with NO truncation warning', async () => {
    const small = {
      name: 'fake',
      timeoutMs: 30_000,
      buildCommand: () => ({
        command: process.execPath,
        args: ['-e', `process.stdout.write(JSON.stringify({type:'turn.completed'})+'\\n');`],
        env: { PATH: process.env.PATH },
      }),
      assertSucceeded: () => {},
      classifyError: err => err,
    };
    const warnings = await captureWarnings(async () => {
      await runEngine(small, {}, 'prompt', '/tmp', {}, process.cwd());
    });
    assert.equal(warnings.length, 0, 'no truncation warning when nothing was clipped');
  });

  test('an oversized stream with NO terminal success still FAILS LOUD (never laundered into a clean pass)', async () => {
    await assert.rejects(
      runEngine(makeAdapter({ emitTerminal: false }), {}, 'prompt', '/tmp', {}, process.cwd()),
      /did not complete/,
    );
  });
});

// Every engine attempt surfaces a session transcript — capture is unconditional (no opt-in flag).
// The emit lives in the shared finish() helper, so it runs once per attempt on EVERY termination
// path: the success path and the failed (non-zero exit) path are both asserted below.
describe('runEngine session transcript', () => {
  const fs = require('node:fs');
  const { TRANSCRIPT_DIR } = require('../src/debug');

  test('captures a transcript file containing the prompt with no debug flag set', async () => {
    const small = {
      name: 'claude-code',
      timeoutMs: 30_000,
      buildCommand: () => ({
        command: process.execPath,
        args: ['-e', `process.stdout.write(JSON.stringify({type:'turn.completed'})+'\\n');`],
        env: { PATH: process.env.PATH },
      }),
      assertSucceeded: () => {},
      classifyError: err => err,
    };
    const groups = [];
    const originalGroup = core.startGroup;
    core.startGroup = label => groups.push(label);
    const before = fs.existsSync(TRANSCRIPT_DIR) ? new Set(fs.readdirSync(TRANSCRIPT_DIR)) : new Set();
    try {
      await runEngine(small, { name: 'deepseek', model: 'deepseek-v4-pro' }, 'THE-PROMPT', '/tmp', {}, process.cwd());
    } finally {
      core.startGroup = originalGroup;
    }
    assert.ok(groups.some(g => /Session transcript/.test(g)), 'a session transcript log group was opened');
    const fresh = fs.readdirSync(TRANSCRIPT_DIR).filter(f => !before.has(f));
    assert.ok(fresh.length >= 1, 'a new transcript file was written');
    const content = fs.readFileSync(`${TRANSCRIPT_DIR}/${fresh[0]}`, 'utf8');
    assert.match(content, /THE-PROMPT/);
    assert.match(content, /turn\.completed/);
    fresh.forEach(f => fs.rmSync(`${TRANSCRIPT_DIR}/${f}`, { force: true }));
  });

  test('captures a transcript even when the attempt fails (non-zero exit)', async () => {
    const failing = {
      name: 'claude-code',
      timeoutMs: 30_000,
      buildCommand: () => ({
        command: process.execPath,
        args: ['-e', `process.stderr.write('BOOM-STDERR'); process.exit(1);`],
        env: { PATH: process.env.PATH },
      }),
      assertSucceeded: () => {},
      classifyError: err => err,
    };
    const before = fs.existsSync(TRANSCRIPT_DIR) ? new Set(fs.readdirSync(TRANSCRIPT_DIR)) : new Set();
    await assert.rejects(
      runEngine(failing, { name: 'deepseek', model: 'deepseek-v4-pro' }, 'FAILED-PROMPT', '/tmp', {}, process.cwd()),
    );
    const fresh = fs.readdirSync(TRANSCRIPT_DIR).filter(f => !before.has(f));
    assert.ok(fresh.length >= 1, 'a transcript file was written for the failed attempt');
    const content = fs.readFileSync(`${TRANSCRIPT_DIR}/${fresh[0]}`, 'utf8');
    assert.match(content, /FAILED-PROMPT/);
    assert.match(content, /BOOM-STDERR/);
    fresh.forEach(f => fs.rmSync(`${TRANSCRIPT_DIR}/${f}`, { force: true }));
  });
});
