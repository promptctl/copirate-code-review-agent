#!/usr/bin/env node
// Enforce that the README "## Inputs" table matches action.yml. [LAW:single-enforcer]
//
// action.yml is the ONE authoritative input contract — the keys the runner reads.
// The README inputs table is a DERIVED representation of that contract, and (since
// the action is published) the Marketplace listing body a prospective consumer
// reads before adopting. Two representations of one contract can drift: a new input
// added to action.yml with no README row under-documents the action; a README row
// for an input that no longer exists is a promise the action can't keep. [LAW:one-source-of-truth]
//
// kx9.7 reconciled the table BY HAND; nothing mechanically stopped the drift from
// recurring. This is the machine that does — so the "every input is documented,
// nothing documents a phantom input" invariant has a type, not a hope. [LAW:types-are-the-program]
// It mirrors ci.yml's committed-dist freshness check: a pure check of the working
// tree, failing the build loudly on divergence. [LAW:no-silent-failure]
//
// Scope is the structured inputs table ONLY. The Providers table and intro prose are
// free-text, not a 1:1 map of inputs, and are deliberately not gated.
//
// Usage: node scripts/check-readme-inputs.js   (run from the repo root)
'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('yaml');

const root = path.resolve(__dirname, '..');
const die = (msg) => { console.error(`ERROR: ${msg}`); process.exit(1); };

// SOURCE OF TRUTH: the inputs the runner actually reads.
const action = yaml.parse(fs.readFileSync(path.join(root, 'action.yml'), 'utf8'));
const actionInputs = Object.keys(action?.inputs ?? {});
if (actionInputs.length === 0) die('action.yml declares no inputs — cannot validate the README table against an empty contract.');

// DERIVED: the keys documented in the README "## Inputs" table. Scope to that
// section (heading to the next "## " heading OR end of document), then take each
// table row whose first cell is a backtick-quoted key. The Providers table and
// prose live outside this slice.
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const section = readme.match(/(?:^|\n)## Inputs\n([\s\S]*?)(?=\n## |$)/);
if (!section) die('README.md has no "## Inputs" section to validate against action.yml.');
const documented = [...section[1].matchAll(/^\|\s*`([A-Z0-9_]+)`\s*\|/gm)].map((m) => m[1]);

const actionSet = new Set(actionInputs);
const documentedSet = new Set(documented);

// Three divergence classes, all surfaced together so one run names every fix.
const missing = actionInputs.filter((k) => !documentedSet.has(k)); // input with no README row
const orphan = documented.filter((k) => !actionSet.has(k));        // README row with no input
const duplicate = documented.filter((k, i) => documented.indexOf(k) !== i); // a key rowed twice

if (missing.length || orphan.length || duplicate.length) {
  console.error('README "## Inputs" table is out of sync with action.yml:');
  if (missing.length) console.error(`  • inputs in action.yml with NO README row: ${missing.join(', ')}`);
  if (orphan.length) console.error(`  • README rows for inputs NOT in action.yml: ${orphan.join(', ')}`);
  if (duplicate.length) console.error(`  • inputs documented by more than one README row: ${[...new Set(duplicate)].join(', ')}`);
  console.error('Reconcile the README inputs table with action.yml (the source of truth), then re-run.');
  process.exit(1);
}

console.log(`✓ README inputs table matches action.yml (${actionInputs.length} inputs, no missing/orphan/duplicate rows).`);
