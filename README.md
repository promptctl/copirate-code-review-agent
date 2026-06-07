# Z.ai Coding Agent Review

AI-powered GitHub Pull Request code review using Claude Code with Z.ai Coding Plan credentials. The action runs Claude Code in the GitHub Actions runner, then submits a pull request review with inline review threads.

## Features

- Detect bugs
- Suggest improvements
- Use bundled reviewer `CLAUDE.md` instructions
- Leave inline review threads on specific findings
- Request changes when findings exist, otherwise approve the pull request

## Quickstart

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

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `ZAI_API_KEY` | Yes | — | Your Z.ai API key |
| `ZAI_MODEL` | No | `glm-5.1` | Model passed to Claude Code |
| `ZAI_SYSTEM_PROMPT` | No | See below | Additional system prompt appended to Claude Code |
| `ZAI_REVIEWER_NAME` | No | `Z.ai Coding Agent Review` | Name shown in the review comment header |
| `EXCLUDE_PATTERNS` | No | `*.lock,package-lock.json,yarn.lock,pnpm-lock.yaml` | Comma-separated file patterns to exclude from review |
| `MAX_DIFF_CHARS` | No | `0` (unlimited) | Maximum total characters for the diff sent to Claude Code |

The default appended system prompt is:

> Review according to the repository LAWS. Find bugs, security flaws, invariant/type violations, rough data/control flow, duplicate truth/enforcement, dependency cycles, temporal coupling, and missing behavior tests. Return concise actionable findings with file/line evidence.

The action installs its bundled reviewer instructions as Claude Code's user-global `CLAUDE.md` for each review run. Claude Code also loads repository instructions from the checked-out pull request project. You can override the appended prompt to focus on specific concerns, enforce coding standards, or adjust the review tone, e.g.:

> You are a security-focused code reviewer. Identify vulnerabilities, unsafe patterns, and authentication issues. Skip style comments.

## Configuration

To use this action, add your Z.ai API key as a GitHub secret. The action maps it to Claude Code's Anthropic-compatible environment variables for the Z.ai Coding Plan endpoint.

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

The action allows read/search-oriented tools for review and denies shell, web, and edit-oriented tools. Check out the pull request before running the action so Claude Code can inspect repository files. Review findings become inline GitHub review comments, and the action requests changes when findings exist or approves the pull request when there are no findings.

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
```

## Contributing

Contributions are welcome. See the [CONTRIBUTING](CONTRIBUTING.md) file for more information.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for more information.
