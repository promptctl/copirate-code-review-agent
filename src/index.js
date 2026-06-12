'use strict';
const core = require('@actions/core');
const { COLLECTOR_SERVER_ARG } = require('./collector');
const { runReviewCollectorServer } = require('./collector-server');
const { run } = require('./run');

if (process.argv.includes(COLLECTOR_SERVER_ARG)) {
  runReviewCollectorServer();
} else if (require.main === module) {
  run().catch(err => core.setFailed(err.message));
}

// Re-exports for test imports — all symbols the T1 test suite requires from this path.
const { patchLines, parseUnifiedDiff, buildReviewAnchors, annotatePatchWithLines } = require('./diff');
const { gitHubTransport, giteaTransport, resolveReviewTarget } = require('./transport');
const { TransientError, parseRetryAfterMs, transientBackoffMs } = require('./failover');
const { classifyClaudeError } = require('./engine/claude-code');

module.exports = {
  patchLines,
  parseUnifiedDiff,
  buildReviewAnchors,
  annotatePatchWithLines,
  gitHubTransport,
  giteaTransport,
  resolveReviewTarget,
  TransientError,
  classifyClaudeError,
  parseRetryAfterMs,
  transientBackoffMs,
};
