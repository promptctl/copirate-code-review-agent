# Coding Agent Review

A GitHub Action that runs an AI coding agent as a **read-only** code reviewer. It reviews a pull request diff and submits an inline GitHub review — `REQUEST_CHANGES` when it finds blocking issues, otherwise `APPROVE`. It can also do an on-demand whole-repo review (`MODE: repo`).

The review engine is chosen by `PROVIDER`, which defaults to `auto` (today: Claude Code against DeepSeek). You can also run Codex against OpenAI. The engine reviews read-only — it cannot push to GitHub itself; findings flow through a private collector and are submitted by the action.

## Quickstart

1. Add a `DEEPSEEK_API_KEY` repository secret (**Settings → Secrets and variables → Actions**), or via the CLI:

   ```bash
   gh secret set DEEPSEEK_API_KEY --body "$DEEPSEEK_API_KEY"
   ```

2. Add `.github/workflows/code-review.yml`:

   ```yaml
   name: AI Code Review

   on:
     pull_request:
       types: [opened, synchronize, reopened]

   permissions:
     contents: read
     issues: write
     pull-requests: write

   jobs:
     review:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v6
           with:
             ref: ${{ github.event.pull_request.head.sha }}

         - uses: brandon-fryslie/coding-agent-review@v1
           with:
             DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
   ```

That's it. Open a PR and the action reviews it. The checkout is optional context for the reviewer — the review itself is fetched and posted through the GitHub API, so it works even without checking out the code.

## Providers

`PROVIDER` selects the engine in simple mode. Each provider needs its own API key secret.

| `PROVIDER` | Engine | Key | Default model |
|---|---|---|---|
| `auto` *(default)* | Claude Code → DeepSeek | `DEEPSEEK_API_KEY` | `deepseek-v4-pro` |
| `deepseek` | Claude Code → DeepSeek | `DEEPSEEK_API_KEY` | `deepseek-v4-pro` |
| `codex` | Codex → OpenAI | `OPENAI_API_KEY` | `gpt-5.4-mini` |

`auto` resolves to whichever provider the action currently points at (DeepSeek today). Pinning `auto` lets the maintainer retarget every consumer with a release, without anyone editing their workflow — supply the key for whatever `auto` currently resolves to.

To run Codex instead:

```yaml
      - uses: brandon-fryslie/coding-agent-review@v1
        with:
          PROVIDER: codex
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

For a failover chain or per-PR engine selection, use the [config file](#multi-engine-configuration) instead.

## Inputs

| Input | Default | Description |
|---|---|---|
| `PROVIDER` | `auto` | Engine: `auto`, `deepseek`, or `codex`. Ignored when a `CONFIG_FILE` exists. |
| `DEEPSEEK_API_KEY` | — | Required for `auto`/`deepseek`. |
| `DEEPSEEK_MODEL` | `deepseek-v4-pro` | Model for the `deepseek` provider. |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com/anthropic` | Anthropic-compatible endpoint for `deepseek`. |
| `OPENAI_API_KEY` | — | Required for `codex`. |
| `OPENAI_MODEL` | `gpt-5.4-mini` | Model for the `codex` provider. |
| `OPENAI_REASONING_EFFORT` | — | `minimal`, `low`, `medium`, `high`, or `xhigh`. |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI-Responses-compatible endpoint (e.g. Azure or a gateway). |
| `MODE` | `pr` | `pr` (review a PR diff, post an inline review) or `repo` ([whole-repo review](#whole-repo-review)). |
| `SCOPE` | — | Free-text focus for `MODE: repo` (e.g. `the auth layer`). Ignored when `MODE: pr`. |
| `CONFIG_FILE` | `.github/review-agents.yml` | [Multi-engine config file](#multi-engine-configuration). When present it owns engine selection and the `PROVIDER`/key inputs are ignored. |
| `CONFIG` | — | Select a named config from the config file, overriding its `default`. |
| `ZAI_REVIEWER_NAME` | `Coding Agent Review` | Name shown in the review comment header (applies to every provider; the `ZAI_` prefix is historical). |
| `EXCLUDE_PATTERNS` | `*.lock,package-lock.json,yarn.lock,pnpm-lock.yaml` | Comma-separated file patterns to exclude. |
| `MAX_DIFF_CHARS` | `0` (unlimited) | Max characters of diff sent to the engine. |
| `GITHUB_REVIEW_TOKEN` | — | Token used for all GitHub calls when set; required to submit a **formal approval** (see [Approvals](#approvals)). |
| `PR_NUMBER` | from event | PR number. Auto-detected on `pull_request` events; pass explicitly on others (e.g. `workflow_run`). |
| `HEAD_SHA` | from event | Head SHA the review anchors to. Auto-detected on `pull_request` events. |

The action installs its bundled reviewer instructions as the engine's user-global instructions for each run. The reviewed repository's own `CLAUDE.md`/`AGENTS.md` are **not** auto-loaded — each engine runs in an isolated working directory, so a committed instruction file cannot redirect the reviewer (it stays readable as plain context).

## Approvals

The default `GITHUB_TOKEN` cannot approve PRs. With no `GITHUB_REVIEW_TOKEN`:

- Findings are submitted as a `REQUEST_CHANGES` review with inline threads.
- A clean review just logs `✅ Approved` (no formal approval is submitted).

Set `GITHUB_REVIEW_TOKEN` to an approval-capable user or GitHub App token to have clean reviews submit a formal `APPROVE`. When findings exist the action requests changes — resolve the threads and dismiss the review to proceed.

## Fork PRs are never reviewed

PRs opened from a fork (head repo ≠ base repo) are skipped cleanly — logged, exit 0, no engine spawned, no review posted — *before any credential is read*. This is unconditional with no opt-in, so an outside contributor's PR can never spend the host's AI credits or meet a secret. Your own branches (head and base in the same repo) review normally.

## Whole-repo review

Set `MODE: repo` for an on-demand review of the **whole working tree** instead of a PR diff. There's no PR: the engine explores the checked-out repo with Read/Grep/Glob, and findings are printed as a Markdown report to the **GitHub Step Summary** and run log — no inline comments, no review submitted, no write token needed. Unlike PR mode (which only flags what the diff introduces), repo mode deliberately flags **pre-existing** issues.

```yaml
name: AI Whole-Repo Review

on:
  workflow_dispatch:
    inputs:
      scope:
        description: "Optional focus, e.g. 'the auth layer'. Blank = broad review."
        required: false

permissions:
  contents: read

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: brandon-fryslie/coding-agent-review@v1
        env:
          DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
        with:
          MODE: repo
          SCOPE: ${{ inputs.scope }}
```

Provider selection and `EXCLUDE_PATTERNS` work as in PR mode. The run is informational and exits 0 regardless of findings.

> **Scale limit:** it's a single agent run, so a broad pass over a very large repo can exceed the agent's context. Pass a `SCOPE` to focus on one subsystem at a time.

## Multi-engine configuration

Simple mode (the `PROVIDER` input) runs one engine. For a **failover chain**, **per-PR engine selection**, or **arbitrary engine/endpoint/model combinations**, commit `.github/review-agents.yml`. When it exists it owns engine selection, and the simple-mode `PROVIDER`/key inputs are ignored.

```yaml
version: 1                       # schema version; unknown version fails loudly
default: deepseek                # which config reviews when nothing else selects one
fallback:                        # optional ordered failover chain
  - deepseek
  - codex-gpt55

configs:
  deepseek:
    engine: claude-code          # claude-code | codex | opencode
    model: deepseek-v4-pro
    reasoning: high              # validated against the engine's declared efforts
    endpoint:
      kind: anthropic-messages
      baseUrl: https://api.deepseek.com/anthropic
      apiKeyEnv: DEEPSEEK_API_KEY  # the NAME of an env var — never a secret value

  codex-gpt55:
    engine: codex
    model: gpt-5.5
    reasoning: xhigh
    endpoint:
      kind: openai-responses
      baseUrl: https://api.openai.com/v1
      apiKeyEnv: OPENAI_API_KEY
```

Every field is validated **once, at startup** against the engine's capabilities. An illegal combination (codex with an `anthropic-messages` endpoint, a `reasoning` on opencode, an unknown engine, a `default`/`fallback` naming an undefined config, or an `apiKeyEnv` whose variable is unset) fails the run with a message naming the config, field, and allowed values.

### Engine capability matrix

A config is rejected at load unless its `endpoint.kind` and `reasoning` are valid for its `engine`:

| Engine | `endpoint.kind` | `reasoning` efforts |
|---|---|---|
| `claude-code` | `anthropic-messages` | `low`, `medium`, `high`, `max` |
| `codex` | `openai-responses` | `minimal`, `low`, `medium`, `high`, `xhigh` |
| `opencode` | `openai-chat`, `openai-responses`, `anthropic-messages` | *(none — setting `reasoning` is a config error)* |

`opencode` models are `<provider>/<model>`. The same provider can be reached through more than one engine — e.g. DeepSeek via `claude-code` (`anthropic-messages`, `…/anthropic`) or `opencode` (`openai-chat`, base host).

### Secrets

A config never holds a secret — `apiKeyEnv` names an env var the **workflow** maps from a GitHub secret. Map each one in the step's `env:` block:

```yaml
      - uses: brandon-fryslie/coding-agent-review@v1
        env:
          DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
        with:
          GITHUB_REVIEW_TOKEN: ${{ secrets.GITHUB_REVIEW_TOKEN }}
```

Every `apiKeyEnv` reachable in the chain must be set and non-empty at startup, or the run fails fast.

### Per-PR selection

Which config reviews a PR is resolved in precedence order (first match wins):

1. **Label** `review:<config-name>` on the PR (e.g. `review:codex-gpt55`). More than one is ambiguous and fails.
2. **PR-body trailer** `Review-Config: <config-name>` (case-insensitive, own line).
3. **`CONFIG` input** — a fixed choice in the workflow.
4. The file's **`default`**.

Selection only ever picks among configs the maintainer committed. A PR author can *steer* the review toward another configured engine, but can never introduce a new config, endpoint, or secret.

To make a `review:gpt-5.5` label "just work", name a config `gpt-5.5`. Selection is **by config name only**, never a bare model string (a model alone underdetermines engine, endpoint, and credential). Add `labeled` to your workflow's `on.pull_request.types` so a freshly added label triggers a re-review.

### Failover

When `fallback` is set, the selected config plus the rest of that list form the failover chain. A **transient** error (429 / rate-limit / quota / 529) retries the same config up to 3× (honoring `Retry-After`), then advances to the next config immediately; an exhausted chain backs off and sweeps again until a 60-minute budget is spent. A **non-transient** error (bad output, validation failure, spawn error) throws immediately with no failover. The submitted review's footer names the config that actually produced it, so a failover is always visible.

## Preflight diagnostic

Before spawning the engine, the action runs a cheap connectivity + auth probe against the selected endpoint (a single `max_tokens: 1` request, ~1s). A wrong/expired credential or unreachable endpoint **fails fast with a precise cause** in the log instead of failing cryptically inside the agent. With a failover chain, the run proceeds as long as *any* config is reachable; unhealthy configs are logged as warnings.

## Session transcript

Every review run captures the **full session** of every engine attempt — the exact prompt sent to the engine, the raw output stream (claude-code runs `stream-json --verbose` so **thinking and tool calls** are included), and stderr. There is no flag to enable; it is always on. Each attempt's transcript is surfaced two ways:

- **In the Actions log** — inside a collapsible `🛠️ Session transcript` group, so you can click into the workflow run and read the entire prompt/response/thinking flow with no extra setup.
- **As a file** under `$RUNNER_TEMP/agent-review-transcripts/`, exposed via the action's `transcript-dir` **output**. Add one `actions/upload-artifact` step to archive the session as a downloadable artifact on **every** run — including failed attempts (`if: always()`):

```yaml
      - uses: brandon-fryslie/coding-agent-review@v1
        id: review
        with:
          DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}

      - if: always() && steps.review.outputs.transcript-dir != ''
        uses: actions/upload-artifact@v4
        with:
          name: review-session-transcript
          path: ${{ steps.review.outputs.transcript-dir }}
          if-no-files-found: ignore
```

The transcript dumps the engine's own raw streams verbatim — it is not a reconstructed narrative. The API key is never part of a transcript. This is the first place to look when a review seems shallow: if the `RAW STDOUT` section shows no `Read`/`Grep`/`Glob` tool calls, the engine reviewed only the inline diff without exploring the repo.

## Cost reporting

Every review reports its estimated USD cost in the attribution footer and the run log (tokens × a hand-maintained price table). A model with no table entry renders cost as `unknown` (tokens still shown) and logs a warning. Costs are estimates, never billed charges.

## Architecture

The reviewer **judges** read-only; the action **transports** the result. The engine's only output channel is a private MCP collector tool, so it can't post to GitHub itself — findings become typed, schema-validated records that the action validates and submits. For internals (engine adapters, the line-anchor invariant, host transports, config isolation), see [`CLAUDE.md`](CLAUDE.md) and `src/`.

## Contributing

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). One fix/feature per PR, against `main`.

## License

MIT. See [LICENSE](LICENSE).
