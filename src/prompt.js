'use strict';
const { annotatePatchWithLines } = require('./diff');

// toolNames is required; callers supply adapter.toolNames so each engine's actual
// MCP tool identifiers are interpolated into the prompt. [LAW:composability]
function buildReviewInput(files, maxDiffChars, toolNames) {
  const patchableFiles = files.filter(f => f.patch);
  const includedDiffs = [];
  const includedFiles = [];
  const skippedFiles = [];
  let totalChars = 0;

  for (const f of patchableFiles) {
    const entry = `### ${f.filename} (${f.status})\n\`\`\`diff\n${annotatePatchWithLines(f.patch)}\n\`\`\``;
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
    Each visible diff line is annotated as LINE N. Call ${toolNames.requestChange} only for code that must change before merge.
    Every requested change must use path, line, and body with the displayed LINE value. When the review is complete,
    call ${toolNames.finishReview} exactly once with a concise summary. The collector tools are the only review output channel.

    You review against the LAWS in your guidance. You flag violations; you do not fix them. A change MUST change before merge only if this
    diff introduces or worsens a LAW violation, or introduces a correctness bug. Pre-existing violations in unchanged code, and matters of
    taste the laws do not cover, are NOT request_change material — mention the significant ones in the finish_review summary instead.

    You can ONLY attach a comment to a line shown as LINE N — that is, a line this diff added or kept as context. You cannot comment on
    unchanged or deleted code; the host does not allow it. When the diff introduces a violation whose root cause sits in unchanged code
    (e.g. it feeds a bad state into an existing guard, or relies on an existing loose type), attach the comment to the changed LINE that is
    responsible for the new problem and explain the upstream link in the body. If a finding cannot be tied to any changed LINE, it goes in
    the finish_review summary, not a request_change.

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

// [LAW:decomposition] The full-repo material: there is no diff, so this prompt carries no
// annotated LINE grid and produces no anchors — it instructs the engine to explore the working
// tree itself with its allowed Read/Grep/Glob tools. Unlike buildReviewInput (a pull-request
// diff, where only diff-introduced violations are request_change material), a whole-repo review
// deliberately flags PRE-EXISTING issues — that is the point of the mode.
// scope is free text that focuses the review; '' means a broad whole-repo pass.
// excludePatterns is a value the prompt forwards as "do not review these"; with no diff to
// filter, the agent honors it while exploring. [LAW:dataflow-not-control-flow] empty scope and
// empty excludePatterns are distinct values with distinct renderings, not skipped branches.
function buildRepoReviewInput({ scope, excludePatterns, toolNames }) {
  const focus = scope
    ? `Focus this review on the following scope, named by the maintainer: ${scope}. Start from the files and modules that scope points to, and follow the code from there.`
    : `Give a broad review across the whole repository. Start from the entry points and the modules most central to the project, and read the actual source before judging it.`;
  const exclude = excludePatterns.length > 0
    ? `\n\n    Do NOT review files matching these excluded patterns: ${excludePatterns.join(', ')}.`
    : '';

  return {
    prompt: `
Review this repository against the LAWS in your guidance. There is no diff — explore the working tree yourself
    using your Read, Grep, and Glob tools and judge the code you find. ${focus}${exclude}

    Call ${toolNames.requestChange} for each issue that should change, with path, line (any real line in that file —
    there is no diff grid here, so any line is valid), and a body. When the review is complete, call
    ${toolNames.finishReview} exactly once with a concise summary. The collector tools are the only review output channel.

    This is a whole-repository audit, so PRE-EXISTING issues in any file ARE in scope — that is the point of this mode.
    You flag violations; you do not fix them. Flag the most important LAW violations, correctness bugs, security flaws,
    invariant/type violations, rough data/control flow, duplicate truth/enforcement, dependency cycles, temporal
    coupling, or missing behavior tests that you find.

    Each ${toolNames.requestChange} body has three parts, in order: (1) the token, e.g. [LAW:dataflow-not-control-flow];
    (2) one sentence naming the specific violation at that path:line; (3) the concrete fix. Keep it short. One comment
    per distinct issue — do not repeat the same finding across many lines; flag the clearest instance and note the
    pattern once in the body.

    Priorities, highest first:
    - [LAW:dataflow-not-control-flow] — the most common and most important violation to catch. Flag: an \`if\`/\`switch\`
      that selects WHICH operation runs rather than letting data decide the result; a guard that makes an operation
      sometimes-run, sometimes-skip (especially \`if (x) { ...work... }\` with no else — that is [LAW:no-defensive-null-guards]
      too); branching on a mode/flag instead of passing a value.
    - [LAW:decomposition] / [LAW:composability] — a function that does more than one thing (needs "and" to describe), or
      hardcodes a caller-specific choice that should be a parameter.
    - [LAW:types-are-the-program] — a type that admits illegal states (\`any\`, \`string\` for an enum, fields that must
      agree but aren't tied), or a body that branches/guards to compensate for a too-loose type.
    - [LAW:effects-at-boundaries] — code mixing computation with IO/mutation/network/clock/randomness in the same unit.
    - [LAW:no-silent-failure] — swallowed errors, \`|| true\`, \`2>/dev/null\`, empty catches, or meaning-changing fallbacks.
    - [LAW:one-source-of-truth] / [LAW:single-enforcer] — a second home for an existing fact, or a duplicated enforcement check.
    - [LAW:no-ambient-temporal-coupling], [LAW:behavior-not-structure], and the remaining laws — flag clear violations.

    Do not invent rules beyond the laws. Do not request changes for style, naming preference, or speculative concerns.
    When unsure whether something rises to must-change, leave it for the summary instead. Do NOT state an overall verdict
    or approval status — this is an informational report, not a merge gate.`,
  };
}

module.exports = { buildReviewInput, buildRepoReviewInput };
