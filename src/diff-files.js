'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { annotatePatchWithLines } = require('./diff');

// [LAW:effects-at-boundaries] The change, on disk: each changed file's patch, annotated on the LINE grid
// the review anchors to, written to <dir>/<filename>.diff. A worker reads the change with the same Read,
// Grep and Glob it reads the repository with, and what it reads is its own decision; this module only
// puts the change where those tools reach. A file with no patch (binary, or too large for the host to
// render) has no diff file, and the prompt names it.
// [LAW:no-silent-failure] A changed path that resolves outside the directory is refused, never written.
function writeDiffFiles(files, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-diffs-'))) {
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
    fs.writeFileSync(target, `${f.filename} (${f.status})\n${annotatePatchWithLines(f.patch)}\n`);
  }
  return root;
}

module.exports = { writeDiffFiles };
