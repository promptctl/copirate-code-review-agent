'use strict';
const { claudeCodeAdapter } = require('./claude-code');
const { codexAdapter } = require('./codex');
const { opencodeAdapter } = require('./opencode');

// [LAW:single-enforcer] The only enumeration of engine adapters.
// To support a new engine, add it here and implement the adapter contract.
const adapters = new Map([
  ['claude-code', claudeCodeAdapter],
  ['codex', codexAdapter],
  ['opencode', opencodeAdapter],
]);

function get(name) {
  const adapter = adapters.get(name);
  if (!adapter) {
    throw new Error(`Unknown engine: ${name}. Valid engines: ${[...adapters.keys()].join(', ')}`);
  }
  return adapter;
}

module.exports = { get };
