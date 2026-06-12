'use strict';
const { claudeCodeAdapter } = require('./claude-code');

// [LAW:single-enforcer] The only enumeration of engine adapters.
// To support a new engine, add it here and implement the adapter contract.
const adapters = new Map([
  ['claude-code', claudeCodeAdapter],
]);

function get(name) {
  const adapter = adapters.get(name);
  if (!adapter) {
    throw new Error(`Unknown engine: ${name}. Valid engines: ${[...adapters.keys()].join(', ')}`);
  }
  return adapter;
}

module.exports = { get };
