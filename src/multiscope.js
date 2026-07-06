'use strict';
const { produceReview, retryTransientSpawn, sleep } = require('./failover');
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
// [LAW:no-ambient-temporal-coupling] Retry lives at TWO nested layers, each owned by failover.js so
// this module reimplements no retry timing. Inner: every engine spawn (the scout and each worker) is
// wrapped in retryTransientSpawn, so a single transient blip in one of N concurrent workers is
// absorbed in place — the sibling workers' already-recorded findings are never discarded by re-running
// the whole pass. Outer: the WHOLE pass (scout → workers → aggregate) is still ONE attempt of
// failover.produceReview per config, so a transient that PERSISTS past a spawn's inner retries
// escalates to config-level failover/budget as before. Both layers are fail-loud (a scope is never
// dropped); the run only reds when a transient genuinely survives both. [LAW:no-silent-failure]

// [LAW:no-mode-explosion] One internal constant, not a consumer input: how many scope workers run
// concurrently. Quality is identical at any concurrency; this only trades runner load for wall time.
const DEFAULT_SCOPE_CONCURRENCY = 4;

// [LAW:types-are-the-program] A scope is the strongest true theorem: a named focus, nothing more.
// There is deliberately NO `kind` discriminator — module scopes and boundary scopes are reviewed by
// the identical worker, so the difference lives entirely in the focus TEXT, never in a branch. The
// scout records each scope through the add_scope collector tool, so scopes arrive as typed,
// schema-validated values (parseScopeValue, in src/review.js) — never parsed from the model's prose.
// [FRAMING:representation] That is why this module no longer extracts a JSON array from text: the
// representation a machine checks (the tool schema) replaced the representation we hoped to recover
// (brackets in free text), and the whole class of prose-parsing bugs went with it.

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
//
// [LAW:no-silent-failure] Severity decides the merge gate, so a duplicate must never lose its severity
// to arrival order: when two workers flag the same key with different severities, the merged finding is
// 'blocking' if ANY member is — the stronger severity wins, never the one that happened to arrive first.
// A blocking finding can never be silently downgraded to the advisory that preceded it. First-seen
// order is preserved (a Map keeps a key's original position when its value is replaced).
function dedupeFindings(findings) {
  const byKey = new Map();
  for (const f of findings) {
    const key = `${f.path}:${f.line}:${(f.body || '').slice(0, 60)}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, f);
    } else if (f.severity === 'blocking' && existing.severity !== 'blocking') {
      byKey.set(key, f);
    }
  }
  return [...byKey.values()];
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
// `spawn` is the transient-retry-wrapped engine spawn (see runMultiScopePass), so a blip retries THIS
// worker in place rather than failing the whole pass. [LAW:decomposition]
async function runScopeWorker({ scope, context, material, spawn, log }) {
  const focusText = workerFocusText(scope, context);
  const buildPromptFor = (toolNames) => material.buildWorkerPrompt(focusText, toolNames);
  log(`scope '${scope.name}' starting…`);
  const { summary, findings, usage } = await spawn(buildPromptFor, `scope '${scope.name}'`);
  log(`scope '${scope.name}' done — ${findings.length} finding(s)`);
  return { name: scope.name, summary, findings, usage };
}

// One full multi-scope pass for ONE config: scout → workers → aggregate. This is the produceOnce that
// failover.produceReview drives, so the whole pass is one attempt and retry/failover wraps it as a
// unit. Returns the same {summary, findings, usage} shape a single engine spawn used to return, so
// every downstream sink stays unchanged. [LAW:decomposition]
async function runMultiScopePass({ config, material, registry, instructionsPath, maxConcurrent, log, sleepFn = sleep }) {
  const adapter = registry.get(config.engine);

  // [LAW:decomposition] Every engine spawn in this pass goes through one transient-retry seam, so a
  // single flaky request (a dropped socket, a 5xx) is absorbed in place — the scout and each worker
  // recover independently and a blip never re-runs the whole pass. An exhausted or non-transient error
  // still propagates, so config-level failover (produceReview) is unchanged. [LAW:one-source-of-truth]
  const spawn = (buildPromptFor, label) =>
    retryTransientSpawn(
      () => adapter.produceReview({ config, buildPromptFor, instructionsPath }),
      {
        sleepFn,
        onRetry: ({ attempt, limit, delay, err }) =>
          log(`${label}: transient error (attempt ${attempt}/${limit}), retrying in ${Math.round(delay / 1000)}s: ${err.message}`),
      },
    );

  // Layer 1 — the scout: a survey-only spawn. Its product is the typed scope records it logged through
  // the add_scope collector tool (validated at the collector boundary), plus a structural summary that
  // becomes shared worker context. Its findings, if any, are ignored by design. [LAW:no-silent-failure]
  // a scout that planned zero scopes fails loud here rather than running zero workers and "succeeding"
  // having reviewed nothing.
  const scoutResult = await spawn(material.buildScoutPrompt, 'scout');
  const scopes = scoutResult.scopes;
  if (scopes.length === 0) {
    throw new Error(`Scout planned no scopes (no add_scope calls). Scout summary:\n${scoutResult.summary}`);
  }
  log(`scout planned ${scopes.length} scope(s): ${scopes.map(s => s.name).join(', ')}`);
  const context = scoutResult.summary.trim();

  // Layer 2 — one worker per scope, judging in parallel under the concurrency cap.
  const workerResults = await runScopeWorkers({
    scopes,
    maxConcurrent,
    runOne: (scope) => runScopeWorker({ scope, context, material, spawn, log }),
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
function runMultiScope({ chain, material, registry, instructionsPath, maxConcurrent = DEFAULT_SCOPE_CONCURRENCY, log = () => {}, sleepFn = sleep }) {
  const produceOnce = (config) => runMultiScopePass({ config, material, registry, instructionsPath, maxConcurrent, log, sleepFn });
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
