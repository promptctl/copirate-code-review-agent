'use strict';
const { ZAI_ANTHROPIC_BASE_URL } = require('./engine/claude-code');
const { OPENAI_RESPONSES_BASE_URL } = require('./engine/codex');
const defaultRegistry = require('./engine/registry');

// DeepSeek exposes an Anthropic-compatible endpoint, so it runs on the claude-code engine
// exactly like z.ai — same auth translation, different base URL. [LAW:one-type-per-behavior]
const DEEPSEEK_ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic';

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
  deepseek: {
    engine: 'claude-code',
    endpointKind: 'anthropic-messages',
    defaultBaseUrl: DEEPSEEK_ANTHROPIC_BASE_URL,
    apiKeyInput: 'DEEPSEEK_API_KEY',
    defaultModel: 'deepseek-v4-pro',
    fields: i => ({ apiKey: i.deepseekApiKey, model: i.deepseekModel, systemPrompt: i.deepseekSystemPrompt, baseUrl: i.deepseekBaseUrl }),
  },
};

// [LAW:one-type-per-behavior] 'auto' has no behavior of its own — it forwards to whichever
// concrete provider every client should currently use, so the maintainer can retarget all
// clients pinned to PROVIDER=auto without them editing their workflow. [LAW:one-source-of-truth]
// This single mapping is the one place to retarget it.
const PROVIDER_ALIASES = { auto: 'deepseek' };

// Every accepted PROVIDER input value: the concrete providers plus the aliases. The order
// matters only for the "valid providers" message in the unknown-PROVIDER error.
const PROVIDER_NAMES = [...Object.keys(PROVIDERS), ...Object.keys(PROVIDER_ALIASES)];

// [LAW:effects-at-boundaries] Pure: maps inputs to a ReviewConfig, touches nothing external.
// [LAW:no-silent-failure] Throws — naming the input to fix — when the provider is unknown,
// the selected provider's credential is absent, or the reasoning effort is unsupported.
// reg is injectable for testing; defaults to the real adapter registry.
function synthesizeProviderConfig(inputs, reg) {
  const registry = reg || defaultRegistry;
  const requested = inputs.provider;
  // [LAW:dataflow-not-control-flow] Resolve the alias to a concrete provider value before any
  // synthesis; everything downstream sees only a real provider, never the alias.
  const provider = PROVIDER_ALIASES[requested] || requested;
  const spec = PROVIDERS[provider];
  if (!spec) {
    throw new Error(
      `Unknown PROVIDER ${JSON.stringify(requested)}. Valid providers: ${PROVIDER_NAMES.join(', ')}.`,
    );
  }

  const f = spec.fields(inputs);

  // [LAW:no-silent-failure] When 'auto' was used, name both it and what it resolved to so the
  // operator knows which input to set.
  const label = requested === provider ? `'${provider}'` : `'${requested}' (→ '${provider}')`;
  if (!f.apiKey) {
    throw new Error(
      `PROVIDER ${label} requires a credential, but the '${spec.apiKeyInput}' input is not set or empty. ` +
      `Set '${spec.apiKeyInput}', or choose a different provider via the PROVIDER input (valid: ${PROVIDER_NAMES.join(', ')}).`,
    );
  }

  const config = {
    // [FRAMING:representation] The config name reflects what actually ran; an alias is shown as
    // 'auto→deepseek' so the run log and attribution footer stay honest about the resolution.
    name: requested === provider ? `${provider}-default` : `${requested}→${provider}`,
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

module.exports = { synthesizeProviderConfig, PROVIDERS, PROVIDER_ALIASES, PROVIDER_NAMES };
