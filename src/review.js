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

// [LAW:single-enforcer] validateFindings is the one place that checks every finding
// against the visible diff anchors; nothing else re-implements this check.
function validateFindings(findings, anchors) {
  for (const finding of findings) {
    const anchor = `${finding.path}:${finding.line}`;
    if (!anchors.has(anchor)) {
      throw new Error(`Claude Code finding references a line outside the review diff: ${anchor}`);
    }
  }
}

module.exports = { parseReviewValue, parseFindingValue, validateFindings };
