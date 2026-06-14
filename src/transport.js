'use strict';
const core = require('@actions/core');
const { parseUnifiedDiff } = require('./diff');

const REVIEW_MARKER = '<!-- zai-coding-agent-review -->';
const APPROVED_MESSAGE = '✅ Approved';
const REQUEST_CHANGES_MESSAGE = '❌ Request Changes';

async function listAllFiles(octokit, owner, repo, pullNumber) {
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

// [LAW:one-type-per-behavior] One transport; the host differs only in how the diff is
// sourced and how a finding's new-file line becomes a review comment.
// [LAW:dataflow-not-control-flow] Capability — does listFiles carry per-file patch? —
// selects the instance, not a hardcoded hostname (GitHub & Enterprise carry it; Gitea does not).
function gitHubTransport(files) {
  return { files, toComment: f => ({ path: f.path, line: f.line, side: 'RIGHT', body: f.body }) };
}

function giteaTransport(files) {
  return { files, toComment: f => ({ path: f.path, new_position: f.line, body: f.body }) };
}

async function selectTransport(octokit, owner, repo, pullNumber) {
  const files = await listAllFiles(octokit, owner, repo, pullNumber);
  if (files.length === 0 || files.some(f => typeof f.patch === 'string')) {
    return gitHubTransport(files);
  }
  // [LAW:no-silent-failure] Gitea omits per-file patch; its unified .diff carries the hunks.
  const { data } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}.diff', {
    owner,
    repo,
    pull_number: pullNumber,
  });
  const parsed = parseUnifiedDiff(typeof data === 'string' ? data : String(data));
  if (parsed.length === 0) {
    throw new Error(`No reviewable diff for PR #${pullNumber}: listFiles returned no patch and the unified diff was empty.`);
  }
  return giteaTransport(parsed);
}

// [LAW:dataflow-not-control-flow] A review is ALWAYS posted to the PR. The data
// (findings present? token approval-capable?) selects only the GitHub event —
// never whether the message is posted. canApprove gates APPROVE vs COMMENT
// because the default GITHUB_TOKEN cannot submit a formal approval, but a
// visible "✅ Approved" message must still land on the PR either way.
function reviewEvent(requestsChanges, canApprove) {
  return requestsChanges ? 'REQUEST_CHANGES' : (canApprove ? 'APPROVE' : 'COMMENT');
}

async function submitReview(octokit, owner, repo, pullNumber, commitId, reviewerName, review, canApprove, transport, attributionFooter) {
  // [LAW:one-source-of-truth] One boolean drives both the GitHub event and the
  // rendered verdict, so they cannot disagree. The model never states the verdict.
  const requestsChanges = review.findings.length > 0;
  const event = reviewEvent(requestsChanges, canApprove);
  const verdict = requestsChanges ? REQUEST_CHANGES_MESSAGE : APPROVED_MESSAGE;
  const footer = attributionFooter ? `\n\n${attributionFooter}` : '';
  const body = `## ${reviewerName}\n\n${review.summary}\n\n${verdict}${footer}\n\n${REVIEW_MARKER}`;
  const comments = review.findings.map(finding => transport.toComment(finding));

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

// [LAW:single-enforcer] One resolver decides which pull request to review, from
// whichever provenance the triggering event offers. pull_request / pull_request_target
// carry the PR in the event payload; other events (workflow_run, workflow_dispatch)
// carry no PR, so the caller passes PR_NUMBER / HEAD_SHA explicitly. Explicit inputs win
// when present; the event payload is the zero-config default. Neither present is a loud
// failure upstream, never a silent skip. [LAW:no-silent-failure]
function resolveReviewTarget(numberInput, headShaInput, payload) {
  const pr = payload.pull_request;
  return {
    pullNumber: numberInput ? Number(numberInput) : pr?.number,
    headSha: headShaInput || pr?.head?.sha,
  };
}

// [LAW:effects-at-boundaries] Pure: a PR is from a fork when its head repository is not
// the base repository, compared by stable numeric repo id (rename-safe).
//
// The two absent-repo cases are NOT the same and must not be folded together:
//   - head.repo == null is a real domain state — the source fork was deleted — and the
//     only correct answer is "fork": there is no trusted same-repo source to review.
//     [LAW:no-defensive-null-guards] a real optional value with a meaningful outcome.
//   - base.repo absent is impossible for a well-formed PR (every PR has a base repository).
//     Treating it as "fork" would silently turn malformed data into a skipped review, so we
//     reject it loudly instead and let the boundary report it. [LAW:no-silent-failure]
function prIsFromFork(pr) {
  const baseRepo = pr.base?.repo;
  if (!baseRepo) {
    throw new Error('PR data has no base repository; cannot determine fork status.');
  }
  const headRepo = pr.head?.repo;
  if (!headRepo) return true;
  return headRepo.id !== baseRepo.id;
}

module.exports = {
  gitHubTransport,
  giteaTransport,
  selectTransport,
  submitReview,
  resolveReviewTarget,
  prIsFromFork,
};
