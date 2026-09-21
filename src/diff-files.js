'use strict';
const fs = require('fs');
const path = require('path');
const { annotatePatchWithLines } = require('./diff');

// [LAW:effects-at-boundaries] The change, on disk: each changed file's patch, annotated on the LINE grid
// the review anchors to, written to <dir>/<filename>.diff. A worker reads the change with the same Read,
// Grep and Glob it reads the repository with, and what it reads is its own decision; this module only
// puts the change where those tools reach. A file with no patch (binary, or too large for the host to
// render) has no diff file, and the prompt names it.
// [LAW:no-silent-failure] A changed path that resolves outside the directory is refused, never written.
// The caller names the directory: the diffs hold the change's code, so they belong under a directory the
// caller already deletes, never an orphan temp dir that outlives the run.
// [LAW:one-source-of-truth] ONE rendering of a changed file as reviewable material, with TWO sinks:
// the diff file this module writes, and the same bytes inlined into a worker's prompt (src/prompt.js).
// A finding's `line` is the LINE value read off this grid, so a second renderer for the inline copy
// would be a second grid that anchors comments to the wrong lines the moment the two drift.
// [LAW:effects-at-boundaries] Pure: bytes in, bytes out. The caller decides where they go.
function renderDiffFile(f) {
  return `${f.filename} (${f.status})\n${annotatePatchWithLines(f.patch)}\n`;
}

function writeDiffFiles(files, dir) {
  const root = path.resolve(dir);
  fs.mkdirSync(root, { recursive: true });
  for (const f of files.filter(file => file.patch)) {
    // path.join, not path.resolve: root is already absolute, and ncc reads a path.resolve over a template
    // as a cwd-relative asset glob, copying every *.diff in the repo into dist on each build.
    const target = path.join(root, `${f.filename}.diff`);
    if (!target.startsWith(`${root}${path.sep}`)) {
      throw new Error(`writeDiffFiles: changed path ${JSON.stringify(f.filename)} resolves outside the diff directory ${root}; refusing to write it.`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, renderDiffFile(f));
  }
  return root;
}

module.exports = { renderDiffFile, writeDiffFiles };
