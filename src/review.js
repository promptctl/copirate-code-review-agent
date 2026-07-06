'use strict';

// [LAW:decomposition] The single per-finding validator: one job — turn one raw record into a typed
// finding or throw. Both entry points below call it, each supplying the `label` IT knows names the
// finding's real position (the array index for a batch, the record index for a single finding), so an
// error always identifies the right one. [LAW:single-enforcer] a finding is validated in exactly one
// place; parseReviewValue and parseFindingValue are two callers of this, not two copies of the rule.
function parseOneFinding(finding, label) {
  if (!finding || typeof finding !== 'object' || Array.isArray(finding)) {
    throw new Error(`${label} is not an object.`);
  }
  const pathValue = finding.path;
  const line = finding.line;
  const body = finding.body;
  if (typeof pathValue !== 'string' || pathValue.trim().length === 0) {
    throw new Error(`${label} has an invalid path.`);
  }
  if (!Number.isInteger(line) || line <= 0) {
    throw new Error(`${label} has an invalid line.`);
  }
  if (typeof body !== 'string' || body.trim().length === 0) {
    throw new Error(`${label} has an invalid body.`);
  }
  // [LAW:types-are-the-program] severity is the discriminator that separates "worth surfacing" from
  // "worth blocking a merge". Without it those two facts collapse into the model's private judgment and
  // a non-blocking finding is silently withheld; as a required enum value it rides on the record and
  // flows to the verdict computation instead. [LAW:no-silent-failure]
  const severity = finding.severity;
  if (severity !== 'blocking' && severity !== 'advisory') {
    throw new Error(`${label} has an invalid severity (expected 'blocking' or 'advisory').`);
  }
  return { path: pathValue.trim(), line, body: body.trim(), severity };
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

  const findings = parsed.findings.map((finding, index) =>
    parseOneFinding(finding, `Review collector finding ${index + 1}`));

  return { summary, findings };
}

function parseFindingValue(finding, index) {
  return parseOneFinding(finding, `Review collector finding ${index + 1}`);
}

// [LAW:types-are-the-program] A scout's scope is the same kind of typed, schema-validated record as a
// finding — a name + focus (both non-empty strings) plus the changed files this scope owns. It is
// recorded through the collector tool (never parsed from the model's prose), so an empty or malformed
// scope is rejected here at the one boundary, exactly as a finding is. [LAW:single-enforcer]
//
// `files` is the scope's changed-file assignment: in PR mode every changed file belongs to exactly one
// scope and its worker reads those files in full (the read cost is thus split across workers, not
// duplicated). It is OPTIONAL because the whole-repo scout has no diff to partition — an absent or
// non-array files is a clean empty list, so a repo scope (or a PR scope the model left unlisted) carries
// []. Non-string / blank entries are dropped so a sloppy list can't inject an empty path. [LAW:no-silent-failure]
function parseScopeValue(scope, index) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
    throw new Error(`Review collector scope ${index + 1} is not an object.`);
  }
  const name = scope.name;
  const focus = scope.focus;
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new Error(`Review collector scope ${index + 1} has an invalid name.`);
  }
  if (typeof focus !== 'string' || focus.trim().length === 0) {
    throw new Error(`Review collector scope ${index + 1} ('${name.trim()}') has an invalid focus.`);
  }
  const files = Array.isArray(scope.files)
    ? scope.files.filter(f => typeof f === 'string' && f.trim().length > 0).map(f => f.trim())
    : [];
  return { name: name.trim(), focus: focus.trim(), files };
}

// A finding cited a line within this many lines of a real anchorable line is snapped to
// that line rather than dropped: the model named a line just outside the diff hunk, but the
// comment body is specific enough that a small offset still lands on the right change and the
// reader can place it. Beyond this window the line reference is too far off to trust, so the
// finding is surfaced in the summary instead. [LAW:no-mode-explosion] one documented constant.
const MAX_ANCHOR_SNAP_DISTANCE = 10;

// [LAW:effects-at-boundaries] Pure: given a cited line and the anchorable lines for its file,
// return the nearest line within the snap window, or null when none is close enough.
function nearestAnchorableLine(line, fileLines) {
  if (!fileLines || fileLines.length === 0) return null;
  let best = fileLines[0];
  for (const candidate of fileLines) {
    if (Math.abs(candidate - line) < Math.abs(best - line)) best = candidate;
  }
  return Math.abs(best - line) <= MAX_ANCHOR_SNAP_DISTANCE ? best : null;
}

// [LAW:single-enforcer] partitionFindings is the one place that reconciles model findings
// with the visible diff anchors; nothing else re-implements this check.
// [LAW:dataflow-not-control-flow] The reconciliation is a value, not a throw: a finding the
// model anchored outside the diff is not a fatal error that aborts the whole review (which
// would discard every valid finding and red the run). Each finding flows to exactly one of:
//   - anchored: already on the grid, or snapped to the nearest reviewed line (body annotated
//     so the adjustment is explicit — [LAW:no-silent-failure]).
//   - unanchored: too far from any reviewed line; the caller surfaces it in the summary and
//     logs it, never silently dropping it.
function partitionFindings(findings, anchors) {
  const linesByPath = new Map();
  for (const { path, line } of anchors.values()) {
    if (!linesByPath.has(path)) linesByPath.set(path, []);
    linesByPath.get(path).push(line);
  }

  const anchored = [];
  const unanchored = [];
  for (const finding of findings) {
    if (anchors.has(`${finding.path}:${finding.line}`)) {
      anchored.push({ ...finding });
      continue;
    }
    const snapped = nearestAnchorableLine(finding.line, linesByPath.get(finding.path));
    if (snapped === null) {
      unanchored.push(finding);
      continue;
    }
    anchored.push({
      ...finding,
      line: snapped,
      body: `${finding.body}\n\n_(Anchored to line ${snapped}; the review referenced line ${finding.line}, just outside the diff.)_`,
    });
  }
  return { anchored, unanchored };
}

// [LAW:one-source-of-truth] Severity is a value on the finding; a human reader must be able to tell a
// blocking request from an advisory note in EVERY sink (inline PR comment, the unanchored summary
// section, the whole-repo report). GitHub has no "advisory" field on a review comment, so the only
// channel is the body text — this is the one place that string is defined, and all three sinks derive
// the presented body from here rather than each restating the tag. [LAW:single-enforcer]
// [LAW:dataflow-not-control-flow] The tag is a rendering of the severity value, not a branch on
// whether the finding is shown — every finding is shown; only its label varies.
function severityTaggedBody(finding) {
  return finding.severity === 'advisory'
    ? `**Advisory (non-blocking):** ${finding.body}`
    : finding.body;
}

module.exports = { parseReviewValue, parseFindingValue, parseScopeValue, partitionFindings, nearestAnchorableLine, severityTaggedBody };
