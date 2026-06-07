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
const CLAUDE_MAX_TURNS = '8';
const CLAUDE_ALLOWED_TOOLS = [
  'Read',
  'Grep',
  'Glob',
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

function buildPatchAnchors(file) {
  const anchors = new Set();
  let leftLine = 0;
  let rightLine = 0;

  for (const line of file.patch.split('\n')) {
    if (line.length === 0) {
      continue;
    }
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      leftLine = Number(hunk[1]);
      rightLine = Number(hunk[2]);
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      anchors.add(`${file.filename}:${rightLine}:RIGHT`);
      rightLine++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      anchors.add(`${file.filename}:${leftLine}:LEFT`);
      leftLine++;
    } else if (!line.startsWith('\\')) {
      anchors.add(`${file.filename}:${rightLine}:RIGHT`);
      leftLine++;
      rightLine++;
    }
  }

  return anchors;
}

function buildReviewAnchors(files) {
  return new Set(files.filter(f => f.patch).flatMap(f => [...buildPatchAnchors(f)]));
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
    const entry = `### ${f.filename} (${f.status})\n\`\`\`diff\n${f.patch}\n\`\`\``;
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
    prompt: `Review this pull request. Use the repository working tree for context and the diff below as the authoritative changed surface. Return only minified JSON with this exact shape: {"summary":"one concise sentence","findings":[{"path":"file path from diff","line":123,"side":"RIGHT","body":"actionable review comment"}]}. Use side RIGHT for added or unchanged lines and LEFT for deleted lines. Every finding must point to a line visible in the diff. Return {"summary":"No findings.","findings":[]} when there are no bugs, security issues, invariant/type violations, rough data/control flow, duplicate truth/enforcement, dependency cycles, temporal coupling, or missing behavior tests.\n\n${diffs}`,
  };
}

function buildClaudeArgs(model, systemPrompt) {
  const args = [
    '-y',
    `${CLAUDE_CODE_PACKAGE}@latest`,
    '-p',
    '--output-format',
    'json',
    '--no-session-persistence',
    '--max-turns',
    CLAUDE_MAX_TURNS,
    '--tools',
    'Read,Grep,Glob',
    '--allowedTools',
    CLAUDE_ALLOWED_TOOLS.join(','),
    '--disallowedTools',
    CLAUDE_DISALLOWED_TOOLS.join(','),
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

function parseClaudeOutput(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('Claude Code returned invalid JSON.');
  }

  if (parsed.is_error || parsed.subtype === 'error') {
    throw new Error(`Claude Code review failed: ${parsed.result || 'unknown error'}`);
  }

  if (typeof parsed.result !== 'string' || parsed.result.trim().length === 0) {
    throw new Error('Claude Code returned an empty review result.');
  }

  return parsed.result.trim();
}

function parseReview(review) {
  let parsed;
  try {
    parsed = JSON.parse(review);
  } catch {
    throw new Error('Claude Code returned review text that was not valid JSON.');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Claude Code returned a review JSON value with the wrong shape.');
  }

  if (typeof parsed.summary !== 'string' || parsed.summary.trim().length === 0) {
    throw new Error('Claude Code review JSON must include a non-empty summary.');
  }
  const summary = parsed.summary.trim();
  if (!Array.isArray(parsed.findings)) {
    throw new Error('Claude Code review JSON must include a findings array.');
  }

  const findings = parsed.findings.map((finding, index) => {
    if (!finding || typeof finding !== 'object' || Array.isArray(finding)) {
      throw new Error(`Claude Code finding ${index + 1} is not an object.`);
    }
    const pathValue = finding.path;
    const line = finding.line;
    const side = finding.side;
    const body = finding.body;
    if (typeof pathValue !== 'string' || pathValue.trim().length === 0) {
      throw new Error(`Claude Code finding ${index + 1} has an invalid path.`);
    }
    if (!Number.isInteger(line) || line <= 0) {
      throw new Error(`Claude Code finding ${index + 1} has an invalid line.`);
    }
    if (side !== 'RIGHT' && side !== 'LEFT') {
      throw new Error(`Claude Code finding ${index + 1} has an invalid side.`);
    }
    if (typeof body !== 'string' || body.trim().length === 0) {
      throw new Error(`Claude Code finding ${index + 1} has an invalid body.`);
    }
    return {
      path: pathValue.trim(),
      line,
      side,
      body: body.trim(),
    };
  });

  return { summary, findings };
}

function validateFindings(findings, anchors) {
  for (const finding of findings) {
    const anchor = `${finding.path}:${finding.line}:${finding.side}`;
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

function runClaudeCode(apiKey, model, systemPrompt, prompt, reviewerHome) {
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
    const child = spawn('npx', buildClaudeArgs(model, systemPrompt), {
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
          reject(new Error(`Claude Code exited with status ${code}: ${stderr.slice(-2000)}`));
          return;
        }
        try {
          resolve(parseClaudeOutput(stdout));
        } catch (err) {
          reject(err);
        }
      });
    });

    child.stdin.end(prompt);
  });
}

async function submitReview(octokit, owner, repo, pullNumber, commitId, reviewerName, review) {
  const event = review.findings.length > 0 ? 'REQUEST_CHANGES' : 'APPROVE';
  const body = `## ${reviewerName}\n\n${review.summary}\n\n${REVIEW_MARKER}`;
  const comments = review.findings.map(finding => ({
    path: finding.path,
    line: finding.line,
    side: finding.side,
    body: finding.body,
  }));
  const reviewRequest = {
    owner,
    repo,
    pull_number: pullNumber,
    commit_id: commitId,
    event,
    body,
  };

  // [LAW:single-enforcer] The action owns GitHub review transport; Claude owns only typed review judgment.
  await octokit.rest.pulls.createReview({
    ...reviewRequest,
    ...(comments.length > 0 ? { comments } : {}),
  });
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
    await submitReview(octokit, owner, repo, pullNumber, headSha, reviewerName, {
      summary: 'No patchable changes found after filtering.',
      findings: [],
    });
    core.info('Review approved because no patchable changes were found after filtering.');
    return;
  }

  const reviewInput = buildReviewInput(filteredFiles, maxDiffChars);
  const anchors = buildReviewAnchors(reviewInput.files);
  const reviewerHome = createReviewerHome();

  // [LAW:one-source-of-truth] Claude Code owns review judgment; the action owns GitHub transport.
  core.info(`Running Claude Code with Z.ai credentials for ${filteredFiles.length} file(s)...`);
  let reviewText;
  try {
    reviewText = await runClaudeCode(apiKey, model, systemPrompt, reviewInput.prompt, reviewerHome);
  } finally {
    // [LAW:no-ambient-temporal-coupling] The same owner that creates the reviewer home also tears it down.
    fs.rmSync(reviewerHome, { recursive: true });
  }
  const review = parseReview(reviewText);
  validateFindings(review.findings, anchors);
  await submitReview(octokit, owner, repo, pullNumber, headSha, reviewerName, review);
  core.info(review.findings.length > 0 ? 'Review requested changes.' : 'Review approved.');
}

run().catch(err => core.setFailed(err.message));
