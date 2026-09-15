'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const path = require('path');

const { within } = require('../src/shutdown');

// The shutdown owner ends the process, so it is driven in a child: the child registers a stop and a
// finalizer, reports ready, and the test signals it. fs.writeSync, because process.stdout on a pipe is
// asynchronous on macOS and process.exit would drop what it had not flushed.
const SHUTDOWN = path.join(__dirname, '..', 'src', 'shutdown.js');
const CHILD = `
  const fs = require('fs');
  const say = (s) => fs.writeSync(1, s + '\\n');
  const { onSignalStop, onSignalFinalize } = require(${JSON.stringify(SHUTDOWN)});
  onSignalStop(() => say('stop'));
  onSignalFinalize(async (signal) => { await new Promise(r => setTimeout(r, 300)); say('final ' + signal); });
  say('ready');
  setInterval(() => {}, 1000);
`;

function runChild(signals) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', CHILD], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk) => {
      const wasReady = out.includes('ready');
      out += chunk;
      if (!wasReady && out.includes('ready')) {
        signals.forEach(([signal, afterMs]) => setTimeout(() => child.kill(signal), afterMs));
      }
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, lines: out.trim().split('\n') }));
  });
}

describe('signal shutdown', () => {
  test('SIGTERM runs every stop first, waits for the finalizer, then exits 143', async () => {
    const { code, lines } = await runChild([['SIGTERM', 0]]);
    assert.deepEqual(lines, ['ready', 'stop', 'final SIGTERM']);
    assert.equal(code, 143);
  });

  test("the runner's SIGTERM after SIGINT does not cut short the shutdown SIGINT started", async () => {
    // A cancelled Actions step gets SIGINT, then SIGTERM; the second must not exit before the first finishes.
    const { code, lines } = await runChild([['SIGINT', 0], ['SIGTERM', 50]]);
    assert.deepEqual(lines, ['ready', 'stop', 'final SIGINT']);
    assert.equal(code, 130);
  });
});

describe('within', () => {
  test('answers whether the promise settled before the ceiling, and never rejects', async () => {
    assert.equal(await within(Promise.resolve(), 1000), true);
    assert.equal(await within(Promise.reject(new Error('x')), 1000), true);
    assert.equal(await within(new Promise(() => {}), 10), false);
  });
});
