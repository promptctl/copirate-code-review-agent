'use strict';
const os = require('os');
const { produceReview, retryTransientSpawn, sleep, TRANSIENT_RETRY_BUDGET_MS, TransientError } = require('./failover');
const { DeadlineExceededError, BUDGET_REMEDY, remainingMs } = require('./deadline');
const { defaultEffortProfile, maxTier, readSetProjection } = require('./effort');
const { dedupeFindings, dedupeAssessments, parseScopeValue, firstLine } = require('./review');
const { sumCost, emptyTokens, addTokens } = require('./usage');
const { spawnRecord, scheduleRecord, spanMs, formatMs, passLabel, renderRunningTotal } = require('./schedule');
const { planRecord } = require('./plan');
const { partitionByDirectory } = require('./partition');
const { renderDependencyDiffNote } = require('./dependency-diff');
const { NO_EXCLUSIONS, excludedPathList } = require('./diff');
const {
  buildReviewInput,
  buildRepoReviewInput,
  buildRepoScoutInput,
} = require('./prompt');

// The adaptive multi-scope review engine, shared by both review modes (PR and whole-repo).
//
// [FRAMING:parts-and-seams] A review IS one shape regardless of material or sink: a SCOUT plans the
// review (one survey spawn that emits a list of scopes), then one WORKER per scope judges it (one
// review spawn each), then the workers' findings + usage AGGREGATE into a single review value. Each
// worker continues as its scope's CONVERGENCE CHAIN — re-reviewing the same scope, shown the findings
// recorded so far, hunting only for what is missing — until a sweep adds nothing new or the effort
// profile's sweepCap is reached (zai-recall-upr.2); one chain per scope, in its own lane, so no scope
// waits for a sibling. PR and repo differ only in two values they already differ on elsewhere — the
// `material` (what the scout surveys and what each worker reviews) and the `sink` (how findings
// leave). [LAW:one-type-per-behavior]
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

// [LAW:types-are-the-program] A scope is the strongest true theorem: a named focus, nothing more.
// There is deliberately NO `kind` discriminator — module scopes and boundary scopes are reviewed by
// the identical worker, so the difference lives entirely in the focus TEXT, never in a branch. The
// scout records each scope through the add_scope collector tool, so scopes arrive as typed,
// schema-validated values (parseScopeValue, in src/review.js) — never parsed from the model's prose.
// [FRAMING:representation] That is why this module no longer extracts a JSON array from text: the
// representation a machine checks (the tool schema) replaced the representation we hoped to recover
// (brackets in free text), and the whole class of prose-parsing bugs went with it.

// [LAW:effects-at-boundaries] Pure: compose the single focus string a worker receives — the scout's
// planning context (when present) plus this scope's name and focus. The material turns it into the
// engine prompt (a PR worker's CONCENTRATE block, a repo worker's scope focus).
// [LAW:one-source-of-truth] The label is mode-neutral because what that context DESCRIBES is decided in
// scoutOutputContract, not here: a change narrative in PR mode, the codebase's structure in repo mode.
// A label naming either shape would be a second, divergable statement of a fact this file does not own.
function workerFocusText(scope, context) {
  const prefix = context ? `Context from the planning pass:\n${context}\n\n---\n\n` : '';
  return `${prefix}${scope.name} — ${scope.focus}`;
}

// [LAW:one-source-of-truth] "Same finding" is decided by dedupeFindings in src/review.js — one dedup
// over the MERGED findings (not per worker), since two adjacent scopes can both touch a shared file.
// It is imported, never re-implemented, so the pre-anchor merge here and the post-anchor snap-collapse
// in partitionFindings share one key. [LAW:single-enforcer]

// [LAW:effects-at-boundaries] Pure: sum the per-spawn Usage values into one. Token counts always add.
// [LAW:single-enforcer] Summing COSTS is delegated to sumCost (src/usage.js), the one owner of the
// "never add across bases" rule — this module knows how to add tokens, not what a dollar means.
// The cost basis is uniform by construction here (every spawn in a pass runs on ONE config), so all
// costs share the same model and the same basis; sumCost still resolves the mixed case as a value.
// [LAW:no-silent-failure] no spawn's cost is silently dropped: one unpriced spawn makes the whole
// sum unpriced, carrying that spawn's reason.
// usage === null (no spawn record at all) is excluded; all-null sums to null, matching the
// single-spawn behavior the cost renderer already handles. A spawn whose engine reported nothing
// still carries its host-stamped span (zai-timing-31d.4), so its record arrives with tokens and
// cost ABSENT: it contributes its span to the envelope and nothing to the token or cost folds,
// and a pass where NO spawn reported tokens sums them to null — the renderer's "engine reported
// no token usage" value, never a fabricated zero. [LAW:parse-dont-validate]
function sumUsage(usages) {
  const present = usages.filter(Boolean);
  if (present.length === 0) return null;
  const tokens = present.map(u => u.tokens).filter(Boolean);
  const costs = present.map(u => u.cost).filter(Boolean);
  const requests = present.map(u => u.requests).filter(Boolean);
  return {
    tokens: tokens.length > 0 ? tokens.reduce(addTokens, emptyTokens()) : null,
    // The per-request breakdown an engine that observes each model request records (codex, via its
    // app-server session) is carried whole — the pass's requests are its spawns' requests, in the
    // order the spawns settled — and absent when no spawn recorded one, exactly as tokens are. It is the primary fact
    // behind a context-tiered cost, so the fold keeps it beside the sum it derives from.
    requests: requests.length > 0 ? requests.flat() : null,
    // The pass's SPAN is the envelope of its spawns' spans — earliest start, latest end — which is
    // the honest answer for a scheduler whose lanes overlap: the pass occupied that window,
    // and a restatement that needs to know which price epoch applies can see whether the window sits
    // inside one or straddles a boundary. Collapsing it to a single instant would hide the straddle.
    // [LAW:no-silent-failure] A spawn that recorded no span contributes none, exactly as a spawn
    // that recorded no usage contributes no tokens.
    span: sumSpan(present.map(u => u.span)),
    // Absent costs (engine reported nothing) are excluded from the fold exactly as their tokens
    // are; an UNPRICED cost is a present value and still poisons the sum, as before.
    cost: costs.length > 0 ? sumCost(costs) : null,
  };
}

// [LAW:effects-at-boundaries] Pure: fold spans by min-start/max-end. ISO-8601 UTC timestamps are
// lexicographically ordered, so string comparison IS chronological order and no Date round-trip is
// needed. All-absent folds to undefined — a recorded absence, never a fabricated window.
function sumSpan(spans) {
  const present = spans.filter(Boolean);
  if (present.length === 0) return undefined;
  return {
    from: present.reduce((min, s) => (s.from < min ? s.from : min), present[0].from),
    to: present.reduce((max, s) => (s.to > max ? s.to : max), present[0].to),
  };
}

// [LAW:effects-at-boundaries] Pure: the aggregated review summary. It leads with the SCOUT's summary —
// the one whole-change description this run produces — and then names every scope reviewed.
// [LAW:one-source-of-truth] That summary has one author and two readers: it is the orientation every
// worker reviews against (handed to them as `context`) and the author-facing summary here, written once
// for both. Per-scope worker summaries are deliberately NOT rendered. N workers each describing their
// own slice produced N paragraphs restating one change N times, and no worker can see the change whole
// enough to summarize it anyway — the scout is the only agent that does. A worker's output is its
// findings; its summary is not output.
// Each convergence sweep contributes one line stating what it added; sweeps is a value: [] (sweepCap 0,
// or the shape predating sweeps) renders nothing. [LAW:dataflow-not-control-flow]
// coverage is the pass's COVERAGE record (coverageOf): which scopes went unreviewed and why, which
// workers failed, the per-depth sweep fold, and whether the time budget bit. FULL_COVERAGE — the
// default, nothing unreviewed, nothing failed, no sweeps — renders nothing, so a run without a
// deadline that fit its lanes is byte-identical to before. [LAW:no-silent-failure] When coverage
// DID fall short, the coverage line names only the scopes actually reviewed, the unreviewed ones are
// listed by name under the cause that took them (the budget, or a worker that failed terminally —
// each with its message), and a curtailed convergence is called out — a partial review must never
// read like a clean bill. The scout summary standing above it describes the CHANGE and never the
// review, so it cannot soften that report into one.
function composeSummary(scoutSummary, scopes, coverage = FULL_COVERAGE) {
  const { unreviewed, scopeFailures, sweeps, budgetExhausted } = coverage;
  const unreviewedNames = new Set(unreviewed.map(u => u.name));
  const reviewed = scopes.filter(s => !unreviewedNames.has(s.name));
  const budgetUnreviewed = unreviewed.filter(u => u.cause === 'budget').map(u => u.name);
  const failedUnreviewed = unreviewed.filter(u => u.cause === 'failure').map(u => u.name);
  // [LAW:parse-dont-validate] Nothing is flattened here. A scope's name comes stamped single-line from
  // parseScopeValue and the scout's summary from parseReviewValue — which also refuses an empty one, so
  // there is no absent-summary state for this sink to represent. Neither can break this line-structured
  // summary. This sink previously flattened the name and NOT the summary — the exact shape of bug that
  // call-site discipline produces, and the reason the rule moved to the boundary.
  const lines = [scoutSummary, '', `Reviewed ${reviewed.length} scope(s): ${reviewed.map(s => s.name).join(', ')}.`];
  for (const [i, s] of sweeps.entries()) {
    // [FRAMING:representation] A curtailed sweep must never render as convergence: "added nothing
    // because it was killed" and "searched and found nothing" are different facts.
    lines.push(`**convergence sweep ${i + 1}** — ${s.curtailed.length > 0
      ? `cut short by ${s.curtailed.map(c => CURTAILMENT_BY[c]).join(' and ')} after ${s.added} new finding(s).`
      : s.added === 0 ? 'nothing new; the review converged.' : `${s.added} new finding(s).`}`);
  }
  if (budgetExhausted) {
    lines.push(budgetUnreviewed.length > 0
      ? `⏳ **Time budget exhausted** — ${reviewed.length} of ${scopes.length} scope(s) were reviewed; `
        + `NOT reviewed: ${budgetUnreviewed.join(', ')}. The findings above cover only the reviewed scopes.`
      : '⏳ **Time budget exhausted** — every scope was reviewed, but convergence sweeps were cut short; '
        + 'late-round findings may be missing.');
  }
  // [LAW:no-silent-failure] A worker that died terminally is named with what killed it, at the pass it
  // died on: at the review of record the scope is a coverage gap; at a sweep, pass 0's judgment stands
  // and only late-round findings may be missing — two facts, both stated, never folded into "partial".
  if (scopeFailures.length > 0) {
    lines.push(`⚠️ **Scope worker failed** — ${scopeFailures.map(f => `'${f.scope}' at ${passLabel(f.pass)}: ${f.message}`).join('; ')}. `
      + (failedUnreviewed.length > 0
        ? `NOT reviewed: ${failedUnreviewed.join(', ')}. The findings above cover only the reviewed scopes.`
        : 'Every scope was reviewed; the failed sweep may have left late-round findings missing.'));
  }
  return lines.join('\n');
}

// [LAW:types-are-the-program] Why a pass did not run to completion — the vocabulary `curtailed` speaks
// at every depth. 'budget': the wall-clock budget refused or killed it (planned degradation, owned by
// the deadline). 'failure': the worker died on an error no retry fixes — a context-window overflow, a
// crashed CLI — and the error rides along so the caller can rethrow it when NOTHING was reviewed.
// A TransientError is neither: failover owns it, and the chain lets it propagate.
const CURTAILMENT_CAUSES = ['budget', 'failure'];
// The one prose rendering of each cause, shared by the sweep line and the pass log.
const CURTAILMENT_BY = { budget: 'the time budget', failure: 'a worker failure' };
const FULL_COVERAGE = Object.freeze({ unreviewed: [], scopeFailures: [], sweeps: [], budgetExhausted: false });

// [LAW:one-source-of-truth] The memory one engine lane reserves. Every lane is a full engine CLI
// process (claude-code, codex, opencode) holding its own context — observed in the low hundreds of MB
// each; 512 MiB leaves headroom for the tree it spawns. This is a CAPACITY guardrail, never a review
// setting: the lane count is derived from the plan (one lane per scope) and this constant only caps
// the pathology of a plan wider than the machine — a 7 GiB hosted runner holds 14 lanes, which no
// PR-mode plan approaches, while a repo audit's dozens of scopes queue rather than fork-bomb the box.
// Quality is identical at any lane count; only wall clock moves. Change it with a measurement of a
// lane's footprint, not a wish for more parallelism. (zai-timing-ptp)
const LANE_MEMORY_BYTES = 512 * 1024 * 1024;

// [LAW:effects-at-boundaries] Pure: how many lanes a machine with this much memory holds. At least
// one — a machine too small for one lane still runs the review, one scope at a time.
// [LAW:parse-dont-validate] the one checkpoint for the host figure: os.totalmem is a positive number
// by contract, so anything else here is a caller that lost the value, refused loudly.
function laneCeilingFromMemory(totalMemBytes) {
  if (!Number.isFinite(totalMemBytes) || totalMemBytes <= 0) {
    throw new Error(`laneCeilingFromMemory: total memory must be a positive number of bytes (got ${JSON.stringify(totalMemBytes)})`);
  }
  return Math.max(1, Math.floor(totalMemBytes / LANE_MEMORY_BYTES));
}

// [LAW:no-shared-mutable-globals] The pass's findings accumulator. N concurrent chains read it (a
// sweep's priorFindings is whatever is recorded the instant it starts) and write it (each completed
// pass merges in), so it has ONE owner with a two-verb API rather than a `let` every lane reassigns.
// merge returns how many findings the merge ADDED — the convergence signal — decided by
// dedupeFindings, the one sameness key (src/review.js). [LAW:no-ambient-temporal-coupling] the
// read-merge-assign inside merge has no await, so two chains settling back to back each see the
// other's additions and neither's are lost; that atomicity is Node's single thread, relied on here
// once, by name.
function findingsLedger() {
  let findings = [];
  return {
    get findings() { return findings; },
    merge(more) {
      const merged = dedupeFindings([...findings, ...more]);
      const added = merged.length - findings.length;
      findings = merged;
      return added;
    },
  };
}

// [LAW:effects-at-boundaries] Pure: fold every chain's sweep records into one record per DEPTH — the
// per-sweep lines the summary prints and the budget verdict reads. Index i is sweep i+1. A chain that
// stopped earlier contributes nothing at deeper indexes; a depth's `curtailed` is the DISTINCT list of
// causes (CURTAILMENT_CAUSES order) that cut any chain's sweep at that depth — [] when none was — and
// its `added` is what the chains that ran it added between them. The result is as deep as the deepest
// chain, so a review with no sweeps folds to [] — the value composeSummary renders as nothing.
// [LAW:dataflow-not-control-flow]
function sweepsByDepth(chains) {
  const depth = Math.max(0, ...chains.map(c => c.length));
  return Array.from({ length: depth }, (_, i) => {
    const at = chains.filter(c => i < c.length).map(c => c[i]);
    const causes = new Set(at.filter(s => s.curtailed).map(s => s.curtailed.cause));
    return { added: at.reduce((sum, s) => sum + s.added, 0), curtailed: CURTAILMENT_CAUSES.filter(c => causes.has(c)) };
  });
}

// [LAW:effects-at-boundaries] Pure: the pass's COVERAGE record, folded ONCE from the chains' outcomes
// — the one derivation the summary renders from and the return value carries, so the posted prose and
// the sink's data cannot disagree about which scope went unreviewed or why. [LAW:one-source-of-truth]
//   unreviewed    — [{ name, cause }] for every scope whose pass 0 did not complete (the coverage gap);
//   scopeFailures — [{ scope, pass, message }] for every pass at any depth a worker died on, the
//                   message stamped single-line here (firstLine) so the line-structured summary and
//                   the operator warning can carry it as-is;
//   sweeps        — sweepsByDepth over the chains' sweep passes;
//   budgetExhausted — the budget bit at any depth: a scope it refused, or a sweep it cut.
function coverageOf(scopes, outcomes) {
  const unreviewed = scopes.flatMap((s, i) => {
    const c = outcomes[i].passes[0].curtailed;
    return c ? [{ name: s.name, cause: c.cause }] : [];
  });
  const scopeFailures = scopes.flatMap((s, i) => outcomes[i].passes.flatMap((p, pass) =>
    (p.curtailed && p.curtailed.cause === 'failure' ? [{ scope: s.name, pass, message: firstLine(p.curtailed.error.message) }] : [])));
  const sweeps = sweepsByDepth(outcomes.map(o => o.passes.slice(1)));
  const budgetExhausted = unreviewed.some(u => u.cause === 'budget') || sweeps.some(s => s.curtailed.includes('budget'));
  return { unreviewed, scopeFailures, sweeps, budgetExhausted };
}

// [LAW:dataflow-not-control-flow] A fixed-width pool of lanes that is FAIL-LOUD: the first error
// stops new work and is rethrown after in-flight lanes settle, preserving its type (a TransientError
// stays a TransientError so failover can classify it). [LAW:no-silent-failure] this is the deliberate
// inverse of swallowing a failed scope into an empty-finding result — an unreviewed scope must never
// pass as a clean one. The pool knows nothing of budgets: what runOne returns is the scope's outcome,
// in scope order regardless of settle order, and the budget's planned degradation is a VALUE inside
// it (runScopeChain), never an error this pool has to recognise. [LAW:single-enforcer] the chain
// absorbs the deadline; the pool schedules; the spawn seam meters.
async function runScopeWorkers({ scopes, runOne, laneCount }) {
  const outcomes = new Array(scopes.length);
  let next = 0;
  let firstError = null;
  async function lane() {
    while (next < scopes.length && !firstError) {
      const i = next++;
      try {
        outcomes[i] = await runOne(scopes[i]);
      } catch (e) {
        firstError = firstError || e;
      }
    }
  }
  await Promise.all(Array.from({ length: laneCount }, lane));
  if (firstError) throw firstError;
  return outcomes;
}

// One scope's whole convergence chain, in one lane: pass 0 (the judgment of record, seeded with
// nothing), then up to sweepCap sweeps of the same scope, each seeded with every finding the pass has
// recorded so far — its own and its siblings' — stopping the moment a sweep adds nothing.
// [LAW:composability] It returns one OUTCOME per scope:
//   { passes: [{ added, curtailed }], assessments }
// where passes[0] is the review of record and passes[k] is sweep k. `curtailed` is false for a pass
// that ran, or the cause that stopped it — { cause: 'budget' } or { cause: 'failure', error } (see
// CURTAILMENT_CAUSES) — one fact at every depth: at pass 0 it is the coverage gap the summary and the
// verdict carry (the scope was not reviewed); at a sweep it merely ends the chain (pass 0's judgment
// stands). The list is exactly the passes that RAN plus at most one curtailed entry, so a caller reads
// the chain's depth off its length. [LAW:types-are-the-program]
//
// [LAW:single-enforcer] A pass's fate is decided in exactly ONE place — attemptPass — identically
// before and around every pass: the budget refuses a pass before spawning when nothing remains, and a
// spawn the deadline kills mid-flight settles the same way (DeadlineExceededError); a worker that
// dies on any error failover does not own (a context-window overflow, a crashed CLI — anything but a
// TransientError) settles as a failure. Both are absorbed HERE so sibling chains' earned results are
// never discarded by a fail-loud rethrow (zai-engine-ydc: one overflowing worker used to void every
// other scope's findings), and what a curtailment means is decided by the pass index it lands on —
// a value, not a branch. A TransientError alone propagates: the retry seam already spent its in-place
// attempts on it, and config-level failover is the owner of what happens next. [LAW:dataflow-not-control-flow]
// The killed spawn's burned time is not this chain's concern: the spawn seam recorded it (err.span)
// before the error got here.
async function runScopeChain({ scope, context, material, spawn, log, ledger, sweepCap, readFilesFor, contextWindow, deadline, now, runningTotal }) {
  // Pass 0 is seeded with NOTHING — its prompt stays byte-identical to the pre-sweep engine even when
  // a sibling chain has already recorded findings, because a scope that waited for a lane must not
  // be told its material "was already examined" (the sweep block's premise). A sweep is seeded with
  // the ledger as it stands the instant it starts. The pass index is the domain's own discriminator
  // (review of record vs sweep), so this is the one branch the chain has. [LAW:dataflow-not-control-flow]
  const seedFor = (pass) => (pass === 0 ? [] : ledger.findings);
  // attemptPass settles to one of two shapes: { result } (the worker's records) or { curtailed }
  // (why it did not run to completion). [LAW:types-are-the-program]
  const attemptPass = async (pass) => {
    if (remainingMs(deadline, now()) <= 0) return { curtailed: { cause: 'budget' } };
    try {
      return { result: await runScopeWorker({ scope, context, material, spawn, log, readFilesFor, contextWindow, priorFindings: seedFor(pass), pass }) };
    } catch (e) {
      if (e instanceof DeadlineExceededError) return { curtailed: { cause: 'budget' } };
      if (e instanceof TransientError) throw e;
      return { curtailed: { cause: 'failure', error: e } };
    }
  };
  const passes = [];
  const assessments = [];
  for (let pass = 0; pass <= sweepCap; pass++) {
    const attempt = await attemptPass(pass);
    if (attempt.curtailed) {
      log(`${sweepLabelPrefix(pass)}scope '${scope.name}' not reviewed — ${curtailmentLogText(attempt.curtailed)}`);
      passes.push({ added: 0, curtailed: attempt.curtailed });
      break;
    }
    const { result } = attempt;
    assessments.push(...result.assessments);
    const added = ledger.merge(result.findings);
    passes.push({ added, curtailed: false });
    if (pass > 0) log(`sweep ${pass} scope '${scope.name}': ${added} new finding(s)`);
    if (added === 0) break;
  }
  // The closing line names the passes as they happened — 'review, sweep 1', or 'review curtailed' for
  // a scope the budget refused before it was ever reviewed — read straight off the passes value, so
  // the log never says a never-reviewed scope "finished after 0 pass(es)" a line after saying it was
  // not reviewed. [LAW:dataflow-not-control-flow]
  const chain = passes.map((p, i) => `${passLabel(i)}${p.curtailed ? CHAIN_LABEL_BY[p.curtailed.cause] : ''}`).join(', ');
  log(`scope '${scope.name}' chain: ${chain} — ${runningTotal()}`);
  return { passes, assessments };
}

// [LAW:one-source-of-truth] The two log renderings of a curtailment, keyed by cause: the pass line's
// reason and the chain line's suffix ('review curtailed' is the budget's established wording).
const CHAIN_LABEL_BY = { budget: ' curtailed', failure: ' failed' };
function curtailmentLogText(curtailed) {
  return curtailed.cause === 'budget' ? 'time budget exhausted' : `worker failed: ${firstLine(curtailed.error.message)}`;
}

// One scope worker: a single review spawn on this config, focused on one scope. [LAW:composability]
// It does one thing — review one scope — and returns its raw findings + summary + usage as a value.
// `spawn` is the transient-retry-wrapped engine spawn (see runMultiScopePass), so a blip retries THIS
// worker in place rather than failing the whole pass. [LAW:decomposition]
// priorFindings and pass are the convergence-sweep values (zai-recall-upr.2): the initial pass runs
// with [] and 0 (byte-identical prompt and logs), a sweep with the cumulative found list and its
// pass index — one worker, varied by values, never a sweep mode. [LAW:one-type-per-behavior]
// [LAW:one-source-of-truth] `pass` is the index as DATA (0 = the review of record, 1..N = sweeps);
// the human-facing 'sweep N ' label derives from it via sweepLabelPrefix, and the schedule record
// carries the number — one value, both representations derived.
// contextWindow is the engine's declared window (adapter.contextWindow: tokens, or null), handed to the
// material so the worker's prompt is FIT to it (buildReviewInput → fitWorkerMaterial) — a value from the
// adapter, threaded, never re-read from the registry here. [LAW:one-source-of-truth]
async function runScopeWorker({ scope, context, material, spawn, log, readFilesFor, contextWindow, priorFindings = [], pass = 0 }) {
  const focusText = workerFocusText(scope, context);
  // [LAW:decomposition] What the worker opens IN FULL is the effort profile's read-set arm applied to this
  // scope's assignment (readFilesFor, resolved once at the pass boundary): under the shipped 'assigned' arm
  // that IS scope.files, so N workers split the read; under 'changed' it is the empty list, which is the
  // material's own value for "read every changed file" — the pre-split behavior 2mg.2 prices against.
  // [LAW:one-source-of-truth] The pair keeps the two facts apart: `read` is that projection; `assigned` is
  // `scope.files` unprojected — the COVERAGE record the plan carries,
  // and what picks the single worker owning a bumped go.mod. Collapsed back into one list, 'changed' would
  // zero the ownership too and silently drop every dependency assessment. Repo material ignores it (no diff).
  const buildPromptFor = (toolNames) =>
    material.buildWorkerPrompt(focusText, toolNames, { assigned: scope.files, read: readFilesFor(scope.files), window: contextWindow }, priorFindings);
  const label = `${sweepLabelPrefix(pass)}scope '${scope.name}'`;
  log(`${label} starting…`);
  // [LAW:dataflow-not-control-flow] Every record kind the spawn produced flows through this seam
  // unbroken — findings AND dependency assessments (the go.mod-owning worker's per-module judgments).
  // Dropping assessments here would silently strip the whole feature: the aggregation's `|| []` fallback
  // would fire on every worker and every bump would render "unassessed". [LAW:no-silent-failure]
  const { summary, findings, assessments, usage } = await spawn(buildPromptFor, label, { phase: 'worker', scope: scope.name, pass });
  // [LAW:one-source-of-truth] The elapsed time is the SAME host-stamped span the schedule records
  // for this spawn, formatted through the same spanMs/formatMs derivation the posted breakdown
  // uses — the live line and the footer cannot disagree. A null usage (an adapter that reported
  // nothing) renders 'unclocked', the recorded absence, never a fabricated figure (zai-timing-31d.7).
  log(`${label} done — ${findings.length} finding(s) — ${formatMs(spanMs(usage?.span))}`);
  return { name: scope.name, summary, findings, assessments, usage };
}

// [LAW:one-source-of-truth] The one derivation of a pass index's log-label prefix, shared by the
// worker's spawn label and the chain's skip lines: pass 0 (the review of record) is unprefixed,
// so its logs stay byte-identical to the pre-sweep engine.
function sweepLabelPrefix(pass) {
  return pass === 0 ? '' : `sweep ${pass} `;
}

// [LAW:parse-dont-validate] A scope's name is its IDENTIFIER downstream — log lines, sweep labels,
// and the time budget's coverage bookkeeping (unreviewedScopes vs reviewed) all key on it — but the
// repo scout's contract only promises non-empty, not unique (the partition names scopes by directory,
// unique by construction). Stamp uniqueness once here at the plan boundary, so every name-keyed
// consumer inland is sound by construction: a repeated name gets a deterministic ' (2)', ' (3)'
// suffix; the suffixed name is itself checked against the used set, so a scout that literally
// planned 'x' and 'x (2)' still comes out collision-free.
function uniquelyNamed(scopes) {
  const used = new Set();
  let renamed = false;
  const out = scopes.map(s => {
    let name = s.name;
    for (let n = 2; used.has(name); n++) name = `${s.name} (${n})`;
    used.add(name);
    if (name === s.name) return s;
    renamed = true;
    return { ...s, name };
  });
  // The collision-free case returns the INPUT array itself — the common path is a provable no-op,
  // not a fresh copy that merely looks like one.
  return renamed ? out : scopes;
}

// [LAW:one-type-per-behavior] The PRODUCERS of a pass's proposal — the partition its workers run, as a
// value. Every producer hands back the identical shape:
//   { provenance, scopes, context, scoutUsage }
// which is PLAN_FIELDS as the pass records them. A material owns its own producer (`material.proposal`):
// PR material computes the partition from the changed paths (partitionProposal — pure, no spawn), repo
// material buys one from a scout spawn (scoutProposal — there is no diff to compute one from). A pinned
// plan (pinnedProposal) replaces either. Nothing after the choice can tell which ran, which is the whole
// point: a pinned replay is not a second engine, and neither is a computed partition.
//
// Each producer owns its own progress lines, so the shared path below carries no logging branch.
// [LAW:dataflow-not-control-flow]

// [LAW:one-source-of-truth] The PR producer: the structure is a pure function of the changed paths
// (src/partition.js), so five replays of one diff run five identical partitions — the property the LLM
// scout could not offer (1 to 5 scopes per replay on a frozen case, copirate-determinism-5od). No spawn
// is bought, so scoutUsage is null by the plan's own table. [LAW:effects-at-boundaries] Pure but for the
// one progress line, exactly as pinnedProposal is.
function partitionProposal({ changedPaths, log }) {
  const { scopes, context } = partitionByDirectory(changedPaths);
  log(`partitioned ${changedPaths.length} changed file(s) into ${scopes.length} scope(s): ${scopes.map(s => s.name).join(', ')}`);
  return { provenance: 'partition', scopes, context, scoutUsage: null };
}

// The repo-mode scout: a survey-only spawn. Its product is the typed scope records it logged through the
// add_scope collector tool (validated at the collector boundary), plus a structural summary that becomes
// shared worker context. Its findings, if any, are ignored by design. [LAW:no-silent-failure] a scout that
// planned zero scopes fails loud here rather than running zero workers and "succeeding" having reviewed
// nothing — a hole a pinned plan cannot have, since planRecord already refuses the empty partition.
async function scoutProposal({ buildScoutPrompt, spawn, log }) {
  const scoutResult = await spawn(buildScoutPrompt, 'scout', { phase: 'scout' });
  // The scout's elapsed time lands the moment it settles — BEFORE the zero-scope gate, so a run
  // that dies planning still logged where its first two minutes went (zai-timing-31d.7). Same
  // span-in-hand derivation as the worker done line. [LAW:one-source-of-truth]
  log(`scout done — ${formatMs(spanMs(scoutResult.usage?.span))}`);
  if (scoutResult.scopes.length === 0) {
    throw new Error(`Scout planned no scopes (no add_scope calls). Scout summary:\n${scoutResult.summary}`);
  }
  log(`scout planned ${scoutResult.scopes.length} scope(s): ${scoutResult.scopes.map(s => s.name).join(', ')}`);
  return {
    provenance: 'scout',
    scopes: scoutResult.scopes,
    context: scoutResult.summary.trim(),
    // The price of deciding. A null is the engine reporting no usage — the recorded absence spanMs
    // already spells 'unclocked' — never a fabricated zero. [LAW:no-silent-failure]
    scoutUsage: scoutResult.usage ?? null,
  };
}

// [LAW:parse-dont-validate] The pinned producer, and THE checkpoint a frozen plan crosses: in goes a
// PlanRecord that merely parsed (its shape is proven, its relationship to this diff is not), out comes a
// proposal proven to partition THIS change — the type no plan has until this function has run, and the
// type every line downstream consumes. The check cannot be skipped, because skipping it means having no
// proposal to hand the workers.
//
// [LAW:no-silent-failure] A partition is a cover with no overlap, and the refusal checks BOTH halves —
// exact set equality against the changed paths in both directions, and no path claimed twice — before
// the first worker at zero model spend. None of the three may be waved through. A plan omitting a
// changed file would leave that file read in full by no worker while its plan.json claimed a
// partition of the whole change, so the pinned replay would be a different review wearing the plan's
// name. A plan naming a file this diff does not contain is the same error read from the other side:
// the plan belongs to some other change (a re-frozen case, a different EXCLUDE_PATTERNS), and the
// paths it names would reach a worker's "read these files in full" line pointing at nothing. A plan
// claiming one file in two scopes (a hand edit, or a scout's plan whose duplicate the deleted
// reconciliation once warned about) would have two workers read and review the same code, doubling
// its cost while the run scored as a valid sample. All three mean the frozen structure is not this
// change's structure, and the whole reason to pin is that the structure is the same.
//
// Provenance is stamped 'pinned' HERE regardless of what the file says, because provenance records which
// producer RAN, not which one wrote the bytes. The ordinary input is a plan.json recorded by a scouted
// run, which says 'scout' and carries that run's price; replaying it spawns no scout, so the record this
// pass emits must say so and must carry no price — which planRecord's table then makes unrepresentable
// to get wrong. [LAW:one-source-of-truth]
// [LAW:effects-at-boundaries] Pure but for the one progress line, exactly as its sibling is.
function pinnedProposal({ plan, changedPaths, log }) {
  const claimed = plan.scopes.flatMap(s => s.files);
  const assigned = new Set(claimed);
  const changed = new Set(changedPaths);
  const omitted = changedPaths.filter(p => !assigned.has(p));
  const foreign = [...assigned].filter(p => !changed.has(p));
  const duplicated = [...assigned].filter(p => claimed.indexOf(p) !== claimed.lastIndexOf(p));
  if (omitted.length + foreign.length + duplicated.length > 0) {
    throw new Error(
      'Pinned plan does not partition this change — refusing before any spawn. ' +
      `Changed file(s) no scope claims (${omitted.length}): ${excludedPathList(omitted)}. ` +
      `File(s) the plan names that this change does not contain (${foreign.length}): ${excludedPathList(foreign)}. ` +
      `File(s) claimed by more than one scope (${duplicated.length}): ${excludedPathList(duplicated)}. ` +
      'A plan that covers less than the change reviews less than the change and reports success; ' +
      'pin a plan recorded from THIS case, or drop --plan and let the partition compute it.',
    );
  }
  log(`pinned plan: ${plan.scopes.length} scope(s): ${plan.scopes.map(s => s.name).join(', ')}`);
  return { provenance: 'pinned', scopes: plan.scopes, context: plan.context, scoutUsage: null };
}

// One full multi-scope pass for ONE config: scout → workers → aggregate. This is the produceOnce that
// failover.produceReview drives, so the whole pass is one attempt and retry/failover wraps it as a
// unit. Returns the same {summary, findings, usage} shape a single engine spawn used to return —
// plus `schedule`, the pass's recorded shape (zai-timing-31d.5) — so every downstream sink stays
// unchanged. [LAW:decomposition]
// `deadline` (epoch ms, null = no budget) and `now` (the injected clock, matching the sleepFn
// convention) are the wall-clock budget: the pass stops STARTING work — scope workers and sweeps —
// once the budget is spent, delivers everything already collected, and reports the coverage gap as
// data (unreviewedScopes, budgetExhausted). [LAW:no-ambient-temporal-coupling] the deadline is a
// value minted once at the run boundary, never a clock read scattered through callers.
// `startedAt` (epoch ms, null = unknown) is the run's start instant from that SAME mint — the live
// log's running totals count from it, so they agree with the footer's total by construction. A
// caller without one (null) logs 'elapsed unclocked' rather than minting a second start here:
// timing is diagnostics and never invents a clock. [LAW:one-source-of-truth]
async function runMultiScopePass({ config, material, registry, instructionsPath, laneCeiling, sweepCap, readSet, log, plan = null, sleepFn = sleep, deadline = null, now = Date.now, startedAt = null }) {
  // [LAW:parse-dont-validate] The read-set arm is resolved to its projection ONCE, here, before the scout
  // spawns: every worker below is handed the resolved projection, so an arm outside the vocabulary is
  // refused at zero spend rather than at the first worker's prompt. Same position and reason as the two
  // gates below — the difference is that this one hands back the proven value it checked.
  const readFilesFor = readSetProjection(readSet);
  // [LAW:no-silent-failure] A missing/malformed sweep bound must not decide anything by accident: an
  // undefined cap would make every chain's `pass <= sweepCap` false on pass 0 and the review would
  // "succeed" having run NO workers at all. The bound comes from the effort profile (its one
  // source); a caller that lost it is a bug that fails loud here.
  if (!Number.isInteger(sweepCap) || sweepCap < 0) {
    throw new Error(`runMultiScopePass requires a non-negative integer sweepCap (got ${JSON.stringify(sweepCap)}); it comes from the effort profile.`);
  }
  // [LAW:single-enforcer] Same checkpoint for the lane ceiling: the pool runs whatever width it is
  // handed, and the schedule records that width AS USED — a 0 or a fraction here would make the
  // recorded schedule disagree with what the pool actually did. One loud gate keeps record and
  // behavior one fact.
  if (!Number.isInteger(laneCeiling) || laneCeiling < 1) {
    throw new Error(`runMultiScopePass requires a positive integer laneCeiling (got ${JSON.stringify(laneCeiling)}); it comes from the machine's capacity (laneCeilingFromMemory).`);
  }
  const adapter = registry.get(config.engine);
  // [LAW:parse-dont-validate] The engine's context window crosses from the adapter into the engine HERE,
  // and this is its one checkpoint: null (undeclared) or a positive integer. An adapter that never
  // declared the field hands over `undefined`, which the material's default would launder into
  // "undeclared" and the fit into a NaN budget — either way a silent answer to a question nobody asked.
  // Refused at zero spend with the field named, like the two gates above. [LAW:no-silent-failure]
  const contextWindow = adapter.contextWindow;
  if (contextWindow !== null && !(Number.isInteger(contextWindow) && contextWindow > 0)) {
    throw new Error(`runMultiScopePass requires the engine adapter to declare contextWindow as null or a positive integer token count (got ${JSON.stringify(contextWindow)} from '${config.engine}').`);
  }

  // [LAW:decomposition] Every engine spawn in this pass goes through one transient-retry seam, so a
  // single flaky request (a dropped socket, a 5xx) is absorbed in place — the scout and each worker
  // recover independently and a blip never re-runs the whole pass. An exhausted or non-transient error
  // still propagates, so config-level failover (produceReview) is unchanged. [LAW:one-source-of-truth]
  //
  // [LAW:single-enforcer] The same seam is the pass's ONE metering point (zai-timing-31d.5): every
  // spawn ATTEMPT settles here, so every attempt leaves a tagged record — the successful spawn with
  // its full usage, a transiently-failed-then-retried attempt with the span it burned (err.span,
  // stamped by runEngine; the gap PR #134 deferred), and the settling failure (a deadline kill, an
  // exhausted retry) with its span before the error escapes to whoever absorbs it. The pass total
  // AND the schedule both derive from this one list, so no phase can appear in one and be forgotten
  // by the other. [LAW:one-source-of-truth] `tag` is the record's identity — { phase: 'scout' } or
  // { phase: 'worker', scope, pass } — a value, never re-parsed from the human-facing label. Every
  // record is minted through spawnRecord (src/schedule.js), the one owner of the record shape, so a
  // drifted tag or outcome fails loudly here rather than silently corrupting the derived breakdown.
  const spawnRecords = [];
  const spanOnlyUsage = (err) => (err.span ? { span: err.span } : null);
  const spawn = async (buildPromptFor, label, tag) => {
    try {
      const result = await retryTransientSpawn(
        () => adapter.produceReview({ config, buildPromptFor, instructionsPath, deadline }),
        {
          sleepFn,
          // The same deadline bounds the spawn AND its retry sleeps: an uncapped Retry-After near
          // the budget's edge must not sleep the run past its own deadline. [LAW:single-enforcer]
          // the clamp lives in retryTransientSpawn; this seam only threads the value.
          deadline,
          now,
          onRetry: ({ attempt, limit, delay, err }) => {
            // [LAW:no-silent-failure] A retried attempt burned real time; it appears as its own
            // record (span-only — a failed spawn reports no tokens) rather than vanishing into
            // the retry loop. err.span is absent when the failure predated the spawn: nothing ran.
            spawnRecords.push(spawnRecord(tag, 'retried', spanOnlyUsage(err)));
            log(`${label}: transient error (attempt ${attempt}/${limit}), retrying in ${Math.round(delay / 1000)}s: ${err.message}`);
          },
        },
      );
      spawnRecords.push(spawnRecord(tag, 'completed', result.usage));
      return result;
    } catch (err) {
      // The settling failure's burned time is recorded BEFORE the error escapes — a deadline-killed
      // worker is absorbed as 'unreviewed' by the pool downstream, but its record is already here.
      spawnRecords.push(spawnRecord(tag, 'failed', spanOnlyUsage(err)));
      throw err;
    }
  };

  // Layer 1 — the PROPOSAL: where this pass's partition comes from, as a value. `plan` is that value's
  // discriminator and its whole content — absent, the material produces the partition its mode calls for
  // (computed for a PR, scouted for a repo); present, the pass replays a partition somebody already
  // decided (copirate-determinism-5od.fku). There is deliberately no 'pinned mode' boolean: every producer
  // hands back the SAME proposal shape, and every line below this one is identical for all of them.
  // [LAW:dataflow-not-control-flow] The one thing that genuinely differs — whether an engine spawn is
  // bought at all — is precisely what choosing a producer means, and it happens here, once.
  const proposal = plan === null
    ? await material.proposal({ spawn, log })
    : pinnedProposal({ plan, changedPaths: material.changedPaths, log });

  // [LAW:types-are-the-program] Coverage is a property of the producers, not a check here: a computed
  // partition assigns every changed path exactly once by construction, a pinned plan was proven to
  // partition this change before it was accepted, and repo material has no changed set to cover. The
  // catch-all sweep, the duplicate warning, and the withheld-path strip that once reconciled an LLM
  // scout's PR plan are gone with the PR scout. Names are stamped unique once, here, because a repo
  // scout only promises non-empty ones.
  const scopes = uniquelyNamed(proposal.scopes);
  const context = proposal.context;

  // Layer 2 — the convergence chains (zai-recall-upr.2; one chain per scope since zai-timing-ptp).
  // Every scope runs its own chain in its own lane: pass 0 (the review of record), then up to sweepCap
  // sweeps of the same scope, each shown the findings recorded so far and hunting only for what is
  // missing, stopping the moment a sweep adds nothing. A scope waits on nothing but its own previous
  // pass — the only fact a sweep takes from its siblings is their findings, and it takes whatever is
  // recorded when it starts — so the pass's wall clock is its slowest chain, not the sum of its layers.
  // [LAW:one-type-per-behavior] a sweep is not a second kind of pass: it is the identical worker with a
  // non-empty priorFindings value, so pass 0's prompt is byte-identical to the pre-sweep engine.
  //
  // [LAW:one-source-of-truth] "Added nothing new" is decided by the SAME key that merges findings —
  // dedupeFindings, applied once at the ledger — never a second sameness definition: a chain converges
  // exactly when merging its latest pass leaves the deduped cumulative set unchanged. A verbatim
  // re-record therefore never counts as new; a paraphrase of a known issue can (the dedupe key's
  // documented noise direction), which is why every chain is BOUNDED by sweepCap rather than trusting
  // convergence alone. The predicate is uniform across passes: a pass-0 with zero findings converges
  // immediately (a clean change), since a sweep after it would re-run a byte-identical prompt — a
  // re-roll, not a hunt.
  // [LAW:one-source-of-truth] The live log's running total derives from the run's ONE mint
  // (startedAt and the deadline spent from it) plus the injected clock — never a second clock read
  // here. The budget's size is (deadline - startedAt) because both came from the same mint; either
  // absence propagates as the typed null renderRunningTotal knows the words for.
  const runningTotal = () => renderRunningTotal(
    startedAt == null ? null : now() - startedAt,
    startedAt == null || deadline == null ? null : deadline - startedAt,
  );
  // The lane count IS the plan's width — one lane per scope — under the one thing that can still make
  // a ready scope wait, the machine's capacity. Logged as both numbers so a footer or log reading
  // lanes below scopes names a capacity cap, never a setting. [LAW:no-silent-failure]
  const laneCount = Math.min(scopes.length, laneCeiling);
  log(`${scopes.length} scope(s) on ${laneCount} lane(s)`);
  const ledger = findingsLedger();
  const outcomes = await runScopeWorkers({
    scopes,
    laneCount,
    runOne: (scope) => runScopeChain({ scope, context, material, spawn, log, ledger, sweepCap, readFilesFor, contextWindow, deadline, now, runningTotal }),
  });
  log(`all scopes done — ${runningTotal()}`);
  // A scope whose pass 0 did not complete is a COVERAGE gap, carried as data to the summary and the
  // verdict; a curtailed sweep merely bounds convergence — pass 0's judgments of record stand.
  const coverage = coverageOf(scopes, outcomes);
  // [LAW:no-silent-failure] NO scope completed: there is no review to deliver, and "delivering" an
  // empty one would approve a change nobody looked at. Fail fast with the real cause — the first
  // worker's own error when one died, so an overflow or a crash is diagnosed as itself and never as
  // a budget the run did not spend; otherwise the budget, with the knob named.
  if (coverage.unreviewed.length === scopes.length) {
    const failed = scopes.map((s, i) => outcomes[i].passes[0].curtailed).find(c => c.cause === 'failure');
    if (failed) throw failed.error;
    throw new DeadlineExceededError(
      `The review's time budget expired before any scope completed — no review to deliver. ${BUDGET_REMEDY}`,
    );
  }
  const { sweeps, unreviewed, scopeFailures, budgetExhausted } = coverage;
  for (const [i, s] of sweeps.entries()) {
    const pass = i + 1;
    log(`convergence sweep ${pass}: ${s.added} new finding(s)${s.curtailed.length > 0 ? ` — cut short (${s.curtailed.map(c => SWEEP_LOG_BY[c]).join(', ')})` : s.added === 0 ? ' — converged' : pass === sweepCap ? ' — sweep cap reached' : ''}`);
  }

  return {
    summary: composeSummary(context, scopes, coverage),
    findings: ledger.findings,
    // [LAW:dataflow-not-control-flow] Dependency assessments aggregate exactly like findings — a flatMap
    // over the chains plus one dedup — and with the SAME shape: no `|| []` fallback, because every chain
    // carries an `assessments` array (every worker result does — readCollectedReview always returns one),
    // exactly as it carries its passes. [LAW:one-type-per-behavior] guarding only this record kind would
    // let an out-of-contract adapter that omits the field degrade the whole section to "unassessed"
    // silently; the bare access makes that surface as a loud crash instead. [LAW:no-silent-failure] Only
    // the go.mod-owning worker records any; dedupeAssessments (keyed by module) collapses the multi-go.mod
    // case — and the sweep-pass re-assessments, which collapse by the same module key. Non-dependency PR → [].
    assessments: dedupeAssessments(outcomes.flatMap(o => o.assessments)),
    // [LAW:one-source-of-truth] The pass total folds from the SAME record list the schedule reports,
    // so "what this pass consumed" has one owner: a spawn in the schedule is in the total, and a
    // spawn in the total is in the schedule — including retried attempts and deadline-killed scopes,
    // whose span-only records widen the envelope exactly as a reviewed spawn's does.
    usage: sumUsage(spawnRecords.map(r => r.usage)),
    // The pass's recorded shape (zai-timing-31d.5): the scheduling facts as actually used, plus one
    // record per spawn attempt. laneCount is the count the pool RAN — the plan's width under the
    // machine's ceiling — so the record cannot claim a parallelism the pass did not have.
    // [LAW:one-source-of-truth]
    schedule: scheduleRecord({
      plan: proposal.provenance,
      laneCount,
      sweepCap,
      scopeCount: scopes.length,
      spawns: spawnRecords,
    }),
    // The pass's PLAN as a value (copirate-determinism-5od.ea7): the partition these workers actually
    // ran, minted through src/plan.js. `scopes` is the uniquely-named list — the very array
    // runScopeWorkers iterated and each worker was handed as its assignment — so the record and the
    // behavior are ONE value, not a copy that could describe a partition the run did not use.
    // [LAW:one-source-of-truth]
    //
    // `provenance` and `scoutUsage` come from the PRODUCER that ran, so the record states which one it
    // was and what deciding cost — a scouted pass's settled spawn price, or the null a pinned pass has
    // because it bought nothing. The ATTEMPT-level authority stays the schedule's spawn list above (it
    // alone carries the retried and failed attempts); this field is the completed spawn's usage, taken
    // from the same in-memory value rather than re-derived from that list. [LAW:no-silent-failure]
    plan: planRecord({
      provenance: proposal.provenance,
      context,
      scopes,
      scoutUsage: proposal.scoutUsage,
    }),
    // [LAW:one-source-of-truth] The coverage gap as DATA, for the sinks: the PR sink withholds
    // approval when unreviewedScopes is non-empty (transport.submitReview) — the NAMES, whatever took
    // them, since a scope a worker died on is exactly as unreviewed as one the budget refused — and
    // run.js warns when the budget bit (budgetExhausted) and when a worker failed (scopeFailures,
    // every failed pass at any depth with its message). The summary text above derives from these
    // same values, never the other way around. All three are their defaults ([]/false/[]) on every
    // run nothing went wrong in.
    unreviewedScopes: unreviewed.map(u => u.name),
    budgetExhausted,
    scopeFailures,
  };
}

// The sweep log's cause wording, keyed like CURTAILMENT_BY. [LAW:one-source-of-truth]
const SWEEP_LOG_BY = { budget: 'time budget', failure: 'worker failure' };

// The engine seam both modes call. Wraps the multi-scope pass in failover.produceReview so the whole
// pass retries/advances per config. produceReview supplies (config, buildPromptFor, anchors); the
// multi-scope pass builds its own prompts per spawn from `material`, so the latter two are unused
// here — passed null, exactly as repo mode already passes null anchors. [LAW:composability]
// log is the injected progress effect (core.info in the action, a stderr writer in the dev script).
// [LAW:single-enforcer] The effort profile is the ONE source of the review's sweep bound, read-set arm
// AND reasoning raise, and this is the ONE seam where the chain and the profile meet — so all three
// projections happen here: sweepCap onto the pass's plain number, readSet onto the pass's arm (which the
// pass resolves to a projection before spawning anything), and reasoningTier folded onto each config's own
// reasoning as a FLOOR (maxTier). Folding into the chain — rather than threading the tier down to each
// adapter — means the effective config flows through produceReview unchanged, so the engine clamps it
// per its range (resolveReasoningTier) and `configUsed` (hence the attribution footer) automatically
// reports the raised tier. [LAW:dataflow-not-control-flow] a null proposed tier folds to each config's
// own reasoning (byte-identical), so an omitted/default `effort` leaves the chain untouched.
// [LAW:effects-at-boundaries] `laneCeiling` is the one machine fact the pass needs, and the host read
// that produces it (os.totalmem) sits HERE, at the seam's default, never inside the pass: the pass
// takes a number, so a test hands it one and the production callers hand it nothing. It is not on the
// effort profile because it is not effort — see LANE_MEMORY_BYTES.
function runMultiScope({ chain, material, registry, instructionsPath, effort = defaultEffortProfile(), laneCeiling = laneCeilingFromMemory(os.totalmem()), log = () => {}, plan = null, sleepFn = sleep, deadline = null, now = Date.now, startedAt = null }) {
  const sweepCap = effort.sweepCap;
  const readSet = effort.readSet;
  const effectiveChain = chain.map(config => ({
    ...config,
    reasoning: maxTier(config.reasoning ?? null, effort.reasoningTier ?? null),
  }));
  // [LAW:dataflow-not-control-flow] The pinned plan threads through as a plain value with a null
  // default: every caller that does not pin one (run.js, scripts/local-review.js) passes nothing and
  // gets the scouted path byte-identically, and no seam between here and the producer knows there are
  // two of them. It is NOT on the effort profile — a plan is not a dial an arm turns, it is the
  // structure an arm is held constant against (copirate-determinism-5od.w2r).
  const produceOnce = (config) => runMultiScopePass({ config, material, registry, instructionsPath, laneCeiling, sweepCap, readSet, log, plan, sleepFn, deadline, now, startedAt });
  // [LAW:no-ambient-temporal-coupling] ONE sleepFn and ONE clock own the whole pass's retry timing:
  // both are forwarded to produceReview, so the pass-level gates, the spawn-level retry clamp, and
  // config-level failover all measure the budget on the same injected `now` — a fake clock in a test
  // can never leave failover spending wall time the rest of the pass isn't. Defaults keep
  // production unchanged.
  // [LAW:single-enforcer] The wall-clock budget also bounds failover's retry horizon: produceReview
  // already clamps every backoff sleep to its budget, so handing it the time remaining makes retry
  // timing deadline-respecting with no second clamp — a Retry-After longer than the budget can no
  // longer sleep the run past its own deadline. min() with the default keeps the no-deadline path
  // byte-identical (remainingMs is Infinity there).
  const budgetMs = Math.min(TRANSIENT_RETRY_BUDGET_MS, remainingMs(deadline, now()));
  return produceReview(effectiveChain, null, null, produceOnce, sleepFn, budgetMs, now);
}

// [LAW:decomposition] The two MATERIALS, built once each. A material knows how to build the scout
// prompt and a worker prompt from the inputs its mode already has; the engine above is material-blind.

// PR material: the scout is handed the changed file paths; each worker sees the WHOLE annotated diff
// (so every anchor stays valid) with its scope as the CONCENTRATE focus, but reads only its scope's
// assigned files in full. files/maxDiffChars are the same values run.js uses to build the anchors, so
// worker findings and anchors share one diff.
// dependencySummaries is the (possibly empty) structured upstream-change context src/dependency-diff.js
// fetched for any go.mod bump in this PR — the ONE source both the worker prompt (this material) and the
// posted-review section (run.js) render from. [LAW:one-source-of-truth] The material derives the prompt
// NOTE from it here (renderDependencyDiffNote) and threads the RESOLVED bumps to the worker so the assess
// directive can name the exact modules. [] is the common case (no bump, or the feature is off): the note
// is '' and the bump list empty, flowing through unchanged. [LAW:dataflow-not-control-flow]
// priorPushbacks is the (possibly empty) set of this PR's earlier findings the author replied to
// (fetchPriorPushbacks, src/transport.js). Every worker receives all of them — like the whole diff, which
// each worker also sees — so a rebuttal about any file informs whichever worker owns it, and the scout
// need not partition them. [] (a first round, or no replies) flows through unchanged. [LAW:dataflow-not-control-flow]
// excluded is filterFiles' record of what EXCLUDE_PATTERNS took OUT of `files` ({patterns, paths}) — the
// one fact neither the scout nor a worker can recover from the material it is handed, since both are
// handed only what survived the filter. It reaches BOTH prompts because both reason about completeness:
// the scout plans coverage of the changed set, a worker judges it. NO_EXCLUSIONS (an unfiltered run,
// e.g. scripts/local-review.js) renders nothing in either. [LAW:dataflow-not-control-flow]
// [LAW:parse-dont-validate] `files` must carry the content measurement measureChangedFiles (src/window.js)
// stamps — the worker prompt's window fit sizes every full read by it — and THIS is the checkpoint: the
// material boundary, before any lane spawns, so an unmeasured changed set is refused at zero spend with
// the seam named, never discovered inside a worker as a TypeError absorbed into "scope failed".
function buildPrMaterial({ files, maxDiffChars, reviewedRepoRoot, dependencySummaries = [], priorPushbacks = [], excluded = NO_EXCLUSIONS }) {
  const unmeasured = files.find(f => !f.content || !Number.isInteger(f.content.tokens) || !Number.isInteger(f.content.lines));
  if (unmeasured) {
    throw new Error(`buildPrMaterial: changed file '${unmeasured.filename}' carries no content measurement; the changed set must pass through measureChangedFiles (src/window.js) before it becomes review material.`);
  }
  const changedPaths = files.map(f => f.filename);
  const dependencyDiffNote = renderDependencyDiffNote(dependencySummaries);
  // Only a resolved bump has upstream context to judge; an unresolved one renders as a plain line in the
  // sink and carries no model assessment, so it is excluded from the assess directive. [LAW:no-silent-failure]
  const dependencyBumps = dependencySummaries.filter(s => s.resolved);
  return {
    // [LAW:types-are-the-program] The changed-file list is a first-class field of the material, not
    // recovered from the prompt: it is the partition's input and the pinned producer's proof set.
    changedPaths,
    // [LAW:one-source-of-truth] The PR partition is COMPUTED from the changed paths (src/partition.js):
    // no scout spawn, no re-roll, and — because `files` are the post-EXCLUDE_PATTERNS survivors — no
    // withheld path can ever be assigned, so nothing downstream strips one. [LAW:effects-at-boundaries]
    proposal: ({ log }) => partitionProposal({ changedPaths, log }),
    // priorFindings is the convergence-sweep value threaded per pass by runScopeWorker: [] on the
    // initial pass (byte-identical prompt), the cumulative found list on a sweep. [LAW:dataflow-not-control-flow]
    // [LAW:dataflow-not-control-flow] The assignment, the read set and the window arrive as one record and
    // land on the parameters that own them; the lists default to empty and the window to null (undeclared:
    // nothing withheld, every read full) — the broad single-scope call, values not modes.
    buildWorkerPrompt: (focusText, toolNames, { assigned = [], read = [], window = null } = {}, priorFindings) => buildReviewInput({ files, maxDiffChars, toolNames, reviewedRepoRoot, focus: focusText, scopeFiles: assigned, readFiles: read, window, dependencyDiffNote, dependencyBumps, priorPushbacks, priorFindings, excluded }).prompt,
  };
}

// Repo material: no diff. The scout surveys the tree; each worker reviews one scope, where the scope
// focus IS the repo-review `scope` value — so a worker is exactly a focused whole-repo review.
function buildRepoMaterial({ scope, excludePatterns, reviewedRepoRoot }) {
  return {
    // Repo mode has no changed-file list: an empty value, never a mode — the pinned producer's proof
    // set and nothing else reads it. [LAW:dataflow-not-control-flow]
    changedPaths: [],
    // Repo mode has no diff to compute a partition from, so it BUYS one: the scout surveys the tree.
    // Its exclusion patterns are a bound on that exploration, carried in the scout prompt.
    proposal: ({ spawn, log }) => scoutProposal({
      buildScoutPrompt: (toolNames) => buildRepoScoutInput({ scope, excludePatterns, toolNames, reviewedRepoRoot }).prompt,
      spawn,
      log,
    }),
    // Repo mode has no diff to partition, so a repo worker reviews its scope broadly by exploring the
    // tree; the assigned/read pair the PR worker uses is deliberately ignored here, while the convergence
    // sweep's priorFindings flows through exactly as in PR material. [LAW:dataflow-not-control-flow]
    buildWorkerPrompt: (focusText, toolNames, _assignedRead, priorFindings) => buildRepoReviewInput({ scope: focusText, excludePatterns, toolNames, reviewedRepoRoot, priorFindings }).prompt,
  };
}

module.exports = {
  workerFocusText,
  sumUsage,
  composeSummary,
  LANE_MEMORY_BYTES,
  laneCeilingFromMemory,
  findingsLedger,
  sweepsByDepth,
  coverageOf,
  CURTAILMENT_CAUSES,
  scoutProposal,
  partitionProposal,
  runScopeWorkers,
  runScopeChain,
  runMultiScopePass,
  runMultiScope,
  buildPrMaterial,
  buildRepoMaterial,
};
