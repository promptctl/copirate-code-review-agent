'use strict';
const fs = require('fs');
const { createReviewCollector, readCollectedReview } = require('../collector');
const { runEngine } = require('./run');

// [LAW:one-type-per-behavior] claude-code and codex are ONE behavior — a CLI agent spawned as a
// subprocess that returns findings out-of-band through the MCP collector. They differ only in
// their spawn primitives (the spec: materializeHome/buildCommand/assertSucceeded/extractUsage/...),
// never in the lifecycle that drives them. This factory holds that single produceReview
// implementation; each engine module supplies its spec.
//
// [FRAMING:parts-and-seams] The adapter contract is lifted to the judgment-vs-transport seam:
// produceReview({config, buildPromptFor, instructionsPath}) -> {summary, findings, usage}. The whole
// MCP-collector dance (createReviewCollector -> materializeHome -> spawn -> readCollectedReview) is a
// PRIVATE detail in here — the registry/run.js contract is produceReview, never the subprocess
// mechanics. A direct-API engine implements produceReview with one HTTPS call and never touches this
// factory. [LAW:carrying-cost]
function makeCliAdapter(spec) {
  return {
    // [LAW:single-enforcer] The shared adapter interface: exactly what registry/run.js depend on.
    // The spawn primitives in `spec` are deliberately NOT re-exposed here — they are CLI-internal.
    name: spec.name,
    toolNames: spec.toolNames,
    capabilities: spec.capabilities,

    // buildPromptFor(toolNames) is applied with THIS engine's tool identifiers, so a failover chain
    // gives each engine its own MCP tool names in the prompt. [LAW:types-are-the-program]
    // [LAW:no-ambient-temporal-coupling] Nested try/finally owns cleanup ordering: the outer finally
    // removes the collector dir unconditionally; the inner removes home only once materializeHome
    // returned. [LAW:no-silent-failure] cleanup runs even when the engine throws.
    // [LAW:dataflow-not-control-flow] usage is a value extracted from the engine's own output and
    // returned alongside the findings — never recomputed downstream at the cost footer.
    async produceReview({ config, buildPromptFor, instructionsPath }) {
      const prompt = buildPromptFor(spec.toolNames);
      const collector = createReviewCollector();
      try {
        const home = spec.materializeHome({ config, instructionsPath, collector });
        try {
          const output = await runEngine(spec, config, prompt, home, collector);
          const usage = spec.extractUsage(output, config);
          const review = readCollectedReview(collector.recordsPath);
          return { summary: review.summary, findings: review.findings, usage };
        } finally {
          fs.rmSync(home, { recursive: true });
        }
      } finally {
        fs.rmSync(collector.dir, { recursive: true });
      }
    },
  };
}

module.exports = { makeCliAdapter };
