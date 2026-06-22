# Coding Agent Review

AI-powered GitHub Pull Request code review. The engine is chosen by the `PROVIDER` input, which defaults to `auto` — the action's own choice, today Claude Code against DeepSeek. It can also run the Codex engine against OpenAI or Claude Code against the Z.ai Coding Plan. The action runs in the GitHub Actions runner, then submits a pull request review with inline review threads.

## Features

- Detect bugs
- Suggest improvements
- Use bundled reviewer `CLAUDE.md` instructions
- Leave inline review threads on required changes
- Request changes when required changes exist, otherwise approve the pull request

## Quickstart (hand this to your agent)

````

Add this to your `.github/workflows/code-review.yml`:

```yaml
name: AI Code Review

on:
  pull_request:
    types: [opened, synchronize]

permissions:
  contents: read
  issues: write
  pull-requests: write

jobs:
  review:
    name: Review
    runs-on: ubuntu-latest
    steps:
      - name: Checkout pull request
        uses: actions/checkout@v6
        with:
          ref: ${{ github.event.pull_request.head.sha }}

      - name: Code Review
        uses: brandon-fryslie/zai-coding-agent-review@v1
        with:
          # PROVIDER defaults to 'auto' (today DeepSeek). Set PROVIDER: codex or
          # PROVIDER: zai to pick another engine, and pass that provider's key.
          DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
```

## Agent install instructions

Copy and paste this into the target repository to install the action:

```bash
mkdir -p .github/workflows
cat > .github/workflows/code-review.yml <<'YAML'
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
    name: Review
    runs-on: ubuntu-latest
    steps:
      - name: Checkout pull request
        uses: actions/checkout@v6
        with:
          ref: ${{ github.event.pull_request.head.sha }}

      - name: Code Review
        uses: brandon-fryslie/zai-coding-agent-review@v1
        with:
          DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
YAML
```

If the repository does not already have the secret, set it with GitHub CLI:

```bash
gh secret set DEEPSEEK_API_KEY --body "$DEEPSEEK_API_KEY"
```

Then commit the workflow:

```bash
git add .github/workflows/code-review.yml
git commit -m "Install Z.ai coding agent review action"
```

````

## Inputs

The engine is selected by `PROVIDER`. Each provider needs its own credential.

| Input | Required | Default | Description |
|---|---|---|---|
| `PROVIDER` | No | `auto` | Engine in simple mode: `auto` (the action picks — `deepseek` today), `codex` (OpenAI), `zai` (Claude Code against Z.ai), or `deepseek` (Claude Code against DeepSeek). Ignored when a `CONFIG_FILE` exists. |
| `OPENAI_API_KEY` | When `PROVIDER=codex` | — | OpenAI API key for the `codex` provider |
| `OPENAI_MODEL` | No | `gpt-5.4-mini` | Model for the `codex` provider |
| `OPENAI_REASONING_EFFORT` | No | — | `minimal`, `low`, `medium`, `high`, or `xhigh` for the `codex` provider |
| `OPENAI_BASE_URL` | No | `https://api.openai.com/v1` | OpenAI-Responses-compatible endpoint (e.g. Azure OpenAI or a gateway) |
| `ZAI_API_KEY` | When `PROVIDER=zai` | — | Z.ai API key for the `zai` provider |
| `ZAI_MODEL` | No | `glm-5.1` | Model for the `zai` provider |
| `ZAI_BASE_URL` | No | `https://api.z.ai/api/anthropic` | Anthropic-compatible endpoint for the `zai` provider |
| `DEEPSEEK_API_KEY` | When `PROVIDER=deepseek` or `auto` | — | DeepSeek API key for the `deepseek` provider |
| `DEEPSEEK_MODEL` | No | `deepseek-v4-pro` | Model for the `deepseek` provider |
| `DEEPSEEK_BASE_URL` | No | `https://api.deepseek.com/anthropic` | Anthropic-compatible endpoint for the `deepseek` provider |
| `ZAI_SYSTEM_PROMPT` | No | See below | Additional system prompt appended to Claude Code (`zai` provider) |
| `ZAI_REVIEWER_NAME` | No | `Coding Agent Review` | Name shown in the review comment header |
| `MODE` | No | `pr` | Review material: `pr` (review a pull request diff, post an inline review) or `repo` ([whole-repo review](#whole-repo-review-mode-on-demand), prints a report to the Step Summary, needs no PR). |
| `SCOPE` | No | — | Free-text focus for `MODE=repo`, injected into the review prompt (e.g. `the auth layer`). Empty = broad whole-repo review. Ignored when `MODE=pr`. |
| `CONFIG_FILE` | No | `.github/review-agents.yml` | Multi-engine config file. When it exists it owns engine selection and the `PROVIDER`/key inputs above are ignored. |
| `CONFIG` | No | — | Select a named config from the config file, overriding its `default` |
| `EXCLUDE_PATTERNS` | No | `*.lock,package-lock.json,yarn.lock,pnpm-lock.yaml` | Comma-separated file patterns to exclude from review |
| `MAX_DIFF_CHARS` | No | `0` (unlimited) | Maximum total characters for the diff sent to the engine |
| `GITHUB_REVIEW_TOKEN` | No | — | Optional token for submitting reviews when `GITHUB_TOKEN` cannot approve pull requests |
| `PR_NUMBER` | No | from `pull_request` event | Pull request number to review. Auto-detected on `pull_request` events; pass explicitly on other events (e.g. `workflow_run`) |
| `HEAD_SHA` | No | from `pull_request` event | Head commit SHA the review is anchored to. Auto-detected on `pull_request` events; pass explicitly on other events |

The action fetches the changed files and posts the review through the GitHub API, keyed by `PR_NUMBER` — it does **not** require the pull request's code to be checked out (the checkout only gives the review agent surrounding context). Pull requests from forks are [never reviewed](#fork-pull-requests-are-not-reviewed).

The action installs its bundled reviewer instructions as Claude Code's user-global `CLAUDE.md` for each review run. The reviewed repository's own instruction files (`CLAUDE.md`/`AGENTS.md`) are not auto-loaded — each engine runs in an isolated working directory so a committed instruction file cannot redirect the reviewer (it stays readable as context).

## Configuration

The default provider is `auto`, which today runs Claude Code against DeepSeek: add a `DEEPSEEK_API_KEY` secret and reviews run on DeepSeek. To run Codex against OpenAI instead, set `PROVIDER: codex` and supply `OPENAI_API_KEY`; for the Z.ai Coding Plan, set `PROVIDER: zai` and supply `ZAI_API_KEY` (both `zai` and `deepseek` run on the Claude Code engine against an Anthropic-compatible endpoint).

Set `PROVIDER: auto` to delegate the choice to the action: `auto` forwards to whichever provider the action currently points it at (`deepseek` today). Pinning `PROVIDER: auto` lets the maintainer retarget every consumer at once — by releasing a new action version that points `auto` elsewhere — without any consumer editing their workflow. Supply the key for whichever provider `auto` currently resolves to.

**Simple mode covers a single engine.** To run a *different* provider per pull request (by label or PR-body directive), or to chain failover engines so a rate-limited provider hands off to another, commit a [`.github/review-agents.yml` config file](#multi-engine-configuration-githubreview-agentsyml). When that file exists it owns engine selection and the `PROVIDER`/key inputs above are ignored.

## Multi-engine configuration (`.github/review-agents.yml`)

Simple mode (the `PROVIDER` input) runs one engine. For the three things `PROVIDER` can't express — **a failover chain**, **per-pull-request engine selection**, and **arbitrary engine/endpoint/model/reasoning combinations** — commit a config file. Its presence switches the action into config-file mode: the file is the single source of every reviewer configuration, and the simple-mode `PROVIDER`/`OPENAI_*`/`ZAI_*`/`DEEPSEEK_*` inputs are ignored.

### The file

```yaml
version: 1                       # schema version; an unknown version fails the run loudly
default: zai-glm                 # which config reviews when nothing else selects one
fallback:                        # optional ordered failover chain (see "Failover" below)
  - zai-glm
  - codex-gpt55

configs:
  zai-glm:
    engine: claude-code          # claude-code | codex | opencode
    model: glm-5.1
    reasoning: high              # validated against the engine's declared efforts (see matrix)
    endpoint:
      kind: anthropic-messages   # must be one the engine supports (see matrix)
      baseUrl: https://api.z.ai/api/anthropic
      apiKeyEnv: ZAI_API_KEY     # the NAME of an env var — NEVER a secret value

  codex-gpt55:
    engine: codex
    model: gpt-5.5
    reasoning: xhigh
    endpoint:
      kind: openai-responses
      baseUrl: https://api.openai.com/v1
      apiKeyEnv: OPENAI_API_KEY

  oc-mini:
    engine: opencode
    model: openai/gpt-5.4-mini   # opencode models are "<provider>/<model>"
    endpoint:
      kind: openai-chat
      baseUrl: https://api.openai.com/v1
      apiKeyEnv: OPENAI_API_KEY
    # reasoning: high            # ← would FAIL at load: opencode supports no reasoning efforts
```

Every field is validated **once, at startup** against the chosen engine's declared capabilities — an illegal combination (codex with an `anthropic-messages` endpoint, a `reasoning:` on opencode, an unknown engine, a `default`/`fallback` naming a config that isn't defined, or an `apiKeyEnv` whose variable is unset) fails the run with a message naming the config, the field, and the allowed values. Nothing is discovered mid-review.

### Engine capability matrix

A config is rejected at load unless its `endpoint.kind` and `reasoning` are listed for its `engine`:

| Engine | `endpoint.kind` | `reasoning` efforts | Notes |
|---|---|---|---|
| `claude-code` | `anthropic-messages` | `low`, `medium`, `high`, `max` | Any Anthropic-compatible endpoint (Z.ai, DeepSeek, Anthropic). |
| `codex` | `openai-responses` | `minimal`, `low`, `medium`, `high`, `xhigh` | OpenAI Responses API only — it cannot speak an Anthropic endpoint. |
| `opencode` | `openai-chat`, `openai-responses`, `anthropic-messages` | *(none — setting `reasoning` is a config error)* | `model` is `<provider>/<model>`; the `endpoint.baseUrl` overrides the provider's URL. |

The same provider can be reached through more than one engine — e.g. DeepSeek via `claude-code` (`anthropic-messages`, `https://api.deepseek.com/anthropic`) or via `opencode` (`openai-chat`, `https://api.deepseek.com`).

### Secrets via env

A config never holds a secret; `apiKeyEnv` names an environment variable that the **workflow** maps from a GitHub secret. Map each one in the action step's `env:` block:

```yaml
      - name: Code Review
        uses: brandon-fryslie/zai-coding-agent-review@v1
        env:
          ZAI_API_KEY: ${{ secrets.ZAI_API_KEY }}
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
        with:
          GITHUB_REVIEW_TOKEN: ${{ secrets.GITHUB_REVIEW_TOKEN }}
```

Every `apiKeyEnv` reachable in the resolved chain must be present and non-empty at startup, or the run fails fast (it is not discovered later when failover reaches that config). Resolved keys are registered as masked secrets in the run log.

### Per-pull-request selection

Which config reviews a given PR is resolved in this precedence order (first match wins):

1. **Label** `review:<config-name>` on the PR — e.g. `review:codex-gpt55`. More than one `review:` label is ambiguous and fails the run.
2. **PR-body trailer** `Review-Config: <config-name>` (case-insensitive, on its own line).
3. **`CONFIG` action input** — a fixed choice in the workflow.
4. The file's **`default`**.

Want a `review:gpt-5.5` label to "just work"? Name a config `gpt-5.5`. Selection is **by config name only** — never a bare model string, because a model alone underdetermines the engine, endpoint, and credential.

**Security property.** Selection only ever picks among configs the maintainer committed to the file. A pull-request author can *steer* the review toward another configured provider (via a label or body trailer), but can never introduce a new config, endpoint, or secret — those live only in the repo file and the workflow's `env:`. Combined with the [fork gate](#fork-pull-requests-are-not-reviewed) (fork PRs are never reviewed at all) and per-engine config isolation (each engine runs against an isolated config home — `CODEX_HOME` / a temp `HOME` / `XDG_CONFIG_HOME` with `OPENCODE_DISABLE_PROJECT_CONFIG=1` — so the reviewed repo cannot hijack the engine's model, endpoint, credential, or MCP servers), an untrusted contribution can neither spend nor redirect the host's credentials.

### Failover

When the file declares a `fallback` list, the selected config plus the rest of that list (minus the selected one, in order) form the **failover chain**. `produceReview` is the single owner of retry timing:

- A **transient** error (HTTP 429 / rate-limit / quota / 529-overloaded, classified by that engine's adapter) is retried on the same config up to 3 attempts total, honoring a `Retry-After` hint when the provider sends one, otherwise exponential backoff.
- Still failing → advance to the next config in the chain **immediately** (a different provider; waiting buys nothing).
- Chain exhausted → back off (cap 60s) and sweep the chain again, until a 60-minute budget is spent, then fail.
- A **non-transient** error (bad output envelope, validation failure, spawn error) throws immediately with **no failover** — hopping providers would only mask a real bug.

The submitted review's footer names the config that actually produced it — `_Reviewed by config \`codex-gpt55\` / codex / gpt-5.5 / reasoning \`xhigh\`._` — so a failover is always visible after the fact.

### Full example workflow

```yaml
name: AI Code Review

on:
  pull_request:
    types: [opened, synchronize, reopened, labeled]

permissions:
  contents: read
  issues: write
  pull-requests: write

jobs:
  review:
    name: Review
    runs-on: ubuntu-latest
    steps:
      - name: Checkout pull request
        uses: actions/checkout@v6
        with:
          ref: ${{ github.event.pull_request.head.sha }}

      - name: Code Review
        uses: brandon-fryslie/zai-coding-agent-review@v1
        env:
          # One entry per apiKeyEnv referenced in .github/review-agents.yml
          ZAI_API_KEY: ${{ secrets.ZAI_API_KEY }}
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
        with:
          GITHUB_REVIEW_TOKEN: ${{ secrets.GITHUB_REVIEW_TOKEN }}
```

(The `labeled` event type lets a freshly added `review:<name>` label trigger a re-review.) With `.github/review-agents.yml` committed, this one workflow serves every config in the file; authors pick one per PR by label or body trailer, and the `fallback` list handles provider outages automatically.

## Selecting a specific engine

`auto` (the default) runs Claude Code against DeepSeek today. To pin a specific engine, set `PROVIDER` and supply that provider's key — for example, Z.ai:

```yaml
      - uses: brandon-fryslie/zai-coding-agent-review@v1
        with:
          PROVIDER: zai
          ZAI_API_KEY: ${{ secrets.ZAI_API_KEY }}
```

All `ZAI_*` inputs (`ZAI_API_KEY`, `ZAI_MODEL`, `ZAI_BASE_URL`, `ZAI_SYSTEM_PROMPT`, `ZAI_REVIEWER_NAME`) apply once `PROVIDER: zai` is set. When you outgrow a single engine, adopt a [config file](#multi-engine-configuration-githubreview-agentsyml).

## Operation

This action reviews your PRs with whichever engine `PROVIDER` selects — by default `auto` (Claude Code against DeepSeek today).  

By default, the agent will use the standard non-privileged GITHUB_TOKEN which does not provide write access to the repo, and therefore cannot mark a PR as approved.

To have the agent APPROVE your PR, set GITHUB_REVIEW_TOKEN to a token with appropriate permissions.

In either case, if there are no findings, it will print an approval message.

If there are findings, it will mark the PR with CHANGES_REQUESTED.  Have your agent resolve the review threads and dismiss the review to continue.

### 1. Get your API key

For the default (`auto`, DeepSeek today), generate a DeepSeek API key. For `PROVIDER: codex`, generate an OpenAI key; for `PROVIDER: zai`, a Z.ai key.

### 2. Add the API key to your repository

1. Go to your GitHub repository  
2. Click **Settings**  
3. Navigate to **Secrets and variables → Actions**  
4. Click **New repository secret** and add:

   - **Name:** `DEEPSEEK_API_KEY` — **Value:** your DeepSeek API key (or `OPENAI_API_KEY` for `codex`, `ZAI_API_KEY` for `zai`)

## Claude Code configuration

Claude Code runs in non-interactive print mode with the Z.ai Anthropic-compatible endpoint:

- `ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic`
- `ANTHROPIC_AUTH_TOKEN` from `ZAI_API_KEY`

The action allows read/search-oriented tools for review and denies shell, web, and edit-oriented tools. Check out the pull request before running the action so Claude Code can inspect repository files. Claude Code records required changes through a local collector tool; the action validates those collected records before turning them into inline GitHub review comments. The action prints `❌ Request Changes` when required changes exist and `✅ Approved` when there are no required changes; it also submits a formal approval review when `GITHUB_REVIEW_TOKEN` is provided.

`GITHUB_REVIEW_TOKEN` is optional. Leave it unset for the default workflow: required changes request changes, and clean reviews finish successfully with `✅ Approved`. Set it to an approval-capable user or GitHub App token only when you want the action to submit a formal approval review.

## Advanced configuration

Instead of using default values for `ZAI_MODEL`, `ZAI_SYSTEM_PROMPT`, and `ZAI_REVIEWER_NAME`, you can override them, and manage them as GitHub Actions variables. This lets you update the model, review prompt, or reviewer name without touching the workflow file.

### 1. Add the variables to your repository

1. Go to your GitHub repository
2. Click **Settings**
3. Navigate to **Secrets and variables → Actions**
4. Click the **Variables** tab
5. Click **New repository variable** and add:

   - **Name:** `ZAI_MODEL` — **Value:** e.g. `glm-5.1`
   - **Name:** `ZAI_SYSTEM_PROMPT` — **Value:** your custom system prompt
   - **Name:** `ZAI_REVIEWER_NAME` — **Value:** e.g. `AI Code Review`

### 2. Reference them in your workflow

```yaml
      - name: Code Review
        uses: brandon-fryslie/zai-coding-agent-review@v1
        with:
          ZAI_API_KEY: ${{ secrets.ZAI_API_KEY }}
          ZAI_MODEL: ${{ vars.ZAI_MODEL }}
          ZAI_SYSTEM_PROMPT: ${{ vars.ZAI_SYSTEM_PROMPT }}
          ZAI_REVIEWER_NAME: ${{ vars.ZAI_REVIEWER_NAME }}
          GITHUB_REVIEW_TOKEN: ${{ secrets.GITHUB_REVIEW_TOKEN }}
```

## Whole-repo review mode (on-demand)

Set `MODE: repo` to review the **whole repository** instead of a pull request diff — an on-demand "give me an overall look at this repo" pass. There is no PR: the engine explores the checked-out working tree with its Read/Grep/Glob tools, and findings are printed as a report to the **GitHub Step Summary** and the run log (no inline comments, no review submitted, no `GITHUB_TOKEN` write access required). Unlike PR review — which only flags issues a diff introduces — a whole-repo review deliberately flags **pre-existing** issues, since that is the point.

Trigger it manually with `workflow_dispatch` and an optional `SCOPE` to focus the review:

```yaml
name: AI Whole-Repo Review

on:
  workflow_dispatch:
    inputs:
      scope:
        description: "Optional focus, e.g. 'the auth layer'. Leave blank for a broad review."
        required: false

permissions:
  contents: read

jobs:
  review:
    name: Whole-repo review
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v6

      - name: Whole-repo review
        uses: brandon-fryslie/zai-coding-agent-review@v1
        env:
          DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
        with:
          MODE: repo
          SCOPE: ${{ inputs.scope }}
```

Engine/provider selection (`PROVIDER`, `OPENAI_*`/`ZAI_*`/`DEEPSEEK_*`, `CONFIG_FILE`), `EXCLUDE_PATTERNS`, and cost reporting work exactly as in PR mode (per-PR config selection by label/body has no effect without a PR; use the `CONFIG` input to pick a named config). The run is informational and exits 0 regardless of findings.

> **Scale limit:** the review is a single tool-driven agent run, so a broad pass over a very large repository can exceed the agent's context. For large repos, pass a `SCOPE` to focus the review on one subsystem at a time.

## Fork pull requests are not reviewed

The action **never reviews pull requests opened from a fork** — i.e. any PR whose head repository differs from the base repository. Such a run is skipped cleanly (logged, exit 0, no review posted, no AI engine spawned), so untrusted outside contributions never spend the host repository's AI credits and the secret never meets fork-controlled diff content. This is unconditional: there is no input to enable fork review. Fork contributors review their own changes (or run their own reviewer with their own credentials).

For your own branches (head and base in the same repository), reviews run normally.

## Preflight diagnostic

Before spawning the engine, the action runs a cheap connectivity + auth probe against the selected provider's endpoint (a single `max_tokens: 1` request, ~1s, negligible cost). If the credential is wrong or expired, or the endpoint is unreachable or misconfigured, the run **fails fast with a precise cause** in the Actions log — e.g. `Preflight failed — no usable review provider. config 'deepseek-default': endpoint rejected the credential (HTTP 401) — the API key is missing, wrong, or expired.` — instead of failing cryptically deep inside the agent. With a failover chain, the run proceeds as long as **any** config is reachable; an unhealthy config is logged as a warning. Endpoint kinds without an observed probe (currently the `codex`/OpenAI-responses path) are reported as skipped rather than guessed at.

## Contributing

Contributions are welcome. See the [CONTRIBUTING](CONTRIBUTING.md) file for more information.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for more information.
