const core = require('@actions/core');
const github = require('@actions/github');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ZAI_ANTHROPIC_BASE_URL = 'https://api.z.ai/api/anthropic';
const CLAUDE_CODE_PACKAGE = '@anthropic-ai/claude-code';
const REVIEW_MARKER = '<!-- zai-coding-agent-review -->';
const MAX_RESPONSE_SIZE = 1024 * 1024;
const CLAUDE_TIMEOUT_MS = 3_000_000;
const CLAUDE_ALLOWED_TOOLS = [
  'Read',
  'Grep',
  'Glob',
  'mcp__review_collector__request_change',
  'mcp__review_collector__finish_review',
];
const CLAUDE_DISALLOWED_TOOLS = [
  'Bash',
  'Edit',
  'Write',
  'WebFetch',
  'WebSearch',
];
const ACTION_ROOT = process.env.GITHUB_ACTION_PATH || path.join(__dirname, '..');
const REVIEW_AGENT_CLAUDE_PATH = path.join(ACTION_ROOT, 'review-agent', 'CLAUDE.md');
const APPROVED_MESSAGE = '✅ Approved';
const REQUEST_CHANGES_MESSAGE = '❌ Request Changes';
const COLLECTOR_SERVER_ARG = '--review-collector-server';

function matchesPattern(filename, pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\x00')
    .replace(/\*/g, '[^/]*')
    .replace(/\x00/g, '.*');
  const regex = new RegExp(`^${escaped}$`);
  const basename = filename.split('/').pop();
  return regex.test(filename) || regex.test(basename);
}

function filterFiles(files, excludePatterns) {
  if (!excludePatterns || excludePatterns.length === 0) {
    return files;
  }
  return files.filter(f => !excludePatterns.some(p => matchesPattern(f.filename, p)));
}

// [LAW:single-enforcer] GitHub's review `position` numbering is defined once here;
// the anchor table and the model-facing annotation both derive from it. GitHub
// counts position 1 at the line after the FIRST hunk header, and every later
// line — context, additions, deletions, and subsequent @@ headers — advances the
// count. Only the first header is the baseline; treating every header as
// skippable (as a naive reader would) drifts comments off by one per extra hunk.
function* patchPositions(patch) {
  let position = 0;
  let seenHunk = false;

  for (const line of patch.split('\n')) {
    if (line.length === 0) {
      continue;
    }
    if (!seenHunk) {
      seenHunk = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line);
      yield { kind: 'baseline', line };
      continue;
    }
    position++;
    yield { kind: 'positioned', position, line };
  }
}

function buildPatchAnchors(file) {
  const anchors = new Map();
  for (const entry of patchPositions(file.patch)) {
    if (entry.kind !== 'positioned') {
      continue;
    }
    anchors.set(`${file.filename}:${entry.position}`, { path: file.filename, position: entry.position });
  }
  return anchors;
}

function buildReviewAnchors(files) {
  return new Map(files.filter(f => f.patch).flatMap(f => [...buildPatchAnchors(f)]));
}

function annotatePatchWithPositions(patch) {
  const lines = [];
  for (const entry of patchPositions(patch)) {
    lines.push(entry.kind === 'positioned' ? `POSITION ${entry.position}: ${entry.line}` : entry.line);
  }
  return lines.join('\n');
}

async function getChangedFiles(octokit, owner, repo, pullNumber) {
  const files = [];
  let page = 1;
  while (true) {
    const { data } = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
      page,
    });
    files.push(...data);
    if (data.length < 100) break;
    page++;
  }
  return files;
}

function buildReviewInput(files, maxDiffChars) {
  const patchableFiles = files.filter(f => f.patch);
  const includedDiffs = [];
  const includedFiles = [];
  const skippedFiles = [];
  let totalChars = 0;

  for (const f of patchableFiles) {
    const entry = `### ${f.filename} (${f.status})\n\`\`\`diff\n${annotatePatchWithPositions(f.patch)}\n\`\`\``;
    if (maxDiffChars > 0 && totalChars + entry.length > maxDiffChars) {
      skippedFiles.push(f.filename);
    } else {
      includedDiffs.push(entry);
      includedFiles.push(f);
      totalChars += entry.length;
    }
  }

  let diffs = includedDiffs.join('\n\n');

  if (skippedFiles.length > 0) {
    diffs += `\n\n> **Note:** The following files were excluded because the diff exceeded the \`MAX_DIFF_CHARS\` limit:\n${skippedFiles.map(f => `> - ${f}`).join('\n')}`;
  }

  return {
    // [LAW:one-source-of-truth] The same included files define Claude's visible diff and valid review anchors.
    files: includedFiles,
    prompt: `
Review this pull request. Use the repository working tree for context and the diff below as the authoritative changed surface.
    Each visible diff line is annotated as POSITION N. Call mcp__review_collector__request_change only for code that must change before merge.
    Every requested change must use path, position, and body with the displayed POSITION value. When the review is complete,
    call mcp__review_collector__finish_review exactly once with a concise summary. The collector tools are the only review output channel.

    You review against the LAWS in your guidance. You flag violations; you do not fix them. A change MUST change before merge only if this
    diff introduces or worsens a LAW violation, or introduces a correctness bug. Pre-existing violations in unchanged code, and matters of
    taste the laws do not cover, are NOT request_change material — mention the significant ones in the finish_review summary instead.

    You can ONLY attach a comment to a line shown as POSITION N — that is, a line this diff changed. You cannot comment on unchanged code;
    GitHub does not allow it. When the diff introduces a violation whose root cause sits in unchanged code (e.g. it feeds a bad state into
    an existing guard, or relies on an existing loose type), attach the comment to the changed POSITION that is responsible for the new
    problem and explain the upstream link in the body. If a finding cannot be tied to any changed POSITION, it goes in the finish_review
    summary, not a request_change.

    Each request_change body has three parts, in order: (1) the token, e.g. [LAW:dataflow-not-control-flow]; (2) one sentence naming the
    specific violation on that line; (3) the concrete fix. Keep it short. One comment per distinct issue — do not repeat the same finding
    across many lines; flag the clearest instance and note the pattern once.

    Priorities, highest first:
    - [LAW:dataflow-not-control-flow] — the most common and most important violation to catch. Flag: a new \`if\`/\`switch\` that selects WHICH
      operation runs rather than letting data decide the result; a guard that makes an operation sometimes-run, sometimes-skip (especially
      \`if (x) { ...work... }\` with no else — that is [LAW:no-defensive-null-guards] too); branching on a mode/flag instead of passing a
      value; logic whose described mechanics need "if / and / when / skip / only". Fix toward: the operation always runs, variability moves
      into the values flowing through it.
    - [LAW:decomposition] / [LAW:composability] — a new function that does more than one thing (needs "and" to describe), or hardcodes a
      caller-specific choice that should be a parameter. Fix toward: split, or lift the choice to the seam as a value.
    - [LAW:types-are-the-program] — a new type that admits illegal states (\`any\`, \`string\` for an enum, fields that must agree but aren't
      tied), or a body that branches/guards to compensate for a too-loose type. Fix toward: tighten the type so the bad state cannot compile.
    - [LAW:effects-at-boundaries] — new code mixing computation with IO/mutation/network/clock/randomness in the same unit. Fix toward:
      pure core, effects at the edge.
    - [LAW:no-silent-failure] — newly introduced swallowed errors, \`|| true\`, \`2>/dev/null\`, empty catches, or meaning-changing fallbacks.
    - [LAW:one-source-of-truth] / [LAW:single-enforcer] — a new second home for an existing fact, or a duplicated enforcement check.
    - [LAW:no-ambient-temporal-coupling], [LAW:behavior-not-structure], and the remaining laws — flag when the diff clearly violates them.

    Do not invent rules beyond the laws. Do not request changes for style, naming preference, or speculative concerns. When unsure whether
    something rises to must-change, it does not — leave it for the summary. The finish_review summary describes the nature of any must-change
    items and any pattern-level or pre-existing concerns worth the author's attention. Do NOT state an overall verdict, approval status, or
    must-change count — the action derives the verdict from the recorded changes and appends it itself.
    \n\n${diffs}`,
  };
}

function buildClaudeArgs(model, systemPrompt, mcpConfigPath) {
  const args = [
    '-y',
    `${CLAUDE_CODE_PACKAGE}@latest`,
    '-p',
    '--output-format',
    'json',
    '--no-session-persistence',
    '--tools',
    'Read,Grep,Glob',
    '--allowedTools',
    CLAUDE_ALLOWED_TOOLS.join(','),
    '--disallowedTools',
    CLAUDE_DISALLOWED_TOOLS.join(','),
    '--mcp-config',
    mcpConfigPath,
    '--strict-mcp-config',
    '--permission-mode',
    'dontAsk',
  ];

  if (model) {
    args.push('--model', model);
  }

  if (systemPrompt) {
    args.push('--append-system-prompt', systemPrompt);
  }

  args.push('Review the pull request instructions and diff from stdin.');

  return args;
}

function assertClaudeSucceeded(stdout) {
  const parsed = parseJsonEnvelope(stdout);
  if (!parsed) {
    throw new Error(`Claude Code returned invalid JSON.\n\n${formatOutputTail('stdout tail', stdout)}`);
  }

  if (parsed.is_error || parsed.subtype === 'error') {
    throw new Error(`Claude Code review failed: ${parsed.result || 'unknown error'}`);
  }
}

function parseJsonEnvelope(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    const trimmed = stdout.trim();
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      return undefined;
    }
    try {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    } catch {
      return undefined;
    }
  }
}

function parseReviewValue(parsed, context) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${context} has the wrong shape.`);
  }

  if (typeof parsed.summary !== 'string' || parsed.summary.trim().length === 0) {
    throw new Error(`${context} must include a non-empty summary.`);
  }
  const summary = parsed.summary.trim();
  if (!Array.isArray(parsed.findings)) {
    throw new Error(`${context} must include a findings array.`);
  }

  const findings = parsed.findings.map((finding, index) => {
    if (!finding || typeof finding !== 'object' || Array.isArray(finding)) {
      throw new Error(`Claude Code finding ${index + 1} is not an object.`);
    }
    const pathValue = finding.path;
    const position = finding.position;
    const body = finding.body;
    if (typeof pathValue !== 'string' || pathValue.trim().length === 0) {
      throw new Error(`Claude Code finding ${index + 1} has an invalid path.`);
    }
    if (!Number.isInteger(position) || position <= 0) {
      throw new Error(`Claude Code finding ${index + 1} has an invalid position.`);
    }
    if (typeof body !== 'string' || body.trim().length === 0) {
      throw new Error(`Claude Code finding ${index + 1} has an invalid body.`);
    }
    return {
      path: pathValue.trim(),
      position,
      body: body.trim(),
    };
  });

  return { summary, findings };
}

function parseFindingValue(finding, index) {
  return parseReviewValue({
    summary: 'collector finding',
    findings: [finding],
  }, `Review collector finding ${index + 1}`).findings[0];
}

function validateFindings(findings, anchors) {
  for (const finding of findings) {
    const anchor = `${finding.path}:${finding.position}`;
    if (!anchors.has(anchor)) {
      throw new Error(`Claude Code finding references a line outside the review diff: ${anchor}`);
    }
  }
}

function createReviewerHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zai-reviewer-home-'));
  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  // [LAW:single-enforcer] The packaged action owns reusable reviewer instructions.
  fs.copyFileSync(REVIEW_AGENT_CLAUDE_PATH, path.join(claudeDir, 'CLAUDE.md'));
  return home;
}

function createReviewCollector() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zai-review-collector-'));
  const recordsPath = path.join(dir, 'records.jsonl');
  const mcpConfigPath = path.join(dir, 'mcp.json');
  const mcpConfig = {
    mcpServers: {
      review_collector: {
        command: process.execPath,
        args: [__filename, COLLECTOR_SERVER_ARG],
        env: {
          REVIEW_COLLECTOR_RECORDS: recordsPath,
        },
      },
    },
  };
  fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig), 'utf8');
  return { dir, recordsPath, mcpConfigPath };
}

function readCollectedReview(recordsPath) {
  if (!fs.existsSync(recordsPath)) {
    throw new Error('Claude Code did not call the review collector tools.');
  }

  const records = fs.readFileSync(recordsPath, 'utf8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line));
  const finishes = records.filter(record => record.type === 'finish');
  if (finishes.length !== 1) {
    throw new Error(`Claude Code must call finish_review exactly once; saw ${finishes.length}.`);
  }
  const findings = records
    .filter(record => record.type === 'request_change')
    .map((record, index) => parseFindingValue(record.finding, index));
  return parseReviewValue({
    summary: finishes[0].summary,
    findings,
  }, 'Review collector output');
}

function runClaudeCode(apiKey, model, systemPrompt, prompt, reviewerHome, mcpConfigPath) {
  return new Promise((resolve, reject) => {
    // [LAW:single-enforcer] Z.ai auth is translated exactly once at the agent runner boundary.
    const env = {
      ...process.env,
      HOME: reviewerHome,
      ANTHROPIC_AUTH_TOKEN: apiKey,
      ANTHROPIC_BASE_URL: ZAI_ANTHROPIC_BASE_URL,
      ANTHROPIC_MODEL: model,
      API_TIMEOUT_MS: String(CLAUDE_TIMEOUT_MS),
      CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1',
      NO_COLOR: '1',
    };
    const args = buildClaudeArgs(model, systemPrompt, mcpConfigPath);
    const child = spawn('npx', args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = result => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      result();
    };

    const timeout = setTimeout(() => {
      finish(() => {
        child.kill('SIGTERM');
        reject(new Error('Claude Code review timed out.'));
      });
    }, CLAUDE_TIMEOUT_MS);

    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.length > MAX_RESPONSE_SIZE) {
        finish(() => {
          child.kill('SIGTERM');
          reject(new Error('Claude Code response exceeded size limit.'));
        });
      }
    });

    child.stderr.on('data', chunk => {
      stderr += chunk;
      if (stderr.length > MAX_RESPONSE_SIZE) {
        stderr = stderr.slice(-MAX_RESPONSE_SIZE);
      }
    });

    child.on('error', err => {
      finish(() => reject(err));
    });

    child.on('close', code => {
      finish(() => {
        if (code !== 0) {
          reject(new Error(formatClaudeFailure(code, args, stdout, stderr)));
          return;
        }
        try {
          assertClaudeSucceeded(stdout);
          resolve();
        } catch (err) {
          reject(err);
        }
      });
    });

    child.stdin.end(prompt);
  });
}

function formatOutputTail(label, value) {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return `${label}: <empty>`;
  }
  return `${label}:\n${trimmed.slice(-4000)}`;
}

function formatClaudeFailure(code, args, stdout, stderr) {
  return [
    `Claude Code exited with status ${code}.`,
    `Command: npx ${args.map(arg => JSON.stringify(arg)).join(' ')}`,
    formatOutputTail('stderr tail', stderr),
    formatOutputTail('stdout tail', stdout),
  ].join('\n\n');
}

function writeJsonRpcResponse(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function writeJsonRpcError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

function appendCollectorRecord(record) {
  const recordsPath = process.env.REVIEW_COLLECTOR_RECORDS;
  if (!recordsPath) {
    throw new Error('REVIEW_COLLECTOR_RECORDS is required.');
  }
  fs.appendFileSync(recordsPath, `${JSON.stringify(record)}\n`, 'utf8');
}

function collectorTools() {
  return [
    {
      name: 'request_change',
      description: 'Request a required pre-merge code change anchored to a visible diff line. Do not use for praise, good architecture, neutral observations, optional improvements, style preferences, or non-blocking notes.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          position: { type: 'integer' },
          body: { type: 'string' },
        },
        required: ['path', 'position', 'body'],
        additionalProperties: false,
      },
    },
    {
      name: 'finish_review',
      description: 'Finish the review after all required changes have been requested.',
      inputSchema: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
        },
        required: ['summary'],
        additionalProperties: false,
      },
    },
  ];
}

function callCollectorTool(name, args) {
  if (name === 'request_change') {
    const finding = parseFindingValue(args, 0);
    appendCollectorRecord({ type: 'request_change', finding });
    return { content: [{ type: 'text', text: 'Required change recorded.' }] };
  }
  if (name === 'finish_review') {
    if (!args || typeof args.summary !== 'string' || args.summary.trim().length === 0) {
      throw new Error('finish_review requires a non-empty summary.');
    }
    appendCollectorRecord({ type: 'finish', summary: args.summary.trim() });
    return { content: [{ type: 'text', text: 'Review finished.' }] };
  }
  throw new Error(`Unknown review collector tool: ${name}`);
}

function handleCollectorMessage(message) {
  if (!message || typeof message !== 'object') {
    return;
  }
  if (message.id === undefined) {
    return;
  }

  try {
    if (message.method === 'initialize') {
      writeJsonRpcResponse(message.id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'zai-review-collector', version: '0.1.0' },
      });
    } else if (message.method === 'tools/list') {
      writeJsonRpcResponse(message.id, { tools: collectorTools() });
    } else if (message.method === 'tools/call') {
      const result = callCollectorTool(message.params?.name, message.params?.arguments || {});
      writeJsonRpcResponse(message.id, result);
    } else {
      writeJsonRpcError(message.id, -32601, `Unknown method: ${message.method}`);
    }
  } catch (err) {
    writeJsonRpcError(message.id, -32000, err.message);
  }
}

function runReviewCollectorServer() {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (line.trim().length === 0) {
        continue;
      }
      try {
        const message = JSON.parse(line);
        const messages = Array.isArray(message) ? message : [message];
        for (const item of messages) {
          handleCollectorMessage(item);
        }
      } catch {
        writeJsonRpcError(null, -32700, 'Invalid JSON-RPC message.');
      }
    }
  });
}

// [LAW:dataflow-not-control-flow] A review is ALWAYS posted to the PR. The data
// (findings present? token approval-capable?) selects only the GitHub event —
// never whether the message is posted. canApprove gates APPROVE vs COMMENT
// because the default GITHUB_TOKEN cannot submit a formal approval, but a
// visible "✅ Approved" message must still land on the PR either way.
function reviewEvent(requestsChanges, canApprove) {
  return requestsChanges ? 'REQUEST_CHANGES' : (canApprove ? 'APPROVE' : 'COMMENT');
}

async function submitReview(octokit, owner, repo, pullNumber, commitId, reviewerName, review, canApprove) {
  // [LAW:one-source-of-truth] One boolean drives both the GitHub event and the
  // rendered verdict, so they cannot disagree. The model never states the verdict.
  const requestsChanges = review.findings.length > 0;
  const event = reviewEvent(requestsChanges, canApprove);
  const verdict = requestsChanges ? REQUEST_CHANGES_MESSAGE : APPROVED_MESSAGE;
  const body = `## ${reviewerName}\n\n${review.summary}\n\n${verdict}\n\n${REVIEW_MARKER}`;
  const comments = review.findings.map(finding => ({
    path: finding.path,
    position: finding.position,
    body: finding.body,
  }));

  // [LAW:single-enforcer] The action owns GitHub review transport; Claude owns only typed review judgment.
  await octokit.rest.pulls.createReview({
    owner,
    repo,
    pull_number: pullNumber,
    commit_id: commitId,
    event,
    body,
    ...(comments.length > 0 ? { comments } : {}),
  });
  core.info(verdict);
}

async function run() {
  const apiKey = core.getInput('ZAI_API_KEY', { required: true });
  core.setSecret(apiKey);
  const model = core.getInput('ZAI_MODEL');
  const systemPrompt = core.getInput('ZAI_SYSTEM_PROMPT');
  const reviewerName = core.getInput('ZAI_REVIEWER_NAME');
  const excludePatterns = core.getInput('EXCLUDE_PATTERNS')
    .split(',')
    .map(p => p.trim())
    .filter(p => p.length > 0);
  const maxDiffChars = parseInt(core.getInput('MAX_DIFF_CHARS'), 10) || 0;
  const token = core.getInput('GITHUB_TOKEN');
  core.setSecret(token);
  const reviewToken = core.getInput('GITHUB_REVIEW_TOKEN');
  if (reviewToken) {
    core.setSecret(reviewToken);
  }

  const { context } = github;
  const { owner, repo } = context.repo;
  const pullRequest = context.payload.pull_request;
  const pullNumber = pullRequest?.number;
  const headSha = pullRequest?.head?.sha;

  if (!pullNumber || !headSha) {
    core.setFailed('This action only runs on pull_request events.');
    return;
  }

  const octokit = github.getOctokit(token);
  const reviewOctokit = github.getOctokit(reviewToken || token);

  core.info(`Fetching changed files for PR #${pullNumber}...`);
  const files = await getChangedFiles(octokit, owner, repo, pullNumber);

  const filteredFiles = filterFiles(files, excludePatterns);

  if (excludePatterns.length > 0) {
    const excluded = files.length - filteredFiles.length;
    if (excluded > 0) {
      core.info(`Excluded ${excluded} file(s) matching EXCLUDE_PATTERNS.`);
    }
  }

  const patchableFiles = filteredFiles.filter(f => f.patch);

  if (patchableFiles.length === 0) {
    await submitReview(reviewOctokit, owner, repo, pullNumber, headSha, reviewerName, {
      summary: 'No patchable changes found after filtering.',
      findings: [],
    }, Boolean(reviewToken));
    return;
  }

  const reviewInput = buildReviewInput(filteredFiles, maxDiffChars);
  const anchors = buildReviewAnchors(reviewInput.files);
  const reviewerHome = createReviewerHome();
  const collector = createReviewCollector();

  // [LAW:one-source-of-truth] Claude Code owns review judgment; the action owns GitHub transport.
  core.info(`Running PR review for ${filteredFiles.length} file(s)...`);
  try {
    await runClaudeCode(apiKey, model, systemPrompt, reviewInput.prompt, reviewerHome, collector.mcpConfigPath);
    const review = readCollectedReview(collector.recordsPath);
    validateFindings(review.findings, anchors);
    await submitReview(reviewOctokit, owner, repo, pullNumber, headSha, reviewerName, review, Boolean(reviewToken));
  } finally {
    // [LAW:no-ambient-temporal-coupling] The same owner that creates temporary review state also tears it down.
    fs.rmSync(reviewerHome, { recursive: true });
    fs.rmSync(collector.dir, { recursive: true });
  }
}

if (process.argv.includes(COLLECTOR_SERVER_ARG)) {
  runReviewCollectorServer();
} else {
  run().catch(err => core.setFailed(err.message));
}
