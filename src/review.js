'use strict';

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
    const line = finding.line;
    const body = finding.body;
    if (typeof pathValue !== 'string' || pathValue.trim().length === 0) {
      throw new Error(`Claude Code finding ${index + 1} has an invalid path.`);
    }
    if (!Number.isInteger(line) || line <= 0) {
      throw new Error(`Claude Code finding ${index + 1} has an invalid line.`);
    }
    if (typeof body !== 'string' || body.trim().length === 0) {
      throw new Error(`Claude Code finding ${index + 1} has an invalid body.`);
    }
    return {
      path: pathValue.trim(),
      line,
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

// [LAW:types-are-the-program] A scout's scope is the same kind of typed, schema-validated record as a
// finding — a name + focus, both non-empty strings. It is recorded through the collector tool (never
// parsed from the model's prose), so an empty or malformed scope is rejected here at the one boundary,
// exactly as a finding is. [LAW:single-enforcer]
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
  return { name: name.trim(), focus: focus.trim() };
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

module.exports = { parseReviewValue, parseFindingValue, parseScopeValue, partitionFindings, nearestAnchorableLine };
