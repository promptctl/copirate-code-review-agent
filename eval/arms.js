#!/usr/bin/env node
'use strict';
// THE ARMS TABLE — one markdown table comparing any number of scored arms against the same frozen cases.
//
// The question it answers, and the reason the quota columns sit beside the recall ones: a production
// review on this repo costs real money and real minutes, so "does our engine find more than the built-in
// reviewer" is only half of it. Equal recall at a tenth of the spend is a different answer than equal
// recall at the same spend, and a table with only recall cannot tell them apart. [FRAMING:representation]
//
//   node eval/arms.js <scored-root> <scored-root> [...]
//
// It is a REDUCER, not a gate: it reports what the roots hold and never decides anything, so it has no
// failing exit code. 0 = it ran, 2 = it refused to read (a root with unscored runs, a root whose runs
// disagree on their arm, a root missing a case another root has — each of which would make one column
// mean two things). [LAW:no-silent-failure]
//
// Arms may have DIFFERENT n. Deepening the cheap arm must never require deepening the expensive one —
// that is most of what makes this eval cheap — so n is a column, and the half-width beside each recall is
// what keeps a shallow arm from being read as a precise one.
//
// [LAW:effects-at-boundaries] Module load is PURE. Every pure reduction below is exported and tested
// directly; main() does the reading.

const fs = require('fs');
const path = require('path');

const { parseCaseSummary, parseFraction } = require('./baseline');
const { describeEffort } = require('./effort-record');
const { listRunDirs } = require('./score');

const MS_PER_MINUTE = 60_000;
// The 95% normal-approximation multiplier. Stated once, named, because it is the difference between a
// half-width and a number nobody can check. [LAW:one-source-of-truth]
const Z_95 = 1.96;

// [LAW:effects-at-boundaries] Pure. A pooled rate and the 95% interval that says how much of it is real.
//
// WILSON, not the textbook normal approximation, and the difference is not academic here. The normal
// form is p ± z·sqrt(p(1-p)/n), which COLLAPSES TO ZERO at p=0 and p=1 — so the first real run of this
// table rendered "0% ±0 (0/2)", claiming perfect certainty from two observations. An instrument whose
// whole job is to say whether a gap between two arms is decisive cannot report its least certain
// measurements as its most certain ones. [FRAMING:representation] Wilson stays finite at both ends and
// is well behaved at the small n this eval deliberately runs at.
//
// The interval is reported as its BOUNDS. A single ± would have to be symmetric about the observed rate,
// and Wilson's is not — so a half-width here would be a number that does not describe the interval it
// was derived from.
//
// A rate over zero opportunities is `null`, never 0: "nothing was asked" and "nothing was found" are
// different facts, and collapsing them onto 0 is the answer-shaped void. [LAW:parse-dont-validate]
function pooledRate(found, total) {
  if (total === 0) return { found, total, rate: null, low: null, high: null };
  const rate = found / total;
  const z2 = Z_95 * Z_95;
  const denom = 1 + z2 / total;
  const center = (rate + z2 / (2 * total)) / denom;
  const spread = (Z_95 / denom) * Math.sqrt((rate * (1 - rate)) / total + z2 / (4 * total * total));
  return { found, total, rate, low: Math.max(0, center - spread), high: Math.min(1, center + spread) };
}

// [LAW:effects-at-boundaries] Pure. The mean of the figures that are RECORDED, and how many were not —
// an unpriced run must not be averaged in as a free one, and a mean that hid how many runs it skipped
// would be a number nobody could size. [LAW:no-silent-failure]
function meanOf(values) {
  const known = values.filter(v => typeof v === 'number' && Number.isFinite(v));
  return { mean: known.length === 0 ? null : known.reduce((a, b) => a + b, 0) / known.length, known: known.length, missing: values.length - known.length };
}

// [LAW:effects-at-boundaries] Pure. Every case of one arm, folded into the arm's row. The recalls are
// POOLED — every opportunity across every case and every replicate counted once — rather than averaged
// per case, because a mean of per-case rates weights a 2-must-find case the same as a 10-must-find one
// and reports a number that is no case's rate and no arm's either.
function reduceArm({ label, cases, runs }) {
  const perRun = cases.flatMap(c => c.perRun);
  const sum = pick => perRun.reduce((acc, r) => { const f = pick(r); return { found: acc.found + f.found, total: acc.total + f.total }; }, { found: 0, total: 0 });
  const must = sum(r => r.inventoryMustFind);
  const nice = sum(r => r.niceToFind);
  return {
    label,
    runs: perRun.length,
    cases: cases.length,
    mustFind: pooledRate(must.found, must.total),
    niceToFind: pooledRate(nice.found, nice.total),
    noise: meanOf(perRun.map(r => r.noise)),
    costUsd: meanOf(perRun.map(r => r.costUsd)),
    inputCacheMiss: meanOf(runs.map(r => r.tokens && r.tokens.inputCacheMiss)),
    inputCacheHit: meanOf(runs.map(r => r.tokens && r.tokens.inputCacheHit)),
    output: meanOf(runs.map(r => r.tokens && r.tokens.output)),
    wallMinutes: meanOf(runs.map(r => r.wallMinutes)),
  };
}

// An absent figure renders as an em dash, never as 0 or as a blank cell: a reader scanning a cost column
// must be able to see that a run was unpriced rather than free. [LAW:no-silent-failure]
const DASH = '—';
const num = (v, digits) => (v === null ? DASH : v.toFixed(digits));
const thousands = v => (v === null ? DASH : Math.round(v).toLocaleString('en-US'));
const pct = band => (band.rate === null ? DASH : `${(band.rate * 100).toFixed(0)}% (${band.found}/${band.total}) · ${(band.low * 100).toFixed(0)}–${(band.high * 100).toFixed(0)}%`);

// [LAW:effects-at-boundaries] Pure: rows in, markdown out. One table, because the whole point is a
// side-by-side a reader takes in at once.
function renderArmsTable(rows) {
  const header = [
    '| Arm | Runs | Inventory must-find recall (95% CI) | Nice-to-find recall (95% CI) | Noise/run | Cache-miss tok/run | Cache-hit tok/run | Output tok/run | Wall min/run | $/run |',
    '| --- | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  const body = rows.map(r => `| \`${r.label}\` | ${r.runs} | ${pct(r.mustFind)} | ${pct(r.niceToFind)} | ${num(r.noise.mean, 1)} | ${thousands(r.inputCacheMiss.mean)} | ${thousands(r.inputCacheHit.mean)} | ${thousands(r.output.mean)} | ${num(r.wallMinutes.mean, 1)} | ${r.costUsd.mean === null ? DASH : `$${r.costUsd.mean.toFixed(2)}`} |`);
  return [...header, ...body].join('\n');
}

// The per-case diagnostic: WHICH case moved. An arm's row is a pooled number, and a pooled number that
// shifted says nothing about where — which is the first thing anyone acting on this table asks.
function renderPerCaseTable(arms) {
  const caseNames = [...new Set(arms.flatMap(a => a.cases.map(c => c.name)))].sort();
  const header = [
    `| Case | ${arms.map(a => `\`${a.label}\``).join(' | ')} |`,
    `| --- | ${arms.map(() => '---').join(' | ')} |`,
  ];
  const body = caseNames.map(name => {
    const cells = arms.map(arm => {
      const found = arm.cases.find(c => c.name === name);
      if (!found) return DASH;
      const pooled = found.perRun.reduce((acc, r) => ({ found: acc.found + r.inventoryMustFind.found, total: acc.total + r.inventoryMustFind.total }), { found: 0, total: 0 });
      return `${pooled.found}/${pooled.total}`;
    });
    return `| ${name} | ${cells.join(' | ')} |`;
  });
  return [...header, ...body].join('\n');
}

// [LAW:parse-dont-validate] The crossing from a directory on disk to an ARM: in goes a scored root, out
// comes every case's summary plus every run's usage — or a refusal naming what is missing. A root whose
// cases disagree on their arm is the failure this checks for above all: pooling two arms into one row
// produces a number that names neither, and it is invisible in the output. [LAW:no-silent-failure]
function readArm(root) {
  const resolved = path.resolve(root);
  if (!fs.existsSync(resolved)) throw new Error(`Root ${root} does not exist.`);
  const caseNames = fs.readdirSync(resolved, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
  if (caseNames.length === 0) throw new Error(`Root ${root} holds no case directories.`);

  const cases = caseNames.map(name => {
    const summaryPath = path.join(resolved, name, 'scorecard-summary.json');
    if (!fs.existsSync(summaryPath)) {
      throw new Error(`${path.join(root, name)} has no scorecard-summary.json — score the root before reducing it (node eval/score.js …).`);
    }
    const summary = parseCaseSummary(fs.readFileSync(summaryPath, 'utf8'), summaryPath);
    return {
      name,
      effort: summary.effort,
      // niceToFind rides through aggregateRuns as a raw 'found/total' string, so it is parsed here at the
      // one place this reducer reads it, through the same parser the rest of the harness uses.
      perRun: summary.perRun.map((r, i) => ({ ...r, niceToFind: parseFraction(r.niceToFind, `${summaryPath}.perRun[${i}].niceToFind`) })),
    };
  });

  const labels = [...new Set(cases.map(c => describeEffort(c.effort)))];
  if (labels.length > 1) {
    throw new Error(`Root ${root} mixes arms (${labels.join(' · ')}) — a row pooling two arms reports a rate that is neither.`);
  }

  // Tokens and wall clock come from each RUN's usage.json: the scorecard summary reduces cost but not
  // tokens or duration, and those are two of the columns this table exists for.
  //
  // [LAW:no-silent-failure] Which makes one row read from TWO populations — the scored runs the summary
  // reduced, and the run dirs on disk right now — and nothing but this check says they are the same runs.
  // They come apart the moment a root is extended after scoring, which is the documented workflow: run
  // dirs are named by timestamp, so re-running into an existing --out ADDS dirs rather than replacing
  // them, and scoring is a separate step. The row would then render recall over N runs beside tokens
  // over M, with no mark on the table saying so — the one population mismatch this reducer did not
  // refuse while refusing every other kind. Named per case, with the remedy, because "the root is
  // inconsistent" sends a reader searching.
  const scoredRunCount = new Map(cases.map(c => [c.name, c.perRun.length]));

  const runsOf = name => listRunDirs(path.join(resolved, name)).map(dir => {
    const usagePath = path.join(dir, 'usage.json');
    if (!fs.existsSync(usagePath)) return { tokens: null, wallMinutes: null };
    const usage = JSON.parse(fs.readFileSync(usagePath, 'utf8'));
    const span = usage.span;
    const wallMinutes = span && span.from && span.to ? (new Date(span.to) - new Date(span.from)) / MS_PER_MINUTE : null;
    return { tokens: usage.tokens ?? null, wallMinutes: Number.isFinite(wallMinutes) ? wallMinutes : null };
  });

  const runs = caseNames.flatMap(name => {
    const found = runsOf(name);
    const scored = scoredRunCount.get(name);
    if (found.length !== scored) {
      throw new Error(
        `Root ${root}: case '${name}' holds ${found.length} run dir(s) on disk but its scorecard-summary.json ` +
        `reduced ${scored} — the recall and cost columns would describe one population and the token and ` +
        `wall-clock columns another. Re-score the root (node eval/score.js ${path.join(root, name)}).`,
      );
    }
    return found;
  });

  return { label: labels[0], root: resolved, cases, runs };
}

// [LAW:parse-dont-validate] [LAW:no-silent-failure] The third refusal this file's header promises, and the
// one that was documented without being built. Two arms are comparable only over the SAME cases: the
// headline row pools every opportunity a root holds, so a root missing one of the four frozen cases
// renders a recall over three cases beside another over four, in a table whose entire purpose is that the
// two numbers can be set side by side.
//
// The per-case table below does show the hole as a dash, which makes this worse rather than better — the
// output looks like it handled the situation while the deliverable row, the one a reader acts on, quietly
// describes a different population. Reachable by ordinary use, not only by mistake: the cheap arm is the
// one that gets deepened and re-run, and a credential walling mid-suite leaves exactly this shape.
//
// Refused rather than reconciled. Pooling over the intersection would make the numbers comparable by
// silently changing what they measure, and warning-and-continuing would put the untrustworthy table on
// screen anyway — which is the one thing every other check here exists to prevent.
// [LAW:effects-at-boundaries] Pure: arms in, a refusal or nothing out.
function assertComparableCases(arms) {
  const [first, ...rest] = arms;
  const wanted = first.cases.map(c => c.name).sort();
  for (const arm of rest) {
    const held = arm.cases.map(c => c.name).sort();
    const missing = wanted.filter(name => !held.includes(name));
    const extra = held.filter(name => !wanted.includes(name));
    if (missing.length > 0 || extra.length > 0) {
      throw new Error(
        `Root ${arm.root} holds a different case set than ${first.root}: ` +
        `${[missing.length > 0 ? `missing ${missing.join(', ')}` : null, extra.length > 0 ? `extra ${extra.join(', ')}` : null].filter(Boolean).join('; ')}. ` +
        'Two arms are comparable only over the same cases — the pooled recalls would describe different ' +
        'populations. Run the missing case(s) into the root and re-score, or pass roots that hold the same cases.',
      );
    }
  }
}

function main(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write('Compare scored arms against the same frozen cases.\n\n  node eval/arms.js <scored-root> <scored-root> [...]\n\nEach root is a directory of <case>/ dirs already scored by eval/score.js.\n');
    return argv.length === 0 ? 2 : 0;
  }
  const arms = argv.map(readArm);
  assertComparableCases(arms);
  const rows = arms.map(reduceArm);
  process.stdout.write(`${renderArmsTable(rows)}\n\n`);
  process.stdout.write(`Inventory must-find, per case (found/opportunities):\n\n${renderPerCaseTable(arms)}\n`);
  // Every averaged column carries the same exposure — a mean of the figures that were recorded — so the
  // note is stated once over all of them rather than for whichever column someone remembered.
  // [LAW:dataflow-not-control-flow] [LAW:single-enforcer]
  const AVERAGED = { costUsd: 'cost', noise: 'noise count', wallMinutes: 'wall clock', inputCacheMiss: 'cache-miss tokens', inputCacheHit: 'cache-hit tokens', output: 'output tokens' };
  for (const row of rows) {
    for (const [field, name] of Object.entries(AVERAGED)) {
      if (row[field].missing > 0) {
        process.stderr.write(`arms: ${row.label} has ${row[field].missing} run(s) with no recorded ${name} — that column is a mean of the ${row[field].known} that recorded one.\n`);
      }
    }
  }
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`arms: ${err.message}\n`);
    process.exitCode = 2;
  }
}

module.exports = { pooledRate, meanOf, reduceArm, renderArmsTable, renderPerCaseTable, readArm, assertComparableCases, Z_95 };
