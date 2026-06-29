'use strict';
const { produceReview } = require('./failover');
const {
  buildReviewInput,
  buildRepoReviewInput,
  buildPrScoutInput,
  buildRepoScoutInput,
} = require('./prompt');

// The adaptive multi-scope review engine, shared by both review modes (PR and whole-repo).
//
// [FRAMING:parts-and-seams] A review IS one shape regardless of material or sink: a SCOUT plans the
// review (one survey spawn that emits a list of scopes), then one WORKER per scope judges it (one
// review spawn each), then the workers' findings + usage AGGREGATE into a single review value. PR and
// repo differ only in two values they already differ on elsewhere — the `material` (what the scout
// surveys and what each worker reviews) and the `sink` (how findings leave). [LAW:one-type-per-behavior]
//
// Adaptivity is the GROUPING, not a counted threshold: the scout groups the change by concern and
// follows the import edges it actually crosses, so a one-concern change yields one scope and a
// many-concern change yields many — the same worker pool runs over a list of length 1 or 20,
// identically. There is no "is it big" branch anywhere. [LAW:dataflow-not-control-flow]
//
// [LAW:no-ambient-temporal-coupling] The WHOLE pass (scout → workers → aggregate) is ONE attempt of
// failover.produceReview per config: a transient error in the scout or any worker fails the pass and
// failover retries/advances the entire pass as a unit. produceReview stays the single owner of retry
// timing; this module never reimplements it.

// [LAW:no-mode-explosion] One internal constant, not a consumer input: how many scope workers run
// concurrently. Quality is identical at any concurrency; this only trades runner load for wall time.
const DEFAULT_SCOPE_CONCURRENCY = 4;

// Extract the first BALANCED JSON array from text, honoring nested brackets and quoted strings.
// A greedy /\[[\s\S]*\]/ fails when several arrays share a document (it spans the first '[' to the
// last ']'); this bracket counter returns just the first complete array. [LAW:no-silent-failure]
function extractFirstJsonArray(text) {
  const start = text.indexOf('[');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === '"') inString = false;
    } else {
      if (ch === '"') { inString = true; continue; }
      if (ch === '[') depth++;
      else if (ch === ']') { depth--; if (depth === 0) return text.slice(start, i + 1); }
    }
  }
  return null;
}

// [LAW:types-are-the-program] A scope is the strongest true theorem: a named focus, nothing more.
// There is deliberately NO `kind` discriminator — module scopes and boundary scopes are reviewed by
// the identical worker, so the difference lives entirely in the focus TEXT, never in a branch.
// [LAW:no-silent-failure] A malformed plan throws loudly here, naming what was wrong, rather than
// running vacuous workers that would make the whole review succeed having examined nothing.
function parseScopes(summary) {
  const raw = extractFirstJsonArray(summary);
  if (!raw) throw new Error(`Scout did not produce a JSON scope array. Summary was:\n${summary}`);
  let scopes;
  try {
    scopes = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Scout scope plan is not valid JSON: ${e.message}\nRaw: ${raw}`);
  }
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new Error(`Scout scope plan must be a non-empty JSON array. Raw: ${raw}`);
  }
  return scopes.map((s, i) => {
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      throw new Error(`Scope ${i + 1} is not an object. Raw: ${raw}`);
    }
    const name = typeof s.name === 'string' ? s.name.trim() : '';
    const focus = typeof s.focus === 'string' ? s.focus.trim() : '';
    if (!name) throw new Error(`Scope ${i + 1} has an invalid or empty name. Raw: ${raw}`);
    if (!focus) throw new Error(`Scope ${i + 1} ('${name}') has an invalid or empty focus. Raw: ${raw}`);
    return { name, focus };
  });
}

// [LAW:effects-at-boundaries] Pure: the scout's structural prose is everything BEFORE the JSON array.
// It becomes shared context handed to every worker so each understands how its part fits the whole.
function structuralProse(scoutSummary) {
  const bracket = scoutSummary.indexOf('[');
  return (bracket === -1 ? scoutSummary : scoutSummary.slice(0, bracket)).trim();
}

// [LAW:effects-at-boundaries] Pure: compose the single focus string a worker receives — the scout's
// structural context (when present) plus this scope's name and focus. The material turns it into the
// engine prompt (a PR worker's CONCENTRATE block, a repo worker's scope focus).
function workerFocusText(scope, context) {
  const prefix = context ? `Structural context from the planning pass:\n${context}\n\n---\n\n` : '';
  return `${prefix}${scope.name} — ${scope.focus}`;
}

// [LAW:effects-at-boundaries] Pure: one dedup pass over the MERGED findings (not per worker), since
// two adjacent scopes can both touch a shared file. Keyed by path:line:body-prefix — the same key the
// printed report and the PR review treat as "the same finding". [LAW:one-source-of-truth]
function dedupeFindings(findings) {
  const seen = new Set();
  return findings.filter(f => {
    const key = `${f.path}:${f.line}:${(f.body || '').slice(0, 60)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// [LAW:effects-at-boundaries] Pure: sum the per-spawn Usage values into one. Token counts always add.
// Cost is uniform by construction — every spawn in a pass runs on ONE config, so all costs share the
// same model and the same availability — so the sum is available iff every spawn's cost is, carrying
// the same unavailable reason otherwise. [LAW:no-silent-failure] no spawn's cost is silently dropped.
// usage === null (an engine reported nothing) is excluded; all-null sums to null, matching the
// single-spawn behavior the cost renderer already handles.
function sumUsage(usages) {
  const present = usages.filter(Boolean);
  if (present.length === 0) return null;
  const inputTokens = present.reduce((sum, u) => sum + u.inputTokens, 0);
  const outputTokens = present.reduce((sum, u) => sum + u.outputTokens, 0);
  const cost = present.every(u => u.cost.available)
    ? { available: true, usd: present.reduce((sum, u) => sum + u.cost.usd, 0) }
    : { available: false, reason: present.find(u => !u.cost.available).cost.reason };
  return { inputTokens, outputTokens, cost };
}

// [LAW:effects-at-boundaries] Pure: the aggregated review summary. It names every scope reviewed and
// carries each worker's own summary verbatim — never the scout's raw JSON, which stays out of the
// author-facing text. [LAW:one-source-of-truth]
function composeSummary(scopes, workerResults) {
  const lines = [`Reviewed ${scopes.length} scope(s): ${scopes.map(s => s.name).join(', ')}.`, ''];
  for (const r of workerResults) {
    lines.push(`**${r.name}** — ${(r.summary || '(no summary)').trim()}`);
  }
  return lines.join('\n');
}

// [LAW:dataflow-not-control-flow] A bounded-concurrency worker pool that is FAIL-LOUD: the first error
// stops new work and is rethrown after in-flight workers settle, preserving its type (a TransientError
// stays a TransientError so failover can classify it). [LAW:no-silent-failure] this is the deliberate
// inverse of swallowing a failed scope into an empty-finding result — an unreviewed scope must never
// pass as a clean one. results are returned in scope order.
async function runScopeWorkers({ scopes, runOne, maxConcurrent }) {
  const results = new Array(scopes.length);
  let next = 0;
  let firstError = null;
  async function lane() {
    while (next < scopes.length && !firstError) {
      const i = next++;
      try {
        results[i] = await runOne(scopes[i]);
      } catch (e) {
        firstError = firstError || e;
      }
    }
  }
  const laneCount = Math.min(Math.max(1, maxConcurrent), scopes.length);
  await Promise.all(Array.from({ length: laneCount }, lane));
  if (firstError) throw firstError;
  return results;
}

// One scope worker: a single review spawn on this config, focused on one scope. [LAW:composability]
// It does one thing — review one scope — and returns its raw findings + summary + usage as a value.
async function runScopeWorker({ scope, context, config, material, adapter, instructionsPath, log }) {
  const focusText = workerFocusText(scope, context);
  const buildPromptFor = (toolNames) => material.buildWorkerPrompt(focusText, toolNames);
  log(`scope '${scope.name}' starting…`);
  const { summary, findings, usage } = await adapter.produceReview({ config, buildPromptFor, instructionsPath });
  log(`scope '${scope.name}' done — ${findings.length} finding(s)`);
  return { name: scope.name, summary, findings, usage };
}

// One full multi-scope pass for ONE config: scout → workers → aggregate. This is the produceOnce that
// failover.produceReview drives, so the whole pass is one attempt and retry/failover wraps it as a
// unit. Returns the same {summary, findings, usage} shape a single engine spawn used to return, so
// every downstream sink stays unchanged. [LAW:decomposition]
async function runMultiScopePass({ config, material, registry, instructionsPath, maxConcurrent, log }) {
  const adapter = registry.get(config.engine);

  // Layer 1 — the scout: a survey-only spawn. Its findings (if any) are ignored by design; its
  // product is the plan carried in its summary. [LAW:single-enforcer] parseScopes is the one validator.
  const scoutResult = await adapter.produceReview({ config, buildPromptFor: material.buildScoutPrompt, instructionsPath });
  const scopes = parseScopes(scoutResult.summary);
  log(`scout planned ${scopes.length} scope(s): ${scopes.map(s => s.name).join(', ')}`);
  const context = structuralProse(scoutResult.summary);

  // Layer 2 — one worker per scope, judging in parallel under the concurrency cap.
  const workerResults = await runScopeWorkers({
    scopes,
    maxConcurrent,
    runOne: (scope) => runScopeWorker({ scope, context, config, material, adapter, instructionsPath, log }),
  });

  return {
    summary: composeSummary(scopes, workerResults),
    findings: dedupeFindings(workerResults.flatMap(r => r.findings)),
    usage: sumUsage([scoutResult.usage, ...workerResults.map(r => r.usage)]),
  };
}

// The engine seam both modes call. Wraps the multi-scope pass in failover.produceReview so the whole
// pass retries/advances per config. produceReview supplies (config, buildPromptFor, anchors); the
// multi-scope pass builds its own prompts per spawn from `material`, so the latter two are unused
// here — passed null, exactly as repo mode already passes null anchors. [LAW:composability]
// log is the injected progress effect (core.info in the action, a stderr writer in the dev script).
function runMultiScope({ chain, material, registry, instructionsPath, maxConcurrent = DEFAULT_SCOPE_CONCURRENCY, log = () => {} }) {
  const produceOnce = (config) => runMultiScopePass({ config, material, registry, instructionsPath, maxConcurrent, log });
  return produceReview(chain, null, null, produceOnce);
}

// [LAW:decomposition] The two MATERIALS, built once each. A material knows how to build the scout
// prompt and a worker prompt from the inputs its mode already has; the engine above is material-blind.

// PR material: the scout is handed the changed file paths; each worker sees the WHOLE annotated diff
// (so every anchor stays valid) with its scope as the CONCENTRATE focus. files/maxDiffChars are the
// same values run.js uses to build the anchors, so worker findings and anchors share one diff.
function buildPrMaterial({ files, maxDiffChars, reviewedRepoRoot }) {
  const changedPaths = files.map(f => f.filename);
  return {
    buildScoutPrompt: (toolNames) => buildPrScoutInput({ changedPaths, toolNames, reviewedRepoRoot }).prompt,
    buildWorkerPrompt: (focusText, toolNames) => buildReviewInput(files, maxDiffChars, toolNames, reviewedRepoRoot, focusText).prompt,
  };
}

// Repo material: no diff. The scout surveys the tree; each worker reviews one scope, where the scope
// focus IS the repo-review `scope` value — so a worker is exactly a focused whole-repo review.
function buildRepoMaterial({ scope, excludePatterns, reviewedRepoRoot }) {
  return {
    buildScoutPrompt: (toolNames) => buildRepoScoutInput({ scope, excludePatterns, toolNames, reviewedRepoRoot }).prompt,
    buildWorkerPrompt: (focusText, toolNames) => buildRepoReviewInput({ scope: focusText, excludePatterns, toolNames, reviewedRepoRoot }).prompt,
  };
}

module.exports = {
  DEFAULT_SCOPE_CONCURRENCY,
  extractFirstJsonArray,
  parseScopes,
  structuralProse,
  workerFocusText,
  dedupeFindings,
  sumUsage,
  composeSummary,
  runScopeWorkers,
  runMultiScopePass,
  runMultiScope,
  buildPrMaterial,
  buildRepoMaterial,
};
