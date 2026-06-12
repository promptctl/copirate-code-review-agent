'use strict';

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

// [LAW:one-source-of-truth] The new-file line number is the one honest anchor for a
// changed line; both GitHub (line+side) and Gitea (new_position) speak it natively.
// Each hunk header resets the new-side counter; only added/context lines advance it
// and are anchorable (deletions have no new-side line).
function* patchLines(patch) {
  let newLine = 0;
  let inHunk = false;
  for (const text of patch.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      yield { kind: 'meta', text };
      continue;
    }
    const marker = inHunk ? text[0] : undefined;
    if (marker === '+' || marker === ' ') {
      yield { kind: 'line', line: newLine, text };
      newLine++;
      continue;
    }
    yield { kind: 'meta', text };
  }
}

function buildFileAnchors(file) {
  const anchors = new Map();
  for (const entry of patchLines(file.patch)) {
    if (entry.kind === 'line') {
      anchors.set(`${file.filename}:${entry.line}`, { path: file.filename, line: entry.line });
    }
  }
  return anchors;
}

function buildReviewAnchors(files) {
  return new Map(files.filter(f => f.patch).flatMap(f => [...buildFileAnchors(f)]));
}

function annotatePatchWithLines(patch) {
  const lines = [];
  for (const entry of patchLines(patch)) {
    lines.push(entry.kind === 'line' ? `LINE ${entry.line}: ${entry.text}` : entry.text);
  }
  return lines.join('\n');
}

// Parse a unified diff into the same {filename, status, patch} shape GitHub's
// listFiles returns, where `patch` is the hunk text from the first @@ onward.
function parseUnifiedDiff(diff) {
  const files = [];
  let cur = null;
  const flush = () => {
    if (cur && cur.hunks.length > 0) {
      files.push({ filename: cur.filename, status: cur.status, patch: cur.hunks.join('\n') });
    }
  };
  for (const line of diff.split('\n')) {
    const header = /^diff --git a\/.+ b\/(.+)$/.exec(line);
    if (header) {
      flush();
      cur = { filename: header[1], status: 'modified', hunks: [], inHunk: false };
      continue;
    }
    if (!cur) {
      continue;
    }
    if (line.startsWith('new file mode')) cur.status = 'added';
    else if (line.startsWith('deleted file mode')) cur.status = 'removed';
    else if (line.startsWith('rename to ')) cur.status = 'renamed';
    if (/^@@ /.test(line)) cur.inHunk = true;
    if (cur.inHunk) cur.hunks.push(line);
  }
  flush();
  return files;
}

module.exports = {
  matchesPattern,
  filterFiles,
  patchLines,
  buildFileAnchors,
  buildReviewAnchors,
  annotatePatchWithLines,
  parseUnifiedDiff,
};
