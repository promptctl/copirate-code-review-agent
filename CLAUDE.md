# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A GitHub Action that runs Claude Code (pointed at Z.ai's Anthropic-compatible endpoint) as a PR reviewer. It feeds the PR diff to Claude Code, which records required changes through a private MCP "collector" tool, then the action turns those records into inline GitHub review comments and submits a `REQUEST_CHANGES` or `APPROVE` review.

## Build and release

```bash
npm install
npm run build          # ncc bundles src/index.js -> dist/index.js (+ licenses.txt)
```

- **`dist/` MUST be committed.** The Actions runner executes `dist/index.js` directly — it never runs `npm install` or a build step. Every change to `src/index.js` requires `npm run build` and committing both `src/` and `dist/`.
- There is **no test suite, linter, or test command**. "Verify" means building cleanly and reasoning through the runtime path; there is no `npm test`.
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

Everything lives in `src/index.js`. It is a **single file with two entry points**, selected at the bottom (the `COLLECTOR_SERVER_ARG` check):

1. **Action orchestrator** (`run`) — the default mode the runner invokes.
2. **MCP collector server** (`runReviewCollectorServer`) — the *same file* re-spawned as a stdio MCP subprocess by Claude Code. The MCP config (`createReviewCollector`) wires `command: node, args: [__filename, '--review-collector-server']`, so the binary is self-referential.

The central design seam is **judgment vs. transport**:

- **Claude Code owns review judgment.** It runs in non-interactive print mode (`-p --output-format json`), read-only (allowed: `Read`/`Grep`/`Glob` + the two collector tools; disallowed: `Bash`/`Edit`/`Write`/`Web*`). Its *only* output channel is the collector tools — it cannot post to GitHub itself.
- **The transport owns host I/O.** It reads the collector's records, validates them, and calls the review API of whichever host the runner reports.

This boundary is why findings flow through an MCP tool rather than being parsed from Claude's prose: `request_change` / `finish_review` produce typed, schema-validated records (`records.jsonl`), and `readCollectedReview` enforces "exactly one `finish_review`" before anything reaches the host.

### The line-anchor invariant (most fragile part)

A finding anchors to a **new-file line number**, defined **once** in `patchLines` (`src/index.js`): each `@@` hunk header resets the new-side counter; only added (`+`) and context (` `) lines advance it and are anchorable (deletions have no new-side line). Three consumers derive from it and must never reimplement it:

- `annotatePatchWithLines` — labels each anchorable diff line `LINE N` in the prompt so the model cites the right line.
- `buildReviewAnchors` — the `path:line` set used by `validateFindings` to reject any finding outside the visible diff.
- `transport.toComment` — maps a finding's `line` to the host's comment anchor.

The two-way contract: the model can only comment on lines it was shown as `LINE N`, and the action rejects anything else.

### Host transport (GitHub + Gitea)

The action talks to whatever host the runner reports — the API base comes from `GITHUB_API_URL` (set by GitHub Actions and Gitea's `act_runner` alike), never hardcoded. The two host families differ in exactly two places, both behind one `transport` chosen once by **capability** in `selectTransport` (not by hostname):

- **Diff source.** GitHub's `listFiles` carries per-file `patch`; Gitea's does not. When no file has a `patch`, the transport fetches the unified `.diff` and `parseUnifiedDiff` splits it into the same `{filename, status, patch}` shape.
- **Comment anchor.** The same new-file line number becomes `{line, side: 'RIGHT'}` on GitHub and `{new_position}` on Gitea.

Everything downstream (`patchLines`, anchors, validation, the prompt) is host-agnostic. To support another host, add a transport instance; touch nothing else.

### Auth and environment

Z.ai credentials are translated to Claude Code's env exactly once in `runClaudeCode`: `ZAI_API_KEY` → `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic`, plus a per-run temp `HOME` (`createReviewerHome`) holding the bundled `review-agent/CLAUDE.md` as the reviewer's user-global instructions. Temp `HOME` and collector dirs are created and torn down by the same owner (the `try/finally` in `run`).

### Approval permissions

The default `GITHUB_TOKEN` cannot approve PRs. With no `GITHUB_REVIEW_TOKEN`, a clean review just logs `✅ Approved` (no formal approval submitted); findings still submit a `REQUEST_CHANGES` review. Set `GITHUB_REVIEW_TOKEN` (used for *all* GitHub calls when present) to submit formal approvals.

## Two CLAUDE.md files — do not confuse them

- **This file** (`/CLAUDE.md`) — guidance for working *on* this repo.
- **`review-agent/CLAUDE.md`** — a runtime artifact: the reviewer's instructions, copied into the spawned reviewer's `~/.claude/CLAUDE.md`. Editing it changes *how reviews are conducted*, not how you develop here. The review task prompt itself (the law priorities, the `request_change` rules) is the big template literal in `buildReviewInput`.
