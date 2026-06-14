# Z.ai Coding Agent Review

AI-powered GitHub Pull Request code review. By default it runs the **Codex engine against OpenAI**; it can also run Claude Code against the Z.ai Coding Plan. The engine is chosen explicitly via the `PROVIDER` input — never inferred from which credential you set. The action runs in the GitHub Actions runner, then submits a pull request review with inline review threads.

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
          # PROVIDER defaults to 'codex' (OpenAI). Set PROVIDER: zai to run Claude Code
          # against Z.ai instead (and pass ZAI_API_KEY rather than OPENAI_API_KEY).
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
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
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
YAML
```

If the repository does not already have the secret, set it with GitHub CLI:

```bash
gh secret set OPENAI_API_KEY --body "$OPENAI_API_KEY"
```

Then commit the workflow:

```bash
git add .github/workflows/code-review.yml
git commit -m "Install Z.ai coding agent review action"
```

````

## Inputs

The engine is selected by `PROVIDER` alone. Each provider needs its own credential; the **presence** of a credential never selects the provider.

| Input | Required | Default | Description |
|---|---|---|---|
| `PROVIDER` | No | `codex` | Engine in simple mode: `codex` (OpenAI) or `zai` (Claude Code against Z.ai). Ignored when a `CONFIG_FILE` exists. |
| `OPENAI_API_KEY` | When `PROVIDER=codex` | — | OpenAI API key for the default `codex` provider |
| `OPENAI_MODEL` | No | `gpt-5.4-mini` | Model for the `codex` provider |
| `OPENAI_REASONING_EFFORT` | No | — | `minimal`, `low`, `medium`, `high`, or `xhigh` for the `codex` provider |
| `OPENAI_BASE_URL` | No | `https://api.openai.com/v1` | OpenAI-Responses-compatible endpoint (e.g. Azure OpenAI or a gateway) |
| `ZAI_API_KEY` | When `PROVIDER=zai` | — | Z.ai API key for the `zai` provider |
| `ZAI_MODEL` | No | `glm-5.1` | Model for the `zai` provider |
| `ZAI_BASE_URL` | No | `https://api.z.ai/api/anthropic` | Anthropic-compatible endpoint for the `zai` provider |
| `ZAI_SYSTEM_PROMPT` | No | See below | Additional system prompt appended to Claude Code (`zai` provider) |
| `ZAI_REVIEWER_NAME` | No | `Z.ai Coding Agent Review` | Name shown in the review comment header |
| `CONFIG_FILE` | No | `.github/review-agents.yml` | Multi-engine config file. When it exists it owns engine selection and the `PROVIDER`/key inputs above are ignored. |
| `CONFIG` | No | — | Select a named config from the config file, overriding its `default` |
| `EXCLUDE_PATTERNS` | No | `*.lock,package-lock.json,yarn.lock,pnpm-lock.yaml` | Comma-separated file patterns to exclude from review |
| `MAX_DIFF_CHARS` | No | `0` (unlimited) | Maximum total characters for the diff sent to the engine |
| `GITHUB_REVIEW_TOKEN` | No | — | Optional token for submitting reviews when `GITHUB_TOKEN` cannot approve pull requests |
| `PR_NUMBER` | No | from `pull_request` event | Pull request number to review. Auto-detected on `pull_request` events; pass explicitly on other events (e.g. `workflow_run`) |
| `HEAD_SHA` | No | from `pull_request` event | Head commit SHA the review is anchored to. Auto-detected on `pull_request` events; pass explicitly on other events |

The action fetches the changed files and posts the review through the GitHub API, keyed by `PR_NUMBER` — it does **not** require the pull request's code to be checked out (the checkout only gives the review agent surrounding context). Pull requests from forks are [never reviewed](#fork-pull-requests-are-not-reviewed).

The action installs its bundled reviewer instructions as Claude Code's user-global `CLAUDE.md` for each review run. Claude Code also loads repository instructions from the checked-out pull request project.

## Configuration

The default provider is `codex`: add an `OPENAI_API_KEY` secret and the action runs the Codex engine against OpenAI. To run Claude Code against the Z.ai Coding Plan instead, set `PROVIDER: zai` and supply `ZAI_API_KEY`. Having both keys set is harmless — only `PROVIDER` decides which engine runs.

To run a different provider per pull request (by label or PR-body directive) or to chain failover engines, commit a `.github/review-agents.yml` config file; when present it owns engine selection and the `PROVIDER`/key inputs are ignored.

## Operation

This action provides code reviews for your PRs using the Codex/OpenAI engine by default, or Claude Code against the Z.ai Coding Plan when `PROVIDER: zai` is set.  

By default, the agent will use the standard non-privileged GITHUB_TOKEN which does not provide write access to the repo, and therefore cannot mark a PR as approved.

To have the agent APPROVE your PR, set GITHUB_REVIEW_TOKEN to a token with appropriate permissions.

In either case, if there are no findings, it will print an approval message.

If there are findings, it will mark the PR with CHANGES_REQUESTED.  Have your agent resolve the review threads and dismiss the review to continue.

### 1. Get your API key

For the default `codex` provider, generate an OpenAI API key. For `PROVIDER: zai`, generate an API key from your Z.ai dashboard.

### 2. Add the API key to your repository

1. Go to your GitHub repository  
2. Click **Settings**  
3. Navigate to **Secrets and variables → Actions**  
4. Click **New repository secret** and add:

   - **Name:** `OPENAI_API_KEY` — **Value:** your OpenAI API key (or `ZAI_API_KEY` for the `zai` provider)

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
        uses: brandon-fryslie/zai-coding-agent-review@0.1.1
        with:
          ZAI_API_KEY: ${{ secrets.ZAI_API_KEY }}
          ZAI_MODEL: ${{ vars.ZAI_MODEL }}
          ZAI_SYSTEM_PROMPT: ${{ vars.ZAI_SYSTEM_PROMPT }}
          ZAI_REVIEWER_NAME: ${{ vars.ZAI_REVIEWER_NAME }}
          GITHUB_REVIEW_TOKEN: ${{ secrets.GITHUB_REVIEW_TOKEN }}
```

## Fork pull requests are not reviewed

The action **never reviews pull requests opened from a fork** — i.e. any PR whose head repository differs from the base repository. Such a run is skipped cleanly (logged, exit 0, no review posted, no AI engine spawned), so untrusted outside contributions never spend the host repository's AI credits and the secret never meets fork-controlled diff content. This is unconditional: there is no input to enable fork review. Fork contributors review their own changes (or run their own reviewer with their own credentials).

For your own branches (head and base in the same repository), reviews run normally.

## Contributing

Contributions are welcome. See the [CONTRIBUTING](CONTRIBUTING.md) file for more information.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for more information.
