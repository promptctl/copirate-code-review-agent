'use strict';
const fs = require('fs');
const yaml = require('yaml');
const defaultRegistry = require('./engine/registry');

// [LAW:types-are-the-program] The config file schema is the single type contract for
// multi-engine configurations. Every illegal combination (unknown engine, unsupported
// endpoint kind, invalid reasoning effort) is caught here at load time.
// [LAW:single-enforcer] This module is the one place that validates engine/endpoint/
// reasoning combinations against adapter capability declarations.

const SUPPORTED_VERSIONS = [1];

// [LAW:effects-at-boundaries] Pure: validates raw parsed YAML against the adapter
// registry. Throws with a message naming the config, field, and allowed values.
// The registry is a parameter so tests can inject stubs.
function validateFile(raw, registry) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Config file is empty or is not a YAML mapping.`);
  }

  if (!SUPPORTED_VERSIONS.includes(raw.version)) {
    throw new Error(
      `Config file: unknown version ${JSON.stringify(raw.version)}. Supported: ${SUPPORTED_VERSIONS.join(', ')}.`,
    );
  }

  if (!raw.configs || typeof raw.configs !== 'object' || Array.isArray(raw.configs)) {
    throw new Error(`Config file: missing or invalid 'configs' map.`);
  }

  const configNames = Object.keys(raw.configs);

  for (const [name, entry] of Object.entries(raw.configs)) {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`Config '${name}': entry must be an object.`);
    }
    if (!entry.engine) {
      throw new Error(`Config '${name}': missing required field 'engine'.`);
    }

    let adapter;
    try {
      adapter = registry.get(entry.engine);
    } catch (e) {
      // [LAW:no-silent-failure] registry.get already names valid engines in its message
      throw new Error(`Config '${name}': ${e.message}`);
    }

    if (!entry.endpoint || !entry.endpoint.kind) {
      throw new Error(`Config '${name}': missing required field 'endpoint.kind'.`);
    }

    if (!adapter.capabilities.endpointKinds.includes(entry.endpoint.kind)) {
      throw new Error(
        `Config '${name}': endpoint.kind '${entry.endpoint.kind}' is not supported by engine '${entry.engine}'. Allowed: ${adapter.capabilities.endpointKinds.join(', ')}.`,
      );
    }

    if (entry.reasoning !== undefined && entry.reasoning !== null) {
      if (adapter.capabilities.reasoningEfforts.length === 0) {
        throw new Error(
          `Config '${name}': reasoning '${entry.reasoning}' is not supported by engine '${entry.engine}' (engine declares no reasoning efforts).`,
        );
      }
      if (!adapter.capabilities.reasoningEfforts.includes(entry.reasoning)) {
        throw new Error(
          `Config '${name}': reasoning '${entry.reasoning}' is not valid for engine '${entry.engine}'. Allowed: ${adapter.capabilities.reasoningEfforts.join(', ')}.`,
        );
      }
    }

    if (!entry.endpoint.baseUrl) {
      throw new Error(`Config '${name}': missing required field 'endpoint.baseUrl'.`);
    }

    if (!entry.endpoint.apiKeyEnv) {
      throw new Error(`Config '${name}': missing required field 'endpoint.apiKeyEnv'.`);
    }
  }

  if (!raw.default) {
    throw new Error(`Config file: missing required field 'default'.`);
  }

  if (!raw.configs[raw.default]) {
    throw new Error(
      `Config file: default '${raw.default}' does not name a defined config. Defined: ${configNames.join(', ')}.`,
    );
  }

  if (raw.fallback !== undefined && raw.fallback !== null) {
    if (!Array.isArray(raw.fallback)) {
      throw new Error(`Config file: 'fallback' must be an array.`);
    }
    for (const name of raw.fallback) {
      if (!raw.configs[name]) {
        throw new Error(
          `Config file: fallback entry '${name}' does not name a defined config. Defined: ${configNames.join(', ')}.`,
        );
      }
    }
  }
}

// [LAW:dataflow-not-control-flow] Chain is a value: [selected, ...fallback minus selected].
// Pure: no env reads, no side effects.
function resolveChain(raw, selectedName) {
  const chosen = selectedName || raw.default;
  const fallback = raw.fallback || [];
  const names = [chosen, ...fallback.filter(n => n !== chosen)];
  return names.map(name => {
    const entry = raw.configs[name];
    const config = {
      name,
      engine: entry.engine,
      model: entry.model || '',
      endpoint: {
        kind: entry.endpoint.kind,
        baseUrl: entry.endpoint.baseUrl,
        apiKeyEnv: entry.endpoint.apiKeyEnv,
      },
    };
    if (entry.reasoning !== undefined && entry.reasoning !== null) {
      config.reasoning = entry.reasoning;
    }
    return config;
  });
}

// [LAW:effects-at-boundaries] Reads env (external state) but accepts it as a value for
// isolation. Throws if any apiKeyEnv in the chain is absent or empty so startup fails
// fast rather than at failover time. [LAW:no-silent-failure]
function resolveSecrets(chain, env) {
  return chain.map(config => {
    const apiKey = env[config.endpoint.apiKeyEnv];
    if (!apiKey) {
      throw new Error(
        `Config '${config.name}': env var '${config.endpoint.apiKeyEnv}' is not set or empty. ` +
        'Ensure the workflow maps a secret to this variable.',
      );
    }
    const { apiKeyEnv: _, ...rest } = config.endpoint;
    return { ...config, endpoint: { ...rest, apiKey } };
  });
}

// [LAW:single-enforcer] Conflict between CONFIG_FILE and legacy ZAI_* inputs is
// a type error: two sources of truth for the same fact. Checked here, not inline.
function assertNoLegacyConflict(configFilePath, hasConfigFile, zaiApiKey) {
  if (hasConfigFile && zaiApiKey) {
    throw new Error(
      `Cannot use both CONFIG_FILE (${configFilePath}) and ZAI_API_KEY together. ` +
      'Use CONFIG_FILE for multi-engine configuration, or ZAI_API_KEY for legacy single-engine use.',
    );
  }
}

// Load, parse, validate, and resolve a config file into an ordered chain of ReviewConfig
// values with apiKey populated. Throws on any schema error, unknown selected name, or
// missing env var in the chain.
// reg is injectable for testing (defaults to the real adapter registry).
function loadConfig(filePath, selectedName, env, reg) {
  const registry = reg || defaultRegistry;
  let raw;
  try {
    raw = yaml.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    throw new Error(`Failed to read config file '${filePath}': ${e.message}`);
  }

  validateFile(raw, registry);

  if (selectedName && !raw.configs[selectedName]) {
    const defined = Object.keys(raw.configs).join(', ');
    throw new Error(`Selected config '${selectedName}' not found in '${filePath}'. Defined: ${defined}.`);
  }

  const chain = resolveChain(raw, selectedName);
  return resolveSecrets(chain, env);
}

// Fast read: returns configNames and defaultName without full validation or secret resolution.
// Used by run.js to get config names for PR-level selection before the full loadConfig call.
// [LAW:effects-at-boundaries] Reads the filesystem but accepts filePath as a value.
// [LAW:no-silent-failure] Throws if the file is unreadable or lacks 'configs'/'default'.
function peekConfigNames(filePath) {
  let raw;
  try {
    raw = yaml.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    throw new Error(`Failed to read config file '${filePath}': ${e.message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Config file '${filePath}': not a YAML mapping.`);
  }
  if (!raw.configs || typeof raw.configs !== 'object' || Array.isArray(raw.configs)) {
    throw new Error(`Config file '${filePath}': missing or invalid 'configs' map.`);
  }
  if (typeof raw.default !== 'string' || !raw.default) {
    throw new Error(`Config file '${filePath}': 'default' must be a non-empty string.`);
  }
  const configNames = Object.keys(raw.configs);
  const defaultName = raw.default;
  if (!configNames.includes(defaultName)) {
    throw new Error(
      `Config file '${filePath}': default '${defaultName}' does not name a defined config. Defined: ${configNames.join(', ')}.`,
    );
  }
  return { configNames, defaultName };
}

module.exports = { loadConfig, validateFile, resolveChain, resolveSecrets, assertNoLegacyConflict, peekConfigNames };
