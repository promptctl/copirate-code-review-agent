# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A GitHub Action that runs an AI coding agent as a code reviewer. The engine is chosen by the `PROVIDER` input in `src/provider.js`, which defaults to `auto` — the action's own choice, today Claude Code against DeepSeek's Anthropic-compatible endpoint. It can also run the Codex engine against OpenAI (`PROVIDER: codex`) or Claude Code against Z.ai (`PROVIDER: zai`). Whichever engine runs, it records required changes through a private MCP "collector" tool.

**Two review modes, selected by the `MODE` input (`src/run.js`).** `MODE` is the explicit discriminator between two *materials* and two *sinks*:
- **`pr`** (default) — review a pull request diff and submit an inline `REQUEST_CHANGES`/`APPROVE` GitHub review (`runPrReview`).
- **`repo`** — an on-demand whole-repo review (typically `workflow_dispatch`) with an optional free-text `SCOPE` injected into the prompt; the engine explores the working tree with Read/Grep/Glob (no diff, no anchors), and findings are printed as a Markdown report to the GitHub Step Summary + run log — no PR, no host review, no GitHub write token (`runRepoReview`). Pre-existing issues are in scope here, the inverse of PR mode.

The two modes share the entire **ENGINE**: `collectReviewOnce` (one engine attempt → validated review + usage), `buildConfigChain`, `produceReview` (retry/failover), and the cost machinery. They differ only in the *material* prompt (`buildReviewInput` vs `buildRepoReviewInput` in `src/prompt.js`) and the *sink* (`submitReview` in `src/transport.js` vs `renderRepoReport` in `src/report.js`). The PR-diff anchor machinery (`patchLines`/`buildReviewAnchors`/`partitionFindings`) is a `pr`-mode-only concern; in `repo` mode any `file:line` the agent cites is valid.

In simple mode (no `CONFIG_FILE`), `src/provider.js` is the single seam that turns the `PROVIDER` value plus its provider-specific inputs (`OPENAI_*` / `ZAI_*`) into a typed `ReviewConfig`. A committed `.github/review-agents.yml` config file is the advanced path: when it exists it owns engine selection (incl. per-PR selection and failover chains) and the simple-mode inputs are ignored.

**Fork PRs are never reviewed.** `runPrReview` fetches the PR once up front and gates on `prIsFromFork` (`src/transport.js`: head repo id ≠ base repo id, or a deleted/absent head repo) — a fork PR is skipped cleanly (logged, exit 0, no engine spawned) before any credential is read. This is unconditional with no opt-in input, so an outside contributor's PR can never spend the host's AI credits.

## Build and release

```bash
npm install
npm run build          # ncc bundles src/index.js -> dist/index.js (+ licenses.txt)
```

- **`dist/` MUST be committed.** The Actions runner executes `dist/index.js` directly — it never runs `npm install` or a build step. Every change under `src/` requires `npm run build` and committing both `src/` and `dist/`.
- **`npm test`** runs the `node:test` suite in `test/`. Tests cover the exported pure functions across the `src/` modules (`config`, `diff`, `provider`, `selection`, `failover`, `review`, `transport`, `usage`, and the engine adapters) plus a dist smoke test that spawns `dist/index.js --review-collector-server` and performs a full MCP handshake. CI also asserts that committed `dist/` matches a fresh build (`npm run build` + `git diff --exit-code dist/`).
- Keep PRs to one fix/feature each, against `main`.

### Cutting a release

Releases are git tags (`0.1.1`, no `v` prefix). Consumers pin the action by tag — the `dist/index.js` + `action.yml` at the tagged commit are what executes — and most pin the **moving major tag** `v<major>` (e.g. `@v1`), which always points at the latest release in that major line.

**Every PR that changes what consumers run bumps the version, in that same PR.** The shipped surface is `src/`, `action.yml`, `review-agent/`, and the `dist/` built from them. A PR touching any of those edits `package.json`'s `version` by the correct semver level and rebuilds `dist/` — so `main`'s `package.json` is *always* the next publishable version, never lagging what's merged (the drift that left `package.json` at `0.1.0` while the tag was `0.1.1`). [LAW:one-source-of-truth] A PR that touches only docs, `scripts/`, or this file does **not** bump — bumping it would cut a release with no consumer-visible change.

Pick the level by what the diff does to the consumer contract:

- **patch** (`1.0.0 → 1.0.1`) — a bug fix or internal change; inputs and observable behavior are unchanged.
- **minor** (`1.0.0 → 1.1.0`) — a backward-compatible addition: a new optional input, a new capability existing workflows keep working without.
- **major** (`1.0.0 → 2.0.0`) — a breaking change: a removed/renamed input, a changed default, or behavior existing consumers depend on.

Versioning is split into two parts, deliberately:

1. **Bump** = part of the change itself, not a separate release chore. In the same PR that changes the shipped surface, edit `package.json`'s `version` to the level above, run `npm run build`, commit `package.json` + `dist/`, and merge to `main` via a PR like any other.
2. **Publish** = `scripts/release.sh`, run on a clean, up-to-date `main`:

   ```bash
   git checkout main && git pull && ./scripts/release.sh
   ```

   It reads the version from `package.json` (the single source of truth), refuses to run if the committed `dist/` doesn't match a fresh build, then tags the commit, re-points `v<major>`, pushes the tags, and creates the GitHub Release with generated notes. It never edits or commits anything — the bump already happened in step 1.

- A **breaking change** gets a new major (`2.0.0`); `scripts/release.sh` then manages `v2`, leaving `v1` frozen at the last 1.x so existing consumers don't break.

## Architecture

The source is split into focused modules under `src/` (orchestrator `run.js`; the config-file path `config.js` / `provider.js` / `selection.js` / `failover.js`; engine adapters under `engine/`; `prompt.js`, `transport.js`, `diff.js`, `review.js`, `collector.js`, `usage.js`, `report.js`); `src/index.js` is the thin entry point that bundles to `dist/index.js`. It has **two entry points**, selected at the bottom (the `COLLECTOR_SERVER_ARG` check):

1. **Action orchestrator** (`run` in `src/run.js`) — the default mode the runner invokes.
2. **MCP collector server** (`runReviewCollectorServer` in `src/collector-server.js`) — the *same bundled binary* re-spawned as a stdio MCP subprocess by the engine. The MCP config (`createReviewCollector`) wires `command: node, args: [__filename, '--review-collector-server']`, so the binary is self-referential.

The central design seam is **judgment vs. transport**:

- **The engine owns review judgment.** Whichever engine runs (claude-code, codex, opencode) does so read-only — its only output channel is the MCP collector tools, so it cannot post to GitHub itself. For example claude-code runs in non-interactive print mode (`-p --output-format json`) with `Read`/`Grep`/`Glob` + the two collector tools allowed and `Bash`/`Edit`/`Write`/`Web*` disallowed; each adapter enforces the equivalent read-only posture its own way (codex: read-only sandbox; opencode: `permission: {edit/bash/webfetch: deny}`).
- **The transport owns host I/O.** It reads the collector's records, validates them, and calls the review API of whichever host the runner reports.

This boundary is why findings flow through an MCP tool rather than being parsed from the engine's prose: `request_change` / `finish_review` produce typed, schema-validated records (`records.jsonl`), and `readCollectedReview` enforces "exactly one `finish_review`" before anything reaches the host.

### Engine adapters and configuration

An engine is reached only through an **adapter** (`src/engine/{claude-code,codex,opencode}.js`), registered by name in `src/engine/registry.js` — the single enumeration of engines. claude-code and codex share one CLI lifecycle via `makeCliAdapter` (`src/engine/cli.js`): `createReviewCollector → materializeHome → runEngine spawn → readCollectedReview`, with nested `try/finally` owning home + collector teardown. Each adapter supplies only its spawn primitives (`materializeHome`/`buildCommand`/`assertSucceeded`/`extractUsage`/`classifyError`) and a `capabilities` declaration (`endpointKinds`, `reasoningEfforts`). [LAW:decomposition]

Those capability declarations are the **single source of truth for config validation** [LAW:single-enforcer] — both config paths derive from them, so an illegal combination is rejected identically whichever path it came through:

- **Simple mode** (no `CONFIG_FILE`): `src/provider.js` turns the `PROVIDER` value + its provider-specific inputs into one typed `ReviewConfig`. `PROVIDERS` is the one table of concrete providers (`codex`/`zai`/`deepseek`); `PROVIDER_ALIASES` (`auto → deepseek`) is the one place to retarget every `PROVIDER: auto` consumer via a release, and `auto` is the default — a consumer that names no provider is retargeted centrally.
- **Config-file mode** (`.github/review-agents.yml` present): `src/config.js` parses, validates against the adapter capabilities, and resolves an ordered failover **chain** of `ReviewConfig` values; every `apiKeyEnv` in the chain must be set at startup. `src/selection.js` resolves the per-PR config name (label `review:<name>` > body trailer `Review-Config:` > `CONFIG` input > file `default`), failing loud on ambiguity or an unknown name.

`src/failover.js` (`produceReview`) is the single owner of retry timing and walks the chain: transient errors (classified at the adapter) retry ≤3× per config then advance; non-transient throw immediately (no failover); `buildAttributionFooter` names the config that actually produced the review.

### The line-anchor invariant (most fragile part)

This section applies to **`pr` mode only** — `repo` mode has no diff and no anchors. A finding anchors to a **new-file line number**, defined **once** in `patchLines` (`src/diff.js`): each `@@` hunk header resets the new-side counter; only added (`+`) and context (` `) lines advance it and are anchorable (deletions have no new-side line). Three consumers derive from it and must never reimplement it:

- `annotatePatchWithLines` — labels each anchorable diff line `LINE N` in the prompt so the model cites the right line.
- `buildReviewAnchors` — the `path:line` set used by `partitionFindings` to reconcile each finding with the visible diff.
- `transport.toComment` — maps a finding's `line` to the host's comment anchor.

The two-way contract: the model is shown lines as `LINE N` and should comment on those. When it anchors slightly off (a line just outside the hunk), `partitionFindings` (`src/review.js`) does **not** abort the review — that would discard every valid finding and red the run for one model slip. Instead it reconciles each finding as a value: a line within `MAX_ANCHOR_SNAP_DISTANCE` of a reviewed line is snapped to that line (body annotated so the move is explicit); a line too far from any reviewed line becomes an *unanchored* finding that `submitReview` renders in the review summary and `produceReviewOnce` logs as a warning. Either way the finding still counts toward the `REQUEST_CHANGES` verdict, so a mis-anchored real issue can never silently downgrade to APPROVE. [LAW:no-silent-failure]

### Host transport (GitHub + Gitea)

The action talks to whatever host the runner reports — the API base comes from `GITHUB_API_URL` (set by GitHub Actions and Gitea's `act_runner` alike), never hardcoded. The two host families differ in exactly two places, both behind one `transport` chosen once by **capability** in `selectTransport` (not by hostname):

- **Diff source.** GitHub's `listFiles` carries per-file `patch`; Gitea's does not. When no file has a `patch`, the transport fetches the unified `.diff` and `parseUnifiedDiff` splits it into the same `{filename, status, patch}` shape.
- **Comment anchor.** The same new-file line number becomes `{line, side: 'RIGHT'}` on GitHub and `{new_position}` on Gitea.

Everything downstream (`patchLines`, anchors, validation, the prompt) is host-agnostic. To support another host, add a transport instance; touch nothing else.

### Auth and environment

Each adapter translates the resolved `ReviewConfig` credential into the engine's own auth channel exactly once, in its `materializeHome`/`buildCommand`. The claude-code adapter (`src/engine/claude-code.js`) maps the config's `apiKey`/`baseUrl` to `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` (so the `zai` and `deepseek` providers differ only in base URL) and writes a per-run temp `HOME` holding the bundled `review-agent/instructions.md` as the reviewer's user-global `~/.claude/CLAUDE.md`. codex writes the key to `CODEX_HOME/auth.json` + a `config.toml`; opencode writes `XDG_CONFIG_HOME/opencode/opencode.json` with `OPENCODE_DISABLE_PROJECT_CONFIG=1`. The per-run temp home and collector dir are created and torn down by the shared `makeCliAdapter` (`src/engine/cli.js`) nested `try/finally`, so cleanup runs even when the engine throws.

**Config isolation is a security boundary.** Each engine runs against an isolated config home, so the *reviewed repo* cannot hijack the engine's model, endpoint, credential, or MCP servers. codex/opencode pass an explicit env allowlist (never a `process.env` spread) so a prompt-injection payload in the diff cannot read `GITHUB_TOKEN` or other secrets via a shell expression. **Project instructions are isolated by working directory:** every engine discovers project instructions (`CLAUDE.md`/`AGENTS.md`/`opencode.json`) from its cwd — by walking *upward*, and (claude-code) by loading nested `CLAUDE.md` from subtrees *under* cwd when it reads files there — so the shared `makeCliAdapter` spawns each engine with cwd = a fresh **isolated scratch dir** (`fs.mkdtempSync(...)` in `src/engine/cli.js`) that is **not an ancestor of the reviewed repo**. That defeats both discovery paths: nothing is found upward, and the repo — read only by absolute path, never under cwd — never triggers nested-memory loading. (The cwd must NOT be the repo's *parent*: that would put the repo *under* cwd and re-open claude-code's nested-`CLAUDE.md`-on-read vector.) This closes the instruction-injection vector structurally for all engines at once, rather than via per-engine "disable project config" switches — none of which cleanly exists (claude-code's `--no-memory` also drops the reviewer's *own* instructions; codex has only a size knob; opencode's flag doesn't reliably cover project `AGENTS.md`). The repo is reached by its absolute path, named in the prompt via `REVIEWED_REPO_ROOT` (= `GITHUB_WORKSPACE`); Read/Grep/Glob access absolute paths outside cwd with no `--add-dir` grant. The reviewer's own instructions load from the isolated home (`HOME`/`CODEX_HOME`/`XDG_CONFIG_HOME`), keyed to env not cwd, so they are untouched. codex additionally passes `--skip-git-repo-check` because its scratch cwd is not a git repo (`codex exec` otherwise hangs waiting on stdin). A repo-committed instruction file stays *readable* as context (the agent may `Read` it) — it is simply no longer auto-loaded as binding directives. This is defense in depth behind the unconditional fork check (fork PRs are never reviewed), narrowing the residual same-repo-PR surface.

### Cost reporting

Every review reports its actual USD cost in the attribution footer of the PR review comment (and the run log). `runEngine` resolves with the engine's captured stdout; each adapter exposes a pure `extractUsage(output, config) → {inputTokens, outputTokens, cost}|null` where `cost` is a discriminated value — `{available:true, usd}` or `{available:false, reason:'no-price'|'not-reported'}`. Each adapter declares its own unavailable-reason at the point it knows it (codex or a foreign-endpoint claude-code run: model absent from the price table — `no-price`; a genuine Anthropic claude-code run that omitted `total_cost_usd` — `not-reported`), so the orchestrator never re-derives why cost is missing. Usage is carried as a value from `produceReviewOnce` through `produceReview` to the footer — never recomputed. [LAW:dataflow-not-control-flow]

Cost is **one mechanism — tokens × the price table — for every priced provider** [LAW:one-type-per-behavior], with a single exception. `PRICES_PER_MILLION` in `src/usage.js` is the one table, keyed by the exact model id each engine reports (`gpt-*`, `deepseek-*`, `glm-*` — namespaces don't collide); `computeCostUsd` prices a run from it. Each adapter buckets its own raw usage into the table's shape (codex: `cached_input_tokens` billed at the cached rate; claude-code: `cache_read` at the cached rate, fresh + `cache_creation` at the full rate). The table is a representation that drifts from each vendor's real prices and has **no machine source — it must be updated by hand**; each entry carries a dated source URL (verify before trusting old figures). [LAW:one-source-of-truth] The single exception is a **genuine Anthropic** claude-code run (`isAnthropicEndpoint`): there Claude Code's own `total_cost_usd` is the cost, since it is already Anthropic-priced. The wrong-vendor trap this avoids: Claude Code computes `total_cost_usd` against *Anthropic's* table, so on an Anthropic-**compatible** endpoint (z.ai, deepseek) that figure is the wrong vendor's — `costFromEnvelope` discards it and prices from the provider's own table entry instead. The Anthropic check is a whitelist (apex or true `.anthropic.com` subdomain), not a per-vendor blacklist, so a lookalike host or a future compatible endpoint can never be wrongly trusted. A model with no table entry renders cost as `unknown` (tokens still shown) and logs a warning naming the model to add; missing usage omits the cost line loudly, never silently. [LAW:no-silent-failure] Every rendered cost is an **estimate** (`est.`) — table × tokens, or Claude Code's client-side `total_cost_usd` — never a billed charge.

### Approval permissions

The default `GITHUB_TOKEN` cannot approve PRs. With no `GITHUB_REVIEW_TOKEN`, a clean review just logs `✅ Approved` (no formal approval submitted); findings still submit a `REQUEST_CHANGES` review. Set `GITHUB_REVIEW_TOKEN` (used for *all* GitHub calls when present) to submit formal approvals.

## Two CLAUDE.md files — do not confuse them

- **This file** (`/CLAUDE.md`) — guidance for working *on* this repo.
- **`review-agent/instructions.md`** — a runtime artifact: the reviewer's instructions, copied by each adapter's `materializeHome` into the spawned reviewer's engine-global instructions file (`~/.claude/CLAUDE.md` for claude-code, `AGENTS.md` for codex/opencode). Editing it changes *how reviews are conducted*, not how you develop here. The review task prompt itself (the law priorities, the `request_change` rules) is the big template literal in `buildReviewInput`.
