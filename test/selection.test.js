'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { selectConfig } = require('../src/selection');

// [LAW:verifiable-goals] AC for T6: table-driven matrix over (labels, body, input, default)
// covering full precedence, multi-label failure, and unknown-name failure message content.

const CONFIG_NAMES = ['zai-glm', 'codex-gpt55', 'oc-mini'];
const DEFAULT = 'zai-glm';

function opts(configInput = '') {
  return { configInput, configNames: CONFIG_NAMES, defaultName: DEFAULT };
}

function labels(...names) {
  return names.map(name => ({ name }));
}

// ────────────────────────────────────────────────────────────────────────────
// Precedence: label > body > configInput > default
// ────────────────────────────────────────────────────────────────────────────

describe('selectConfig — precedence matrix', () => {
  const cases = [
    // label wins
    {
      desc: 'label alone selects config',
      pr: { labels: labels('review:codex-gpt55'), body: null },
      opts: opts(''),
      expected: 'codex-gpt55',
    },
    {
      desc: 'label overrides body directive',
      pr: { labels: labels('review:codex-gpt55'), body: 'Review-Config: oc-mini' },
      opts: opts(''),
      expected: 'codex-gpt55',
    },
    {
      desc: 'label overrides CONFIG input',
      pr: { labels: labels('review:oc-mini'), body: null },
      opts: opts('codex-gpt55'),
      expected: 'oc-mini',
    },
    {
      desc: 'label overrides both body and CONFIG input',
      pr: { labels: labels('review:oc-mini'), body: 'Review-Config: codex-gpt55' },
      opts: opts('zai-glm'),
      expected: 'oc-mini',
    },

    // body wins when no review: label
    {
      desc: 'body directive selects config when no label',
      pr: { labels: [], body: 'Review-Config: codex-gpt55' },
      opts: opts(''),
      expected: 'codex-gpt55',
    },
    {
      desc: 'body directive overrides CONFIG input',
      pr: { labels: [], body: 'Review-Config: oc-mini' },
      opts: opts('codex-gpt55'),
      expected: 'oc-mini',
    },
    {
      desc: 'body directive is case-insensitive',
      pr: { labels: [], body: 'REVIEW-CONFIG: codex-gpt55' },
      opts: opts(''),
      expected: 'codex-gpt55',
    },
    {
      desc: 'body directive with leading whitespace',
      pr: { labels: [], body: '  Review-Config: oc-mini' },
      opts: opts(''),
      expected: 'oc-mini',
    },
    {
      desc: 'body directive with trailing whitespace',
      pr: { labels: [], body: 'Review-Config: oc-mini   ' },
      opts: opts(''),
      expected: 'oc-mini',
    },
    {
      desc: 'body directive embedded in multi-line body',
      pr: { labels: [], body: 'Fix the thing.\n\nReview-Config: codex-gpt55\n\nSigned-off-by: dev' },
      opts: opts(''),
      expected: 'codex-gpt55',
    },

    // CONFIG input wins when no label and no body directive
    {
      desc: 'CONFIG input selects config when no label or body',
      pr: { labels: [], body: null },
      opts: opts('codex-gpt55'),
      expected: 'codex-gpt55',
    },
    {
      desc: 'CONFIG input selects config when body has no directive',
      pr: { labels: [], body: 'No directive here.' },
      opts: opts('oc-mini'),
      expected: 'oc-mini',
    },

    // default fallthrough
    {
      desc: 'falls through to file default when nothing is specified',
      pr: { labels: [], body: null },
      opts: opts(''),
      expected: DEFAULT,
    },
    {
      desc: 'falls through to default when body has no directive and no input',
      pr: { labels: [], body: 'Just a description.' },
      opts: opts(''),
      expected: DEFAULT,
    },

    // labels that are not review: labels are ignored
    {
      desc: 'non-review labels are ignored',
      pr: { labels: labels('bug', 'enhancement'), body: null },
      opts: opts(''),
      expected: DEFAULT,
    },
    {
      desc: 'non-review label does not block body directive',
      pr: { labels: labels('bug'), body: 'Review-Config: codex-gpt55' },
      opts: opts(''),
      expected: 'codex-gpt55',
    },

    // null/undefined body edge cases
    {
      desc: 'null body does not throw',
      pr: { labels: [], body: null },
      opts: opts('oc-mini'),
      expected: 'oc-mini',
    },
    {
      desc: 'undefined body does not throw',
      pr: { labels: [], body: undefined },
      opts: opts('oc-mini'),
      expected: 'oc-mini',
    },
    {
      desc: 'empty string body does not throw',
      pr: { labels: [], body: '' },
      opts: opts('oc-mini'),
      expected: 'oc-mini',
    },

    // undefined labels treated as empty
    {
      desc: 'undefined labels treated as empty',
      pr: { labels: undefined, body: null },
      opts: opts('oc-mini'),
      expected: 'oc-mini',
    },
  ];

  for (const tc of cases) {
    it(tc.desc, () => {
      const result = selectConfig(tc.pr, tc.opts);
      assert.equal(result, tc.expected);
    });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Failure: multiple review: labels (ambiguous)
// ────────────────────────────────────────────────────────────────────────────

describe('selectConfig — multi-label ambiguity', () => {
  it('throws when two review: labels are present', () => {
    assert.throws(
      () => selectConfig(
        { labels: labels('review:zai-glm', 'review:codex-gpt55'), body: null },
        opts(''),
      ),
      err => {
        assert.match(err.message, /Ambiguous/);
        assert.match(err.message, /review:zai-glm/);
        assert.match(err.message, /review:codex-gpt55/);
        return true;
      },
    );
  });

  it('throws when three review: labels are present', () => {
    assert.throws(
      () => selectConfig(
        { labels: labels('review:zai-glm', 'review:codex-gpt55', 'review:oc-mini'), body: null },
        opts(''),
      ),
      /Ambiguous/,
    );
  });

  it('includes defined configs in the ambiguity error', () => {
    assert.throws(
      () => selectConfig(
        { labels: labels('review:zai-glm', 'review:codex-gpt55'), body: null },
        opts(''),
      ),
      err => {
        assert.match(err.message, /zai-glm/);
        assert.match(err.message, /codex-gpt55/);
        assert.match(err.message, /oc-mini/); // defined configs listed
        return true;
      },
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Failure: unknown config name — each source path
// ────────────────────────────────────────────────────────────────────────────

describe('selectConfig — unknown config name', () => {
  it('throws for unknown name from label, naming source and defined configs', () => {
    assert.throws(
      () => selectConfig(
        { labels: labels('review:unknown-engine'), body: null },
        opts(''),
      ),
      err => {
        assert.match(err.message, /unknown-engine/);
        assert.match(err.message, /label/);
        assert.match(err.message, /zai-glm/);
        assert.match(err.message, /codex-gpt55/);
        assert.match(err.message, /oc-mini/);
        return true;
      },
    );
  });

  it('throws for unknown name from body directive, naming source and defined configs', () => {
    assert.throws(
      () => selectConfig(
        { labels: [], body: 'Review-Config: no-such-config' },
        opts(''),
      ),
      err => {
        assert.match(err.message, /no-such-config/);
        assert.match(err.message, /body directive/);
        assert.match(err.message, /zai-glm/);
        return true;
      },
    );
  });

  it('throws for unknown name from CONFIG input, naming source and defined configs', () => {
    assert.throws(
      () => selectConfig(
        { labels: [], body: null },
        opts('phantom-config'),
      ),
      err => {
        assert.match(err.message, /phantom-config/);
        assert.match(err.message, /CONFIG input/);
        assert.match(err.message, /zai-glm/);
        return true;
      },
    );
  });
});
