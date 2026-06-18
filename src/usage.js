'use strict';

// Per-run token/cost reporting.
//
// [LAW:decomposition] Two cohesive concerns live here: the OpenAI price table (a
// representation that drifts from OpenAI's real prices and must be hand-maintained) and the
// pure renderer that formats an already-extracted Usage value into the review footer line.
// Extraction is engine-specific and lives in each adapter (engine/codex.js, engine/claude-code.js);
// this module only computes the Codex cost (from tokens x price) and formats the footer.
// [LAW:single-enforcer] Codex cost is computed in exactly one place: computeOpenAiCostUsd.

// [LAW:one-source-of-truth] The OpenAI price table. Dollars per ONE MILLION tokens, matching
// OpenAI's published per-1M figures so the numbers can be eyeballed against the pricing page.
// PRICE-SENSITIVE: these drift whenever OpenAI changes prices and have no machine source —
// they MUST be updated by hand. Last verified 2026-06-14 against https://openai.com/api/pricing/
// cachedInput is the discounted prompt-cache rate: across the GPT-5 family that is a 90% discount
// (cached = 10% of input), so each cachedInput is one-tenth of its input — keep that ratio when
// adding or updating a model unless OpenAI publishes a different cache discount for it.
const OPENAI_PRICES_PER_MILLION = {
  'gpt-5.5': { input: 5.00, cachedInput: 0.50, output: 30.00 },
  'gpt-5.4': { input: 2.50, cachedInput: 0.25, output: 15.00 },
  'gpt-5.4-mini': { input: 0.75, cachedInput: 0.075, output: 4.50 },
};

// [LAW:effects-at-boundaries] Pure: tokens + model -> USD, no IO. Returns null (cost unknown)
// when the model has no price-table entry — never a fabricated zero, so a missing price surfaces
// as "unknown" rather than a confident-but-wrong $0.00. [LAW:no-silent-failure]
// input_tokens from the OpenAI/Codex usage event is the FULL prompt count (cached included);
// the cached subset is billed at the discounted cachedInput rate, the remainder at input rate.
// output_tokens already includes reasoning tokens, so they are priced once at the output rate.
function computeOpenAiCostUsd({ inputTokens, outputTokens, cachedInputTokens = 0 }, model) {
  const price = OPENAI_PRICES_PER_MILLION[model];
  if (!price) return null;
  const nonCachedInput = Math.max(0, inputTokens - cachedInputTokens);
  const total =
    nonCachedInput * price.input +
    cachedInputTokens * price.cachedInput +
    outputTokens * price.output;
  return total / 1_000_000;
}

// Claude Code self-reports total_cost_usd using Anthropic's price table, so that figure is this
// run's billing basis ONLY when the engine truly talks to Anthropic. Against an Anthropic-COMPATIBLE
// endpoint (z.ai, deepseek, …) it is priced for the wrong vendor and is not a usable cost.
// [LAW:types-are-the-program] Whitelist the genuine endpoint rather than blacklisting known
// impostors: default to "not Anthropic" so every foreign endpoint is excluded by construction, not
// one vendor at a time. An absent baseUrl means Claude Code's built-in default — Anthropic's own API.
function isAnthropicEndpoint(config) {
  const baseUrl = config.endpoint && config.endpoint.baseUrl;
  if (!baseUrl) return true;
  try {
    // [LAW:types-are-the-program] Match the anthropic.com domain exactly — the apex or a true
    // subdomain — never a bare `endsWith('anthropic.com')`, which a lookalike host like
    // `notanthropic.com` would satisfy and be wrongly trusted as Anthropic's billing basis.
    const host = new URL(baseUrl).hostname;
    return host === 'anthropic.com' || host.endsWith('.anthropic.com');
  } catch {
    return false;
  }
}

// The endpoint host, for the "cost unknown — foreign endpoint" warning. Falls back to the raw
// baseUrl if it does not parse, and to Anthropic's host when there is no override.
function endpointHost(config) {
  const baseUrl = config.endpoint && config.endpoint.baseUrl;
  if (!baseUrl) return 'api.anthropic.com';
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return baseUrl;
  }
}

function formatTokenCount(n) {
  return n.toLocaleString('en-US');
}

function reviewerTag(config) {
  return `${config.engine}/${config.model || '(default model)'}`;
}

// [LAW:effects-at-boundaries] Pure: render the cost footer line from a Usage value, or '' when
// there is no usage to report. The "loud" warning for missing usage/price is an effect and
// belongs at the run boundary (src/run.js); costWarning below produces its text, also purely.
// [LAW:dataflow-not-control-flow] usage === null and an unavailable cost are distinct values with
// distinct renderings, not branches that skip work: no usage -> no line; cost unavailable ->
// tokens with cost "unknown".
function renderCostLine(usage, config) {
  if (!usage) return '';
  const tag = reviewerTag(config);
  const tokens = `${formatTokenCount(usage.inputTokens)} in / ${formatTokenCount(usage.outputTokens)} out tokens`;
  if (!usage.cost.available) {
    return `_Cost: unknown · ${tokens} · ${tag}_`;
  }
  // [FRAMING:representation] Every available cost this action renders is an ESTIMATE, never a billed
  // charge: codex is price-table × tokens, claude-code's total_cost_usd is Claude Code's own
  // client-side estimate. So every line is marked "est." rather than implying exactness. A foreign
  // (non-Anthropic) claude-code endpoint never reaches here: its cost is unavailable upstream
  // (reason 'foreign-endpoint'), so a wrong-vendor figure is never rendered as a dollar amount.
  return `_Cost: $${usage.cost.usd.toFixed(4)} · ${tokens} · ${tag} · est._`;
}

// [LAW:effects-at-boundaries] Pure: the text of the "cost unavailable" warning, or null when cost
// is fully reported. [LAW:no-silent-failure] the message names the ACTUAL cause, dispatched on the
// reason VALUE the adapter carried — never re-derived by branching on engine at the boundary. This
// is why the reason lives in usage.cost: run.js stays ignorant of which engines are table-priced.
function costWarning(usage, config) {
  if (!usage) return 'Engine reported no token usage; the review footer omits the cost line.';
  if (usage.cost.available) return null;
  const tag = reviewerTag(config);
  if (usage.cost.reason === 'no-price') {
    return `No price-table entry for ${tag}; the review footer shows cost as "unknown". `
      + 'Add the model to OPENAI_PRICES_PER_MILLION in src/usage.js.';
  }
  // [LAW:no-silent-failure] claude-code's self-reported cost is Anthropic-priced; against a
  // non-Anthropic endpoint that figure is the wrong vendor's, so it is withheld and the cause is
  // named loudly rather than rendered as a confident, wrong dollar amount.
  if (usage.cost.reason === 'foreign-endpoint') {
    return `${tag} ran against a non-Anthropic endpoint (${endpointHost(config)}); claude-code `
      + 'self-reports cost using Anthropic prices, which is not this provider\'s billing, so the '
      + 'review footer shows cost as "unknown" (tokens still shown).';
  }
  return `${config.engine} reported no cost (no USD in its output) for ${tag}; `
    + 'the review footer shows cost as "unknown".';
}

module.exports = {
  OPENAI_PRICES_PER_MILLION,
  computeOpenAiCostUsd,
  renderCostLine,
  costWarning,
  formatTokenCount,
  isAnthropicEndpoint,
};
