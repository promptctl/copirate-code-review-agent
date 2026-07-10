'use strict';

function matchesPattern(filename, pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\x00')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
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

// Git prints a path double-quoted with C-style escapes when it holds a byte that needs
// quoting (a control char, a `"`/`\`, or — by default — any byte >= 0x80, i.e. non-ASCII).
// Reverse that encoding to recover the real filename. Octal escapes carry raw UTF-8 bytes
// (é -> \303\251), so accumulate a byte stream and decode it as UTF-8 once at the end;
// decoding each octal as its own code point would yield mojibake — a wrong filename that
// would itself mis-anchor. [FRAMING:representation]
const C_ESCAPE_BYTE = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
function unquoteCStylePath(inner) {
  const bytes = [];
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] !== '\\') {
      for (const b of Buffer.from(inner[i], 'utf8')) bytes.push(b);
      continue;
    }
    const next = inner[i + 1];
    if (next >= '0' && next <= '7') {
      let oct = '';
      while (oct.length < 3 && inner[i + 1] >= '0' && inner[i + 1] <= '7') {
        oct += inner[i + 1];
        i++;
      }
      bytes.push(parseInt(oct, 8) & 0xff);
      continue;
    }
    const mapped = C_ESCAPE_BYTE[next];
    if (mapped !== undefined) {
      bytes.push(mapped);
      i++;
    } else {
      // Lone/unknown backslash (git never emits one): keep it literal, reprocess `next`.
      bytes.push(92);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

// The b-side path of a `diff --git` header, honoring git's quoted form. Returns null when
// the header is malformed FOR US so the caller owns no file rather than the wrong one.
// [LAW:no-silent-failure]
function parseGitDiffHeader(line) {
  const quotedB = /^diff --git .+ "b\/((?:[^"\\]|\\.)*)"$/.exec(line);
  if (quotedB) return unquoteCStylePath(quotedB[1]);
  const plainB = /^diff --git a\/.+ b\/(.+)$/.exec(line);
  if (plainB) return plainB[1];
  return null;
}

// Parse a unified diff into the same {filename, status, patch} shape GitHub's listFiles
// returns (where `patch` is the hunk text from the first @@ onward), plus the warnings the
// caller must surface. Returns { files, warnings }.
function parseUnifiedDiff(diff) {
  const files = [];
  const warnings = [];
  let cur = null;
  const flush = () => {
    if (cur && cur.hunks.length > 0) {
      files.push({ filename: cur.filename, status: cur.status, patch: cur.hunks.join('\n') });
    }
  };
  for (const line of diff.split('\n')) {
    // Every file section opens with `diff --git `; treat that prefix as the file boundary
    // structurally, so a header we cannot parse still closes the previous file (cur=null)
    // instead of silently bleeding its hunks into the wrong one — which would falsify
    // patchLines' anchors for both files at once. [LAW:no-silent-failure] [LAW:one-source-of-truth]
    if (line.startsWith('diff --git ')) {
      flush();
      const filename = parseGitDiffHeader(line);
      if (filename === null) {
        warnings.push(`parseUnifiedDiff: unparseable diff header; its hunks are dropped rather than attributed to the previous file: ${line}`);
      }
      cur = filename === null ? null : { filename, status: 'modified', hunks: [], inHunk: false };
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
  return { files, warnings };
}

module.exports = {
  matchesPattern,
  filterFiles,
  patchLines,
  buildFileAnchors,
  buildReviewAnchors,
  annotatePatchWithLines,
  unquoteCStylePath,
  parseGitDiffHeader,
  parseUnifiedDiff,
};
