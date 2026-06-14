'use strict';
const { ZAI_ANTHROPIC_BASE_URL } = require('./engine/claude-code');
const { OPENAI_RESPONSES_BASE_URL } = require('./engine/codex');
const defaultRegistry = require('./engine/registry');

// [LAW:dataflow-not-control-flow] The provider is an explicit value, never inferred from
// which credential happens to be set. [LAW:single-enforcer] This module is the one place
// that turns the simple-mode (no CONFIG_FILE) action inputs into a typed ReviewConfig.
//
// [LAW:one-source-of-truth] Each provider spec names its engine, endpoint, credential input,
// default model, and how to pull its fields from the flat action-input bag. Adding a provider
// is one entry here — every consumer (validation, error messages, config synthesis) derives
// from this table, so none of them branches on a hardcoded provider name.
const PROVIDERS = {
  codex: {
    engine: 'codex',
    endpointKind: 'openai-responses',
    defaultBaseUrl: OPENAI_RESPONSES_BASE_URL,
    apiKeyInput: 'OPENAI_API_KEY',
    defaultModel: 'gpt-5.4-mini',
    fields: i => ({ apiKey: i.openaiApiKey, model: i.openaiModel, reasoning: i.openaiReasoning, baseUrl: i.openaiBaseUrl }),
  },
  zai: {
    engine: 'claude-code',
    endpointKind: 'anthropic-messages',
    defaultBaseUrl: ZAI_ANTHROPIC_BASE_URL,
    apiKeyInput: 'ZAI_API_KEY',
    defaultModel: 'glm-5.1',
    fields: i => ({ apiKey: i.zaiApiKey, model: i.zaiModel, systemPrompt: i.zaiSystemPrompt, baseUrl: i.zaiBaseUrl }),
  },
};

const PROVIDER_NAMES = Object.keys(PROVIDERS);

// [LAW:effects-at-boundaries] Pure: maps inputs to a ReviewConfig, touches nothing external.
// [LAW:no-silent-failure] Throws — naming the input to fix — when the provider is unknown,
// the selected provider's credential is absent, or the reasoning effort is unsupported.
// reg is injectable for testing; defaults to the real adapter registry.
function synthesizeProviderConfig(inputs, reg) {
  const registry = reg || defaultRegistry;
  const provider = inputs.provider;
  const spec = PROVIDERS[provider];
  if (!spec) {
    throw new Error(
      `Unknown PROVIDER ${JSON.stringify(provider)}. Valid providers: ${PROVIDER_NAMES.join(', ')}.`,
    );
  }

  const f = spec.fields(inputs);

  if (!f.apiKey) {
    throw new Error(
      `PROVIDER '${provider}' requires a credential, but the '${spec.apiKeyInput}' input is not set or empty. ` +
      `Set '${spec.apiKeyInput}', or choose a different provider via the PROVIDER input (valid: ${PROVIDER_NAMES.join(', ')}).`,
    );
  }

  const config = {
    name: `${provider}-default`,
    engine: spec.engine,
    model: f.model || spec.defaultModel,
    endpoint: {
      kind: spec.endpointKind,
      baseUrl: f.baseUrl || spec.defaultBaseUrl,
      apiKey: f.apiKey,
    },
  };

  if (f.reasoning) {
    // [LAW:single-enforcer] Reasoning validity is owned by the adapter's capability
    // declaration — the same source the CONFIG_FILE path validates against — so simple
    // mode and config-file mode reject the same illegal values.
    const allowed = registry.get(spec.engine).capabilities.reasoningEfforts;
    if (!allowed.includes(f.reasoning)) {
      throw new Error(
        `PROVIDER '${provider}': reasoning '${f.reasoning}' is not valid for engine '${spec.engine}'. ` +
        `Allowed: ${allowed.join(', ')}.`,
      );
    }
    config.reasoning = f.reasoning;
  }

  if (f.systemPrompt) {
    config.systemPrompt = f.systemPrompt;
  }

  return config;
}

module.exports = { synthesizeProviderConfig, PROVIDERS, PROVIDER_NAMES };
