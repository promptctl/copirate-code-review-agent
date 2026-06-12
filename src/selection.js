'use strict';

// [LAW:effects-at-boundaries] Pure: no IO, no side effects.
// selectConfig(pr, opts) -> string (selected config name)
// [LAW:no-silent-failure] Throws on: multiple review: labels, unknown config name.
// [LAW:dataflow-not-control-flow] Precedence is expressed as a waterfall over values
// (label > body > configInput > defaultName), not as branch logic that skips operations.

const REVIEW_LABEL_PREFIX = 'review:';
// [LAW:one-source-of-truth] Single regex for the PR-body directive; identical to the plan spec.
const BODY_DIRECTIVE_RE = /^\s*review-config:\s*([a-z0-9_-]+)\s*$/im;

// Returns the selected config name.
// pr:   { labels: [{name: string}], body: string|null|undefined }
// opts: { configInput: string, configNames: string[], defaultName: string }
// [LAW:no-silent-failure] Unknown name → throws an error naming the request, source, and
// defined configs. Multiple review: labels → throws naming all found labels.
function selectConfig(pr, { configInput, configNames, defaultName }) {
  const reviewLabels = (pr.labels || []).filter(l => l.name.startsWith(REVIEW_LABEL_PREFIX));

  if (reviewLabels.length > 1) {
    const found = reviewLabels.map(l => l.name).join(', ');
    throw new Error(
      `Ambiguous reviewer selection: ${reviewLabels.length} review: labels found (${found}). ` +
      `Remove all but one. Defined configs: ${configNames.join(', ')}.`,
    );
  }

  let selected, source;

  if (reviewLabels.length === 1) {
    selected = reviewLabels[0].name.slice(REVIEW_LABEL_PREFIX.length);
    source = `label '${reviewLabels[0].name}'`;
  } else {
    const bodyMatch = (pr.body || '').match(BODY_DIRECTIVE_RE);
    if (bodyMatch) {
      selected = bodyMatch[1];
      source = `body directive 'Review-Config: ${bodyMatch[1]}'`;
    } else if (configInput) {
      selected = configInput;
      source = `CONFIG input '${configInput}'`;
    } else {
      // [LAW:no-defensive-null-guards] defaultName is always valid — it was read from the
      // config file by peekConfigNames and verified to exist in configs by loadConfig.
      return defaultName;
    }
  }

  if (!configNames.includes(selected)) {
    throw new Error(
      `Requested config '${selected}' (source: ${source}) is not defined. ` +
      `Defined configs: ${configNames.join(', ')}.`,
    );
  }

  return selected;
}

module.exports = { selectConfig, BODY_DIRECTIVE_RE };
