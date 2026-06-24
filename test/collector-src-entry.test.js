'use strict';
// Smoke test for the SOURCE self-respawn path. collector-smoke.test.js covers the bundled entry
// (dist/index.js); this covers running from src, which createReviewCollector self-references via
// __filename = src/collector.js. Before the entry guard in collector.js, that spawn started no
// server (the arg was handled only by index.js), so any code driving the engine from source got a
// silently dead MCP collector. This drives the REAL generated mcp.json command/args so the guard is
// machine-checked exactly as the engine would invoke it. [LAW:behavior-not-structure]
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const { createReviewCollector } = require('../src/collector');

function rpc(child, id, method, params) {
  return new Promise((resolve, reject) => {
    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
    let buffer = '';
    const cleanup = () => {
      child.stdout.removeListener('data', onData);
      child.removeListener('close', onClose);
    };
    const onData = chunk => {
      buffer += chunk;
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      const line = buffer.slice(0, nl).trim();
      cleanup();
      try { resolve(JSON.parse(line)); } catch (e) { reject(new Error(`Non-JSON response: ${line}`)); }
    };
    const onClose = code => { cleanup(); reject(new Error(`Child exited with code ${code} before responding to ${method}`)); };
    child.stdout.on('data', onData);
    child.once('close', onClose);
    child.stdin.write(`${msg}\n`);
  });
}

test('src self-respawn: createReviewCollector config spawns a working MCP server from source', async () => {
  const collector = createReviewCollector();
  const cfg = JSON.parse(fs.readFileSync(collector.mcpConfigPath, 'utf8')).mcpServers.review_collector;

  // The self-reference must point at a source file (the gap this guards), not the bundle.
  assert.match(cfg.args[0], /src[/\\]collector\.js$/, 'in src-land the MCP config self-references src/collector.js');

  const child = spawn(cfg.command, cfg.args, {
    env: { ...process.env, ...cfg.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  try {
    const initResp = await rpc(child, 1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    assert.ok(initResp.result && initResp.result.serverInfo, 'server must initialize');

    const listResp = await rpc(child, 2, 'tools/list', {});
    const names = listResp.result.tools.map(t => t.name);
    assert.ok(names.includes('request_change') && names.includes('finish_review'), 'collector tools must be present');

    const finishResp = await rpc(child, 3, 'tools/call', { name: 'finish_review', arguments: { summary: 'ok' } });
    assert.ok(finishResp.result && !finishResp.error, 'finish_review must record without error');

    const records = fs.readFileSync(collector.recordsPath, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(records.length, 1);
    assert.equal(records[0].type, 'finish');
  } finally {
    child.kill();
    fs.rmSync(collector.dir, { recursive: true });
  }
});
