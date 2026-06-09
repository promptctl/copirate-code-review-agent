# Z.ai Coding Agent Review

AI-powered GitHub Pull Request code review using Claude Code with Z.ai Coding Plan credentials. The action runs Claude Code in the GitHub Actions runner, then submits a pull request review with inline review threads.

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
name: AI Code Review with Z.ai

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
        uses: brandon-fryslie/zai-coding-agent-review@0.1.1
        with:
          ZAI_API_KEY: ${{ secrets.ZAI_API_KEY }}
```

## Agent install instructions

Copy and paste this into the target repository to install the action:

```bash
mkdir -p .github/workflows
cat > .github/workflows/code-review.yml <<'YAML'
name: AI Code Review with Z.ai

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
        uses: brandon-fryslie/zai-coding-agent-review@0.1.1
        with:
          ZAI_API_KEY: ${{ secrets.ZAI_API_KEY }}
YAML
```

If the repository does not already have the secret, set it with GitHub CLI:

```bash
gh secret set ZAI_API_KEY --body "$ZAI_API_KEY"
```

Then commit the workflow:

```bash
git add .github/workflows/code-review.yml
git commit -m "Install Z.ai coding agent review action"
```

````

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `ZAI_API_KEY` | Yes | — | Your Z.ai API key |
| `ZAI_MODEL` | No | `glm-5.1` | Model passed to Claude Code |
| `ZAI_SYSTEM_PROMPT` | No | See below | Additional system prompt appended to Claude Code |
| `ZAI_REVIEWER_NAME` | No | `Z.ai Coding Agent Review` | Name shown in the review comment header |
| `EXCLUDE_PATTERNS` | No | `*.lock,package-lock.json,yarn.lock,pnpm-lock.yaml` | Comma-separated file patterns to exclude from review |
| `MAX_DIFF_CHARS` | No | `0` (unlimited) | Maximum total characters for the diff sent to Claude Code |
| `GITHUB_REVIEW_TOKEN` | No | — | Optional token for submitting reviews when `GITHUB_TOKEN` cannot approve pull requests |
| `PR_NUMBER` | No | from `pull_request` event | Pull request number to review. Auto-detected on `pull_request` events; pass explicitly on other events (e.g. `workflow_run`) |
| `HEAD_SHA` | No | from `pull_request` event | Head commit SHA the review is anchored to. Auto-detected on `pull_request` events; pass explicitly on other events |

The action fetches the changed files and posts the review through the GitHub API, keyed by `PR_NUMBER` — it does **not** require the pull request's code to be checked out (the checkout only gives the review agent surrounding context). That property is what makes the [fork-safe pattern](#reviewing-fork-pull-requests-safely) below possible.

The action installs its bundled reviewer instructions as Claude Code's user-global `CLAUDE.md` for each review run. Claude Code also loads repository instructions from the checked-out pull request project.

## Configuration

To use this action, add your Z.ai API key as a GitHub secret. The action maps it to Claude Code's Anthropic-compatible environment variables for the Z.ai Coding Plan endpoint.

## Operation

This action will provide code reviews for your PRs using z.ai coding plan.  

By default, the agent will use the standard non-privileged GITHUB_TOKEN which does not provide write access to the repo, and therefore cannot mark a PR as approved.

To have the agent APPROVE your PR, set GITHUB_REVIEW_TOKEN to a token with appropriate permissions.

In either case, if there are no findings, it will print an approval message.

If there are findings, it will mark the PR with CHANGES_REQUESTED.  Have your agent resolve the review threads and dismiss the review to continue.

### 1. Get your Z.ai API key

Generate an API key from your Z.ai dashboard.

### 2. Add the API key to your repository

1. Go to your GitHub repository  
2. Click **Settings**  
3. Navigate to **Secrets and variables → Actions**  
4. Click **New repository secret** and add:

   - **Name:** `ZAI_API_KEY` — **Value:** your Z.ai API key

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

## Reviewing fork pull requests safely

The quickstart workflow triggers on `pull_request` and works for branches pushed to your own repository. It does **not** review pull requests opened from forks: GitHub withholds repository secrets (including `ZAI_API_KEY`) from `pull_request` runs triggered by a fork, so the review step has no key.

The wrong way to fix this is `pull_request_target` with a checkout of the fork's head — that runs untrusted code in a job that holds your secret, the classic Actions exfiltration footgun. Do not do that.

The safe pattern is a two-workflow split. An untrusted job (no secret) records *which* PR to review; a trusted job (with the secret) does the review without ever checking out fork code. The action never needs the PR's code on disk — it reads the diff and posts the review through the API, keyed by `PR_NUMBER` — so the secret only ever meets inert data.

**1. Collector — `.github/workflows/code-review-collect.yml`** (runs untrusted, holds no secret):

```yaml
name: Collect PR coordinates

on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  collect:
    runs-on: ubuntu-latest
    steps:
      - name: Record PR coordinates
        run: |
          mkdir -p pr
          echo "${{ github.event.pull_request.number }}" > pr/number
          echo "${{ github.event.pull_request.head.sha }}" > pr/head_sha
      - uses: actions/upload-artifact@v4
        with:
          name: pr-coordinates
          path: pr/
```

**2. Reviewer — `.github/workflows/code-review.yml`** (runs trusted from the default branch, holds the secret, never checks out fork code):

```yaml
name: AI Code Review with Z.ai

on:
  workflow_run:
    workflows: ["Collect PR coordinates"]
    types: [completed]

permissions:
  contents: read
  actions: read          # read the collector run's artifact
  pull-requests: write   # post the review

jobs:
  review:
    if: github.event.workflow_run.conclusion == 'success'
    runs-on: ubuntu-latest
    steps:
      - name: Download PR coordinates
        uses: actions/download-artifact@v4
        with:
          name: pr-coordinates
          run-id: ${{ github.event.workflow_run.id }}
          github-token: ${{ secrets.GITHUB_TOKEN }}

      - name: Read coordinates
        id: pr
        run: |
          echo "number=$(cat number)" >> "$GITHUB_OUTPUT"
          echo "head_sha=$(cat head_sha)" >> "$GITHUB_OUTPUT"

      - name: Code Review
        uses: brandon-fryslie/zai-coding-agent-review@v1
        with:
          ZAI_API_KEY: ${{ secrets.ZAI_API_KEY }}
          PR_NUMBER: ${{ steps.pr.outputs.number }}
          HEAD_SHA: ${{ steps.pr.outputs.head_sha }}
```

The reviewer runs in the trusted base context (`workflow_run` always uses the workflow file and secrets of the default branch), so it has the key — but because it checks out nothing and receives only the PR number and head SHA as plain text, fork code never lands on the secret-bearing runner. Both workflow files must be on the default branch for `workflow_run` to fire. The review appears as its own "AI Code Review with Z.ai" run rather than inline in the PR's checks list — the standard `workflow_run` trade-off.

## Contributing

Contributions are welcome. See the [CONTRIBUTING](CONTRIBUTING.md) file for more information.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for more information.
