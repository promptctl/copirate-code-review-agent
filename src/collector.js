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

module.exports = { COLLECTOR_SERVER_ARG, createReviewCollector, readCollectedReview };
