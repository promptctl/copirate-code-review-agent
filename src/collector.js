'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseFindingValue, parseReviewValue } = require('./review');

const COLLECTOR_SERVER_ARG = '--review-collector-server';

function createReviewCollector() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zai-review-collector-'));
  const recordsPath = path.join(dir, 'records.jsonl');
  const mcpConfigPath = path.join(dir, 'mcp.json');
  const mcpConfig = {
    mcpServers: {
      review_collector: {
        command: process.execPath,
        args: [__filename, COLLECTOR_SERVER_ARG],
        env: {
          REVIEW_COLLECTOR_RECORDS: recordsPath,
        },
      },
    },
  };
  fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig), 'utf8');
  return { dir, recordsPath, mcpConfigPath };
}

function readCollectedReview(recordsPath) {
  if (!fs.existsSync(recordsPath)) {
    throw new Error('Claude Code did not call the review collector tools.');
  }

  const records = fs.readFileSync(recordsPath, 'utf8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line));
  const finishes = records.filter(record => record.type === 'finish');
  if (finishes.length !== 1) {
    throw new Error(`Claude Code must call finish_review exactly once; saw ${finishes.length}.`);
  }
  const findings = records
    .filter(record => record.type === 'request_change')
    .map((record, index) => parseFindingValue(record.finding, index));
  return parseReviewValue({
    summary: finishes[0].summary,
    findings,
  }, 'Review collector output');
}

// [FRAMING:representation] The MCP config createReviewCollector writes self-references this file:
// `node <__filename> --review-collector-server`. In the ncc bundle __filename is dist/index.js,
// whose top-level guard starts the server. Run from SOURCE, __filename is THIS file — so it must
// honor the same arg, or the self-spawn config is a promise that holds only in the bundle and lies
// from source (a silently dead MCP server for any test or dev tool that drives the engine from src).
// [LAW:no-silent-failure] This guard makes the representation true in both contexts. It is inert when
// the module is required (require.main !== module), including inside the bundle, where index.js owns
// the entry. [LAW:single-enforcer] The server impl lives in one place (collector-server); this only
// routes the arg to it.
if (require.main === module && process.argv.includes(COLLECTOR_SERVER_ARG)) {
  require('./collector-server').runReviewCollectorServer();
}

module.exports = { COLLECTOR_SERVER_ARG, createReviewCollector, readCollectedReview };
