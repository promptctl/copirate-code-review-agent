'use strict';
const { annotatePatchWithLines } = require('./diff');

// toolNames is required; callers supply adapter.toolNames so each engine's actual
// MCP tool identifiers are interpolated into the prompt. [LAW:composability]
// reviewedRepoRoot is the absolute path of the checked-out repo. The engine spawns with a
// working directory OUTSIDE that tree (so no repo-committed CLAUDE.md/AGENTS.md is auto-loaded
// as reviewer instructions), so the repo is named here as an explicit value and the agent reads
// it by absolute path — never via cwd-relative discovery. [LAW:effects-at-boundaries]
// focus is a free-text value naming the part of the change this review should concentrate on (a
// multi-scope worker's scope). [LAW:dataflow-not-control-flow] '' is the broad whole-diff review
// (the single-scope case); a non-empty value narrows attention — the same prompt, varied by value,
// never a branch. The whole annotated diff is shown either way so every anchor stays valid.
function buildReviewInput(files, maxDiffChars, toolNames, reviewedRepoRoot, focus = '') {
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

  // [LAW:dataflow-not-control-flow] focus renders as a value: '' yields no block, a scope yields a
  // concentration instruction. The worker still sees the whole diff (anchors stay valid) and reads
  // for cross-file context, but reports only what belongs to its scope; overlap is de-duplicated when
  // scopes' findings merge.
  const focusBlock = focus
    ? `\n    CONCENTRATE THIS REVIEW on one part of the change: ${focus}\n    The whole diff is shown below for context, but only flag issues that belong to that part. Other parts are reviewed separately.\n`
    : '';

  return {
    // [LAW:one-source-of-truth] The same included files define Claude's visible diff and valid review anchors.
    files: includedFiles,
    prompt: `
Review this pull request. The repository under review is checked out at ${reviewedRepoRoot}.
    Your working directory is intentionally outside the repository; reach it by that absolute path with your Read tool.
${focusBlock}
    BEFORE judging anything, Read the complete content of every changed source file listed in the diff
    (files under src/ or scripts/ — not dist/, not docs, not test/). The diff shows only the changed
    hunks; a violation is only visible in the full surrounding context of the function and module. Do
    not form or report any judgment until you have read each changed source file in full.

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
// reviewedRepoRoot is the absolute path of the checked-out repo, named explicitly because the
// engine's working directory is OUTSIDE the tree (so no repo-committed AGENTS.md/CLAUDE.md loads
// as reviewer instructions); the agent explores the repo by that absolute path. [LAW:effects-at-boundaries]
function buildRepoReviewInput({ scope, excludePatterns, toolNames, reviewedRepoRoot }) {
  const focus = scope
    ? `Focus this review on the following scope, named by the maintainer: ${scope}. Start from the files and modules that scope points to, and follow the code from there.`
    : `Give a broad review across the whole repository. Start from the entry points and the modules most central to the project, and read the actual source before judging it.`;
  const exclude = excludePatterns.length > 0
    ? `\n\n    Do NOT review files matching these excluded patterns: ${excludePatterns.join(', ')}.`
    : '';

  return {
    prompt: `
Review this repository against the LAWS in your guidance. There is no diff — the repository under review is checked out
    at ${reviewedRepoRoot}; explore it yourself using your Read, Grep, and Glob tools against that absolute path (your
    working directory is intentionally outside the repository) and judge the code you find. ${focus}${exclude}

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

// [LAW:one-source-of-truth] The scout's OUTPUT format lives here, once, shared by both scout
// builders below. A scout plans the review; it does not flag code. Its only product is a JSON array
// of scopes (each a {name, focus} value) that src/multiscope.js parses and turns into one worker per
// scope. The number of scopes is whatever the grouping rules produce — adaptivity is the grouping,
// never a counted threshold. [LAW:dataflow-not-control-flow]
function scoutOutputContract(toolNames) {
  return `Do NOT call ${toolNames.requestChange}. You are not reviewing code here; you are planning the review.

    Call ${toolNames.finishReview} exactly once. Its summary MUST contain, in this order:

    1. Two to four plain sentences describing what this codebase is and how its main parts relate.

    2. A JSON array of review scopes. Each scope is an object with EXACTLY two string fields and no others:
       - "name": a short label (for example "cost", "diff-anchoring", or "run→transport" for a boundary).
       - "focus": one or two sentences naming the exact files and what to examine in them.
       Write it as valid JSON. For example:
       [{"name":"cost","focus":"src/usage.js and the extractUsage function in src/engine/claude-code.js — the token-to-USD cost path."},
        {"name":"run→transport","focus":"The boundary where src/run.js calls src/transport.js — check the dependency points one way and no concept is owned on both sides."}]

    Put the JSON array last. Do not write any prose after it. The collector tools are your only output channel.`;
}

// [LAW:decomposition] The PR scout MATERIAL: it is handed the list of files this pull request changed
// and divides them into review scopes by the explicit rules below. It surveys; the workers judge.
// The rules are written for a weak model — concrete, example-grounded, and free of any "is it big"
// threshold: the scope COUNT falls out of grouping changed files by concern and following the import
// edges the change actually crosses. [LAW:dataflow-not-control-flow]
function buildPrScoutInput({ changedPaths, toolNames, reviewedRepoRoot }) {
  const fileList = changedPaths.map(p => `      - ${p}`).join('\n');
  return {
    prompt: `
Plan the review of a pull request. The repository under review is checked out at ${reviewedRepoRoot}; your working
    directory is intentionally outside it, so reach files by that absolute path with your Read, Grep, and Glob tools.

    This pull request changed these source files:
${fileList}

    Divide these changed files into review scopes by this ONE rule. Do not invent scopes for anything these files do not
    change.

    Group the changed files by the ONE concern each serves, and emit exactly ONE scope per group — no more. [LAW:decomposition]:
    a part does one thing, so each group is one concern. A concern is usually the directory a file sits in, but judge by what
    the code DOES, not only where it sits. Read the changed files if you are unsure what they do.
      - Example: a change to src/usage.js (the price table) and a change to the extractUsage function in
        src/engine/claude-code.js both serve the cost concern — ONE group, ONE scope, though they are different files.
      - Example: a change to src/diff.js (line anchoring) and a change to src/report.js (rendering) serve two different
        concerns — TWO groups, TWO scopes.

    The number of scopes EQUALS the number of distinct concerns these changed files touch: a change to one concern yields
    exactly one scope; a change touching five concerns yields exactly five scopes. Do NOT split one concern across several
    scopes, and do NOT create a separate scope for a boundary between concerns — boundaries are reviewed from inside a scope,
    next.

    In each scope's "focus", do THREE things: (1) name that group's changed files and what to review in them; (2) tell the
    reviewer to ALSO read the files this group imports (its require(...) targets) and check the connection — that the
    dependency points one way [LAW:one-way-deps] and that no single fact is defined or owned on both sides
    [LAW:one-source-of-truth]; (3) keep it to one or two sentences.

    ${scoutOutputContract(toolNames)}`,
  };
}

// [LAW:decomposition] The whole-repo scout MATERIAL: no diff, so it surveys the working tree and
// divides the SOURCE (not just changed files) into scopes by the same concern-grouping rules. scope
// is optional free text that narrows where planning starts; excludePatterns are forwarded as "never
// scope these". [LAW:dataflow-not-control-flow] empty scope and empty excludePatterns are distinct
// rendered values, not skipped branches.
function buildRepoScoutInput({ scope, excludePatterns, toolNames, reviewedRepoRoot }) {
  // [LAW:dataflow-not-control-flow] The maintainer's focus is a BOUND on grouping, not a soft hint:
  // when present, scopes may only cover files inside the focus and the files those import. Absent, the
  // whole repository is in bounds. This is the fix for a weak model that otherwise "follows the code
  // outward" until it has re-scoped the entire repo.
  const boundLine = scope
    ? `The maintainer has focused this review on: ${scope}\n    IMPORTANT: create scopes ONLY for files inside that focus and the files those files directly import. Do NOT create scopes for unrelated parts of the repository, even ones you notice while surveying.`
    : 'Cover the whole repository: every distinct concern in the source is in bounds.';
  const exclude = excludePatterns.length > 0
    ? `\n\n    Do NOT include files matching these excluded patterns in any scope: ${excludePatterns.join(', ')}.`
    : '';
  return {
    prompt: `
Plan the review of this repository. There is no diff. The repository under review is checked out at ${reviewedRepoRoot};
    your working directory is intentionally outside it, so explore by that absolute path with your Read, Grep, and Glob tools.
    ${boundLine}${exclude}

    First, survey the structure: read the entry points, the package manifest, and one key file per major part so you
    understand what the parts are and how they relate. Then divide the IN-BOUNDS source into review scopes by this ONE rule.

    Group the in-bounds source by the ONE concern each part serves, and emit exactly ONE scope per group — no more.
    [LAW:decomposition]: a part does one thing, so each group is one concern. A concern is usually a directory (for example
    src/engine), but judge by what the code DOES, not only where it sits.
      - Example: src/usage.js (the price table) and the extractUsage function in src/engine/claude-code.js both serve the
        cost concern — ONE group, ONE scope.
      - Example: src/diff.js (line anchoring) and src/report.js (rendering) serve two concerns — TWO groups, TWO scopes.

    The number of scopes EQUALS the number of distinct concerns in bounds — nothing else. A small or tightly focused review
    yields few scopes; a whole large repository yields one scope per concern. Do NOT split one concern across several scopes,
    and do NOT create a separate scope for a boundary between concerns — boundaries are reviewed from inside a scope, next.

    In each scope's "focus", do THREE things: (1) name that group's files and what to review in them; (2) tell the reviewer
    to ALSO read the files this group imports (its require(...) targets) and check the connection — that the dependency
    points one way [LAW:one-way-deps] and that no single fact is defined or owned on both sides [LAW:one-source-of-truth];
    (3) keep it to one or two sentences.

    ${scoutOutputContract(toolNames)}`,
  };
}

module.exports = { buildReviewInput, buildRepoReviewInput, buildPrScoutInput, buildRepoScoutInput };
