'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateFile, resolveChain, resolveSecrets, loadConfig, assertNoLegacyConflict } = require('../src/config');

// [LAW:verifiable-goals] AC for T4: table-driven validation matrix covering every
// rejection case named in the acceptance criteria, plus happy-path chain resolution
// and env-secret loading. Every rejection message names the config, field, and allowed values.

// Stub registry injected into all pure-function tests so no real adapters are needed.
const MOCK_REGISTRY = {
  get(name) {
    const adapters = {
      'claude-code': {
        capabilities: {
          endpointKinds: ['anthropic-messages'],
          reasoningEfforts: ['low', 'medium', 'high', 'max'],
        },
      },
      codex: {
        capabilities: {
          endpointKinds: ['openai-responses'],
          reasoningEfforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
        },
      },
      opencode: {
        capabilities: {
          endpointKinds: ['openai-chat', 'openai-responses'],
          reasoningEfforts: [],
        },
      },
    };
    const adapter = adapters[name];
    if (!adapter) {
      throw new Error(`Unknown engine: ${name}. Valid engines: ${Object.keys(adapters).join(', ')}`);
    }
    return adapter;
  },
};

// Minimal valid config raw object — used as a base for mutation tests
const VALID_RAW = {
  version: 1,
  default: 'zai-glm',
  fallback: ['zai-glm', 'codex-gpt55'],
  configs: {
    'zai-glm': {
      engine: 'claude-code',
      model: 'glm-5.1',
      reasoning: 'high',
      endpoint: {
        kind: 'anthropic-messages',
        baseUrl: 'https://api.z.ai/api/anthropic',
        apiKeyEnv: 'ZAI_API_KEY',
      },
    },
    'codex-gpt55': {
      engine: 'codex',
      model: 'gpt-5.5',
      reasoning: 'xhigh',
      endpoint: {
        kind: 'openai-responses',
        baseUrl: 'https://api.openai.com/v1',
        apiKeyEnv: 'OPENAI_API_KEY',
      },
    },
    'oc-mini': {
      engine: 'opencode',
      model: 'openai/gpt-4o-mini',
      endpoint: {
        kind: 'openai-chat',
        baseUrl: 'https://api.openai.com/v1',
        apiKeyEnv: 'OPENAI_API_KEY',
      },
    },
  },
};

// Deep-clone helper — tests mutate copies of VALID_RAW, never the original
function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// ─── validateFile — rejection matrix ────────────────────────────────────────

describe('validateFile — null/empty input guard', () => {
  test('null (empty YAML file) rejects with informative message', () => {
    assert.throws(
      () => validateFile(null, MOCK_REGISTRY),
      { message: /empty or is not a YAML mapping/ },
    );
  });

  test('array rejects as non-mapping', () => {
    assert.throws(
      () => validateFile([], MOCK_REGISTRY),
      { message: /empty or is not a YAML mapping/ },
    );
  });
});

describe('validateFile — version check', () => {
  test('version 1 is accepted', () => {
    assert.doesNotThrow(() => validateFile(VALID_RAW, MOCK_REGISTRY));
  });

  test('unknown version rejects with informative message', () => {
    const raw = clone(VALID_RAW);
    raw.version = 99;
    assert.throws(
      () => validateFile(raw, MOCK_REGISTRY),
      { message: /unknown version.*99.*Supported: 1/i },
    );
  });

  test('missing version rejects', () => {
    const raw = clone(VALID_RAW);
    delete raw.version;
    assert.throws(
      () => validateFile(raw, MOCK_REGISTRY),
      { message: /unknown version/i },
    );
  });
});

describe('validateFile — engine validation', () => {
  test('unknown engine names the config and lists valid engines', () => {
    const raw = clone(VALID_RAW);
    raw.configs['zai-glm'].engine = 'llama-cli';
    assert.throws(
      () => validateFile(raw, MOCK_REGISTRY),
      err => {
        assert.ok(/Config 'zai-glm'/.test(err.message), `missing config name in: ${err.message}`);
        assert.ok(/Unknown engine.*llama-cli/i.test(err.message), `missing engine name in: ${err.message}`);
        assert.ok(/Valid engines:/.test(err.message), `missing valid engines list in: ${err.message}`);
        return true;
      },
    );
  });
});

describe('validateFile — endpoint.kind vs adapter endpointKinds', () => {
  test('codex + anthropic-messages endpoint is rejected', () => {
    const raw = clone(VALID_RAW);
    raw.configs['codex-gpt55'].endpoint.kind = 'anthropic-messages';
    assert.throws(
      () => validateFile(raw, MOCK_REGISTRY),
      err => {
        assert.ok(/Config 'codex-gpt55'/.test(err.message), `missing config name in: ${err.message}`);
        assert.ok(/endpoint\.kind.*anthropic-messages/.test(err.message), `missing kind in: ${err.message}`);
        assert.ok(/Allowed:.*openai-responses/.test(err.message), `missing allowed list in: ${err.message}`);
        return true;
      },
    );
  });

  test('opencode + openai-chat endpoint is accepted', () => {
    assert.doesNotThrow(() => validateFile(VALID_RAW, MOCK_REGISTRY));
  });

  test('unknown endpoint.kind names the config and allowed values', () => {
    const raw = clone(VALID_RAW);
    raw.configs['zai-glm'].endpoint.kind = 'grpc-streaming';
    assert.throws(
      () => validateFile(raw, MOCK_REGISTRY),
      err => {
        assert.ok(/Config 'zai-glm'/.test(err.message));
        assert.ok(/grpc-streaming/.test(err.message));
        assert.ok(/Allowed:/.test(err.message));
        return true;
      },
    );
  });
});

describe('validateFile — reasoning effort validation', () => {
  test('valid reasoning level accepted', () => {
    assert.doesNotThrow(() => validateFile(VALID_RAW, MOCK_REGISTRY));
  });

  test('reasoning on opencode is rejected — engine declares no reasoning efforts', () => {
    const raw = clone(VALID_RAW);
    raw.configs['oc-mini'].reasoning = 'high';
    assert.throws(
      () => validateFile(raw, MOCK_REGISTRY),
      err => {
        assert.ok(/Config 'oc-mini'/.test(err.message), `missing config name in: ${err.message}`);
        assert.ok(/reasoning.*high/.test(err.message), `missing reasoning value in: ${err.message}`);
        assert.ok(/engine declares no reasoning efforts/.test(err.message), `missing explanation in: ${err.message}`);
        return true;
      },
    );
  });

  test('invalid reasoning level names the config and allowed values', () => {
    const raw = clone(VALID_RAW);
    raw.configs['zai-glm'].reasoning = 'turbo';
    assert.throws(
      () => validateFile(raw, MOCK_REGISTRY),
      err => {
        assert.ok(/Config 'zai-glm'/.test(err.message));
        assert.ok(/reasoning.*turbo/.test(err.message));
        assert.ok(/Allowed:.*low.*medium.*high.*max/.test(err.message));
        return true;
      },
    );
  });

  test('absent reasoning field is accepted (field is optional)', () => {
    const raw = clone(VALID_RAW);
    delete raw.configs['zai-glm'].reasoning;
    assert.doesNotThrow(() => validateFile(raw, MOCK_REGISTRY));
  });
});

describe('validateFile — default and fallback reference validation', () => {
  test('default naming a missing config is rejected', () => {
    const raw = clone(VALID_RAW);
    raw.default = 'nonexistent';
    assert.throws(
      () => validateFile(raw, MOCK_REGISTRY),
      err => {
        assert.ok(/default.*nonexistent/.test(err.message), `missing default name in: ${err.message}`);
        assert.ok(/Defined:/.test(err.message), `missing defined list in: ${err.message}`);
        return true;
      },
    );
  });

  test('fallback entry naming a missing config is rejected', () => {
    const raw = clone(VALID_RAW);
    raw.fallback = ['zai-glm', 'ghost-config'];
    assert.throws(
      () => validateFile(raw, MOCK_REGISTRY),
      err => {
        assert.ok(/fallback.*ghost-config/.test(err.message), `missing fallback name in: ${err.message}`);
        assert.ok(/Defined:/.test(err.message), `missing defined list in: ${err.message}`);
        return true;
      },
    );
  });

  test('absent fallback is accepted (field is optional)', () => {
    const raw = clone(VALID_RAW);
    delete raw.fallback;
    assert.doesNotThrow(() => validateFile(raw, MOCK_REGISTRY));
  });
});

// ─── resolveChain — ordering ─────────────────────────────────────────────────

describe('resolveChain — chain ordering', () => {
  test('default is chain[0] when no selectedName', () => {
    const chain = resolveChain(VALID_RAW, null);
    assert.equal(chain[0].name, 'zai-glm');
  });

  test('selectedName overrides default as chain[0]', () => {
    const chain = resolveChain(VALID_RAW, 'codex-gpt55');
    assert.equal(chain[0].name, 'codex-gpt55');
  });

  test('fallback minus selected follows in order', () => {
    // fallback: ['zai-glm', 'codex-gpt55']; default: 'zai-glm' → chain = [zai-glm, codex-gpt55]
    const chain = resolveChain(VALID_RAW, null);
    assert.equal(chain.length, 2);
    assert.equal(chain[0].name, 'zai-glm');
    assert.equal(chain[1].name, 'codex-gpt55');
  });

  test('selected config is deduped from fallback', () => {
    // selecting 'codex-gpt55' which is in fallback → chain = [codex-gpt55, zai-glm]
    const chain = resolveChain(VALID_RAW, 'codex-gpt55');
    assert.equal(chain.length, 2);
    assert.equal(chain[0].name, 'codex-gpt55');
    assert.equal(chain[1].name, 'zai-glm');
  });

  test('no fallback produces single-entry chain', () => {
    const raw = { ...VALID_RAW, fallback: undefined };
    const chain = resolveChain(raw, null);
    assert.equal(chain.length, 1);
    assert.equal(chain[0].name, 'zai-glm');
  });

  test('chain entries carry model, engine, endpoint.kind, endpoint.baseUrl, endpoint.apiKeyEnv', () => {
    const chain = resolveChain(VALID_RAW, null);
    const entry = chain[0];
    assert.equal(entry.engine, 'claude-code');
    assert.equal(entry.model, 'glm-5.1');
    assert.equal(entry.endpoint.kind, 'anthropic-messages');
    assert.equal(entry.endpoint.baseUrl, 'https://api.z.ai/api/anthropic');
    assert.equal(entry.endpoint.apiKeyEnv, 'ZAI_API_KEY');
  });

  test('reasoning is preserved when set', () => {
    const chain = resolveChain(VALID_RAW, null);
    assert.equal(chain[0].reasoning, 'high');
  });

  test('reasoning is absent when not in config', () => {
    const raw = clone(VALID_RAW);
    delete raw.configs['zai-glm'].reasoning;
    const chain = resolveChain(raw, null);
    assert.ok(!('reasoning' in chain[0]));
  });

  test('reasoning: null (bare YAML key) is treated as absent — not copied to chain', () => {
    const raw = clone(VALID_RAW);
    raw.configs['zai-glm'].reasoning = null;
    const chain = resolveChain(raw, null);
    assert.ok(!('reasoning' in chain[0]), 'reasoning: null should not appear in chain entry');
  });
});

// ─── resolveSecrets — env-secret population ──────────────────────────────────

describe('resolveSecrets — env resolution', () => {
  test('apiKey is populated from env[apiKeyEnv]', () => {
    const chain = resolveChain(VALID_RAW, null);
    const resolved = resolveSecrets(chain, { ZAI_API_KEY: 'sk-test-123', OPENAI_API_KEY: 'sk-oai-456' });
    assert.equal(resolved[0].endpoint.apiKey, 'sk-test-123');
    assert.equal(resolved[1].endpoint.apiKey, 'sk-oai-456');
  });

  test('apiKeyEnv is removed from the resolved endpoint', () => {
    const chain = resolveChain(VALID_RAW, null);
    const resolved = resolveSecrets(chain, { ZAI_API_KEY: 'k', OPENAI_API_KEY: 'k2' });
    assert.ok(!('apiKeyEnv' in resolved[0].endpoint));
  });

  test('missing env var rejects with config name and var name', () => {
    const chain = resolveChain(VALID_RAW, null);
    assert.throws(
      () => resolveSecrets(chain, {}),
      err => {
        assert.ok(/Config 'zai-glm'/.test(err.message), `missing config name in: ${err.message}`);
        assert.ok(/ZAI_API_KEY/.test(err.message), `missing var name in: ${err.message}`);
        return true;
      },
    );
  });

  test('empty string env var rejects (not set or empty)', () => {
    const chain = resolveChain(VALID_RAW, null);
    assert.throws(
      () => resolveSecrets(chain, { ZAI_API_KEY: '' }),
      { message: /ZAI_API_KEY.*not set or empty/ },
    );
  });
});

// ─── assertNoLegacyConflict ───────────────────────────────────────────────────

describe('assertNoLegacyConflict — ZAI_* + CONFIG_FILE mutual exclusion', () => {
  test('config file present + ZAI_API_KEY present = loud failure', () => {
    assert.throws(
      () => assertNoLegacyConflict('.github/review-agents.yml', true, 'sk-some-key'),
      err => {
        assert.ok(/Cannot use both CONFIG_FILE/.test(err.message), `missing conflict message in: ${err.message}`);
        assert.ok(/ZAI_API_KEY/.test(err.message));
        assert.ok(/\.github\/review-agents\.yml/.test(err.message));
        return true;
      },
    );
  });

  test('config file absent + ZAI_API_KEY present = no conflict', () => {
    assert.doesNotThrow(() => assertNoLegacyConflict('.github/review-agents.yml', false, 'sk-some-key'));
  });

  test('config file present + ZAI_API_KEY absent = no conflict', () => {
    assert.doesNotThrow(() => assertNoLegacyConflict('.github/review-agents.yml', true, ''));
  });
});

// ─── loadConfig — end-to-end with real file I/O ──────────────────────────────

describe('loadConfig — file loading', () => {
  function writeTempConfig(content) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zai-config-test-'));
    const filePath = path.join(dir, 'review-agents.yml');
    fs.writeFileSync(filePath, content, 'utf8');
    return { filePath, cleanup: () => fs.rmSync(dir, { recursive: true }) };
  }

  test('valid YAML file loads and resolves chain', () => {
    const { filePath, cleanup } = writeTempConfig(`
version: 1
default: zai-glm
configs:
  zai-glm:
    engine: claude-code
    model: glm-5.1
    endpoint:
      kind: anthropic-messages
      baseUrl: https://api.z.ai/api/anthropic
      apiKeyEnv: MY_API_KEY
`);
    try {
      const chain = loadConfig(filePath, null, { MY_API_KEY: 'sk-live-xyz' }, MOCK_REGISTRY);
      assert.equal(chain.length, 1);
      assert.equal(chain[0].name, 'zai-glm');
      assert.equal(chain[0].endpoint.apiKey, 'sk-live-xyz');
      assert.ok(!('apiKeyEnv' in chain[0].endpoint));
    } finally {
      cleanup();
    }
  });

  test('selected config overrides default', () => {
    const { filePath, cleanup } = writeTempConfig(`
version: 1
default: zai-glm
configs:
  zai-glm:
    engine: claude-code
    model: glm-5.1
    endpoint:
      kind: anthropic-messages
      baseUrl: https://api.z.ai/api/anthropic
      apiKeyEnv: ZAI_KEY
  codex-gpt55:
    engine: codex
    model: gpt-5.5
    endpoint:
      kind: openai-responses
      baseUrl: https://api.openai.com/v1
      apiKeyEnv: OAI_KEY
`);
    try {
      const chain = loadConfig(filePath, 'codex-gpt55', { ZAI_KEY: 'a', OAI_KEY: 'b' }, MOCK_REGISTRY);
      assert.equal(chain[0].name, 'codex-gpt55');
      assert.equal(chain[0].endpoint.apiKey, 'b');
    } finally {
      cleanup();
    }
  });

  test('unknown selectedName rejects with informative message', () => {
    const { filePath, cleanup } = writeTempConfig(`
version: 1
default: zai-glm
configs:
  zai-glm:
    engine: claude-code
    model: glm-5.1
    endpoint:
      kind: anthropic-messages
      baseUrl: https://api.z.ai/api/anthropic
      apiKeyEnv: MY_KEY
`);
    try {
      assert.throws(
        () => loadConfig(filePath, 'ghost', { MY_KEY: 'k' }, MOCK_REGISTRY),
        err => {
          assert.ok(/ghost/.test(err.message));
          assert.ok(/not found/.test(err.message));
          assert.ok(/zai-glm/.test(err.message));
          return true;
        },
      );
    } finally {
      cleanup();
    }
  });

  test('missing file rejects with informative message', () => {
    assert.throws(
      () => loadConfig('/nonexistent/review-agents.yml', null, {}, MOCK_REGISTRY),
      { message: /Failed to read config file/ },
    );
  });
});
