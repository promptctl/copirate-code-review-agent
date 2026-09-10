#!/usr/bin/env node
'use strict';
// THE PAIRED A/B (copirate-determinism-5od.w2r). Two arm roots in, one paired verdict out:
//
//   node eval/paired.js <arm-a-out> <arm-b-out> [--out <dir>]
//
// WHY PAIRING. Every A/B this harness has run so far compared two INDEPENDENT samples, so each arm
// re-rolled the scope plan and the comparison paid that variance twice. The roll is the dominant noise
// term by a wide margin: pooled across the (root, case) cells where the scope count varied, the
// fewest-scope runs found 9/36 must-finds (25%) and the most-scope runs 38/74 (51%) — a 26-point spread
// on a variable nobody chose, against a sweeps LEVER worth 16 points. Unpaired at N=5 over four cases the
// SE of the arm difference is ~6.7 points, so the instrument could only ever see a ~13-point effect, and
// most levers worth testing are smaller than that.
//
// `--plans` (copirate-determinism-5od.fku) removes that term at the source: both arms replay the SAME
// pinned partition, so a hit/miss difference on a given finding is attributable to the ARM and not to the
// structure. This file is the reducer that finally spends that: it matches the arms up per
// (case, plan, finding) and reports DISCORDANT PAIRS with an exact McNemar p, instead of differencing two
// pooled rates that were never matched on the variable that moves them most.
// [LAW:behavior-not-structure] The statistic asserts the contract — 'did this arm change whether THIS
// finding was found, holding the structure fixed' — rather than comparing two aggregates.
//
// IT IS AN INSTRUMENT, NOT A THIRD SCORER. It never runs the engine, never re-matches findings, and
// never re-derives an expected set: it reads the per-run `scorecard.json` eval/score.js already wrote
// (inventory must-find `foundIds`/`missedIds` — the gate metric) and the per-run `plan.json` the pass
// already recorded, and reduces them. It needs no credential and is deterministic.
// [LAW:one-source-of-truth] The plan is read through src/plan.js's own mint, and the effort through
// eval/score.js's own parser, so neither can drift from the producer.
//
// IT IS A REPORTER, NOT A GATE. Exit 0 = ran, exit 2 = refused. Nothing here exits 1: a paired p-value
// is evidence for a decision, not the decision, and the one gate this repo has (eval/compare.js) is the
// place a floor is enforced. [LAW:single-enforcer]

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { parsePlanRecord } = require('../src/plan');
const { parseMeta, parseJsonObject, agreedEffort, listRunDirs, requireRunCase } = require('./score');

const USAGE = `Usage: node eval/paired.js <arm-a-out> <arm-b-out> [options]

Reduce two A/B arm roots that replayed the SAME pinned plan set into a PAIRED comparison: discordant
pair counts, an exact McNemar p-value, and the two pooled inventory must-find rates over the paired set.

Arguments:
  <arm-a-out>              an arm's --out root (the dir holding one sub-dir per case), e.g. eval/out/ab-sweep2
  <arm-b-out>              the other arm's --out root

Options:
  --out <dir>              where paired.{md,json} land (default: eval/out/paired-<armA>-vs-<armB>-<digest>)
  -h, --help               this message

Both arms must have replayed the same cases against the same plans: for every case, the multiset of
plans in arm A must equal the multiset in arm B. Anything else is refused before a number is printed —
a pair whose two halves ran different structures measures the structure, not the arm.
`;

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Argument parsing (pure) — same shape as run-case.js / score.js / compare.js: `--flag value` and
// `--flag=value` both work, and an unknown flag or an empty value aborts here rather than downstream.
// [LAW:parse-dont-validate] [LAW:no-silent-failure]
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { armA: null, armB: null, out: null };
  const keyFor = { out: 'out' };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const rawName = arg.slice(2, eq === -1 ? undefined : eq);
    if (!(rawName in keyFor)) throw new Error(`Unknown option: ${arg.slice(0, eq === -1 ? undefined : eq)}`);
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined || value === '' || (eq === -1 && value.startsWith('--'))) throw new Error(`Option --${rawName} requires a non-empty value.`);
    opts[keyFor[rawName]] = value;
  }
  if (positional.length < 2) throw new Error('Missing arm roots: paired.js takes TWO --out roots to compare. See --help.');
  if (positional.length > 2) throw new Error(`Unexpected third positional: ${positional[2]}. paired.js compares exactly two arms. See --help.`);
  [opts.armA, opts.armB] = positional;
  return opts;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// The plan's IDENTITY (pure)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

// [LAW:one-source-of-truth] The pairing key for a run's STRUCTURE, and the answer to "do these two runs
// carry the same plan?" — asked once, here, so the refusal below and the block grouping can never
// disagree about what "same" means.
//
// It keys on what the workers RAN — the scopes and the shared context — and deliberately not on
// `provenance` or `scoutUsage`. Provenance names the producer, and two runs can both say "pinned" while
// carrying different partitions; that mistake would silently pair arms across different structures,
// which is the one thing this file exists to prevent. Conversely a computed run whose partition equals
// a pinned one IS the same structure and pairs legitimately — so no separate pinned/computed check is
// needed here, and adding one would be a rival definition of the same rule.
// [LAW:single-enforcer]
//
// Object keys are sorted so a hand-written or re-serialized plan file keys the same as a recorded one;
// ARRAY order is preserved, because the order of scopes and of the files inside one is the order the
// prompts named them, and a plan that lists them differently is a different replay, not a re-spelling.
function planKey(plan) {
  return JSON.stringify(canonicalize({ context: plan.context, scopes: plan.scopes }));
}

// [LAW:one-source-of-truth] ONE short, collision-proof stand-in for a long exact value, used everywhere
// this file needs a name that is short enough to print and still injective: a plan key in a refusal, and
// the pair of roots a default --out directory belongs to. A second hash beside it would be a second answer
// to "are these the same thing".
function digest(text) {
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 8);
}

// [LAW:one-source-of-truth] The DEFAULT report directory for a comparison, minted from the same pair of
// roots armLabels names it by, so the name a reader sees and the directory it lands in describe one
// comparison. The labels are readable but not path-safe — a label that had to keep a parent carries a
// separator — and flattening those separators to '-' is a second non-injective map: `ab-sweep2`/`ab-sweep0`
// and `ab/sweep2`/`ab/sweep0` are two different comparisons that would flatten onto one directory and
// silently overwrite each other's report. So the readable part stays readable and the uniqueness is
// carried by a digest of the two resolved roots, which cannot collide with any character in a path.
// It is order-sensitive because A-vs-B and B-vs-A are different reports.
function pairedOutName(rootA, rootB) {
  const flatten = (label) => label.split(path.sep).join('-');
  return `paired-${armLabels(rootA, rootB).map(flatten).join('-vs-')}-${digest(`${rootA}\0${rootB}`)}`;
}

// [LAW:one-source-of-truth] The two arms' NAMES in the report, minted together from both roots, because
// a name is only useful if it distinguishes — and `basename` does not: `runsA/case-out` and
// `runsB/case-out` are two different arms with one name, which prints two indistinguishable halves and
// collides the default --out dir for two genuinely different comparisons.
//
// Each label is the root relative to the common ancestor of the two roots' PARENTS, so it is injective by
// construction and keeps exactly as much path as it takes to tell them apart: `eval/out/ab-sweep2` and
// `eval/out/ab-sweep0` still read `ab-sweep2` / `ab-sweep0`. Anchoring on the parents rather than the
// roots is what guarantees a label never shrinks to the empty string when one root sits inside the other.
// [LAW:dataflow-not-control-flow] One expression, always the same one — no "if the basenames collide" fork.
function armLabels(rootA, rootB) {
  const [a, b] = [path.dirname(rootA).split(path.sep), path.dirname(rootB).split(path.sep)];
  const firstDiff = a.findIndex((seg, i) => seg !== b[i]);
  const anchor = a.slice(0, firstDiff === -1 ? Math.min(a.length, b.length) : firstDiff).join(path.sep) || path.sep;
  return [path.relative(anchor, rootA), path.relative(anchor, rootB)];
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonicalize(value[k])]));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Reading an arm (effects at the edge; everything below this line is pure)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

// [LAW:parse-dont-validate] The checkpoint an arm root crosses to become an Arm: what goes in is a
// directory somebody named on the command line, what comes out is a list of runs each PROVEN to carry a
// case, an effort, a plan, and an inventory must-find scorecard. Nothing downstream re-checks a run.
// [LAW:no-silent-failure] A case dir with no scored runs, a run with no plan.json, a run scored before
// plan.json existed — each is refused BY NAME, because "your two arms don't line up" fifty runs deep is
// a message that sends the reader searching.
function readArm(root, label) {
  if (!fs.existsSync(path.resolve(root))) throw new Error(`Arm ${label}: root not found: ${path.resolve(root)}.`);
  // The CANONICAL root, symlinks followed: it is what makes "these two arms are the same directory"
  // answerable at all, and a symlinked second root is exactly how a self-comparison sneaks past a
  // string check — it would report zero discordants and p=1, which reads as a null result rather than
  // the degenerate comparison it is.
  const resolved = fs.realpathSync(path.resolve(root));
  const caseDirs = fs.readdirSync(resolved, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => path.join(resolved, e.name))
    .filter(d => listRunDirs(d).length > 0)
    .sort();
  if (caseDirs.length === 0) throw new Error(`Arm ${label}: no case dirs with scored runs under ${resolved}. Run eval/freeze-suite.js, then eval/score.js.`);

  const runs = [];
  for (const caseDir of caseDirs) {
    for (const dir of listRunDirs(caseDir)) runs.push(readRun(dir, path.basename(caseDir), label));
  }
  // An arm root is a run pool like any other, and score.js owns what one arm means. It matters most
  // here: the arm is the only thing meant to differ between the two roots, so a root that blended two
  // of them would put the difference under test on both sides of the comparison.
  return { label, root: resolved, effort: agreedEffort(runs), runs };
}

function readRun(dir, caseName, label) {
  const meta = parseMeta(readFileOrRefuse(path.join(dir, 'meta.json'), label, 'was never replayed to completion'), path.join(dir, 'meta.json'));
  // score.js owns what a misplaced run is; compare.js's readPriorRuns refuses one at the same kind of
  // boundary. Proven before the run's other artifacts are read, because which case a run belongs to is
  // what makes "this run recorded no plan" a sentence about the right case at all. Left to the inventory
  // check downstream, a misfiled run surfaces as expected.json drift and sends the operator hunting.
  const runCase = requireRunCase(meta, caseName, `Arm ${label}: ${dir}`);
  const plan = parsePlanRecord(
    readFileOrRefuse(path.join(dir, 'plan.json'), label, 'recorded no plan — it predates copirate-determinism-5od.ea7, so what structure it ran is unknown and it cannot be paired'),
    path.join(dir, 'plan.json'),
  );
  const scorecardPath = path.join(dir, 'scorecard.json');
  const scorecard = parseJsonObject(readFileOrRefuse(scorecardPath, label, 'is unscored — run eval/score.js over its case dir first'), scorecardPath);
  return {
    dir,
    case: runCase,
    // The RAW profile, not a rendering of it: agreedEffort owns how an effort is described, and a run
    // carrying a pre-rendered string would be compared as text by a function expecting a profile.
    effort: meta.effort,
    planKey: planKey(plan),
    provenance: plan.provenance,
    outcomes: outcomesOf(scorecard, dir),
  };
}

function readFileOrRefuse(file, label, why) {
  if (!fs.existsSync(file)) throw new Error(`Arm ${label}: ${path.dirname(file)} ${why} (no ${path.basename(file)}).`);
  return fs.readFileSync(file, 'utf8');
}

// [LAW:parse-dont-validate] A run's contribution to the comparison, lifted out of its scorecard as the
// one shape the pairing needs: findingId → was it found. The inventory must-find bucket is the metric
// deliberately and only — it is the gate metric eval/compare.js already protects, and a paired report
// over four different buckets would be four experiments wearing one p-value. [LAW:no-mode-explosion]
function outcomesOf(scorecard, dir) {
  const bucket = scorecard.inventoryMustFind;
  if (!bucket || !Array.isArray(bucket.foundIds) || !Array.isArray(bucket.missedIds)) {
    throw new Error(`${dir}/scorecard.json has no inventoryMustFind {foundIds, missedIds} — it was written by a scorer this reducer cannot read.`);
  }
  const outcomes = new Map();
  for (const id of bucket.foundIds) outcomes.set(String(id), true);
  for (const id of bucket.missedIds) outcomes.set(String(id), false);
  // [LAW:no-silent-failure] The scorecard says how many outcomes it recorded; a smaller map means two
  // findings shared an id (two null commentIds in a hand-authored inventory is the plausible way) and one
  // silently overwrote the other. Since every run collapses them identically, the inventory check below
  // cannot see it — the paired statistic would just quietly measure fewer findings than the case declares.
  const declared = bucket.foundIds.length + bucket.missedIds.length;
  if (outcomes.size !== declared) {
    throw new Error(
      `${dir}/scorecard.json records ${declared} inventory must-find outcome(s) under ${outcomes.size} distinct id(s) — ` +
      'ids collide, so a finding\'s outcome is unrecoverable. Pairing treats the finding id as the unit of comparison and cannot proceed.',
    );
  }
  return outcomes;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Pairing (pure) — the checkpoint that turns two arms into a matched sample, or refuses
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

// [LAW:parse-dont-validate] What comes out is a PairedSet: pairs whose two halves provably ran the same
// case, the same plan, and were scored against the same finding inventory. The statistic below takes
// that type and therefore asks no questions — there is nothing left to check.
//
// The unit of pairing is (case, plan, finding), exactly as the ticket's ACCEPT states. Within one
// (case, plan) BLOCK each arm may hold several replicates (`freeze-suite.js -n N --plans <dir>` replays
// one plan N times), and the k-th run of arm A is matched with the k-th run of arm B in sorted run-dir
// order. That alignment is ARBITRARY BUT DETERMINISTIC, and it is sound: given the plan, an arm's
// replicates are exchangeable, so P(A hit, B miss) = P(A miss, B hit) under the null for ANY one-to-one
// alignment — the exact McNemar test stays exact, and blocking on (case, plan) removes precisely the
// 26-point plan term the epic measured. What run k shares with run k is the block, and nothing else;
// the pairing claims nothing more than that.
function pairArms(armA, armB) {
  // The roots are canonical (readArm resolves symlinks), so this is the one place two spellings of one
  // directory can be told apart — and it must be told apart here, because pairing a dataset with itself
  // produces zero discordant pairs and p = 1, indistinguishable in the report from a real null result.
  if (armA.root === armB.root) {
    throw new Error(`Both arm roots are ${armA.root}. Pairing a root with itself compares nothing — every pair would agree by construction.`);
  }
  const cases = agreedCaseSet(armA, armB);
  const pairs = [];
  const blocks = [];
  for (const caseName of cases) {
    const inventory = agreedInventory(caseName, [...runsOfCase(armA, caseName), ...runsOfCase(armB, caseName)]);
    const byPlanA = groupByPlan(runsOfCase(armA, caseName));
    const byPlanB = groupByPlan(runsOfCase(armB, caseName));
    for (const key of agreedPlanSet(caseName, armA, byPlanA, armB, byPlanB)) {
      const replicatesA = byPlanA.get(key);
      const replicatesB = byPlanB.get(key);
      blocks.push({
        case: caseName,
        planKey: key,
        plan: digest(key),
        scopeCount: JSON.parse(key).scopes.length,
        provenance: [...new Set([...replicatesA, ...replicatesB].map(r => r.provenance))].sort().join('+'),
        replicates: replicatesA.length,
        findings: inventory.length,
      });
      for (let k = 0; k < replicatesA.length; k++) {
        for (const findingId of inventory) {
          pairs.push({
            case: caseName,
            planKey: key,
            replicate: k,
            findingId,
            a: replicatesA[k].outcomes.get(findingId),
            b: replicatesB[k].outcomes.get(findingId),
          });
        }
      }
    }
  }
  return { pairs, blocks };
}

function runsOfCase(arm, caseName) {
  return arm.runs.filter(r => r.case === caseName);
}

function groupByPlan(runs) {
  const byPlan = new Map();
  for (const run of runs) {
    if (!byPlan.has(run.planKey)) byPlan.set(run.planKey, []);
    byPlan.get(run.planKey).push(run);
  }
  return byPlan;
}

// [LAW:no-silent-failure] A case present in one arm and not the other is refused rather than dropped:
// silently intersecting would report a paired statistic over a case set the reader never chose, and the
// difference between "we compared four cases" and "we compared the three that lined up" is invisible in
// the number.
function agreedCaseSet(armA, armB) {
  const namesA = [...new Set(armA.runs.map(r => r.case))].sort();
  const namesB = [...new Set(armB.runs.map(r => r.case))].sort();
  const onlyA = namesA.filter(n => !namesB.includes(n));
  const onlyB = namesB.filter(n => !namesA.includes(n));
  if (onlyA.length || onlyB.length) {
    throw new Error(
      `The arms replayed different case sets and cannot be paired: ` +
      `${onlyA.length ? `only in ${armA.label} (${armA.root}): ${onlyA.join(', ')}. ` : ''}` +
      `${onlyB.length ? `only in ${armB.label} (${armB.root}): ${onlyB.join(', ')}. ` : ''}` +
      'Replay the missing cases, or pass --cases to both suites.',
    );
  }
  return namesA;
}

// THE REFUSAL THE ACCEPT NAMES: runs whose plans differ are not paired. The check is a multiset equality
// per case — same plans, same number of replicates each — so a plan present in only one arm, or replayed
// a different number of times, refuses instead of pairing across structures or against a shorter list.
// [LAW:no-silent-failure] The refusal names the case, the scope counts, and both roots, because "a plan
// differs" without them sends the reader diffing JSON by hand.
function agreedPlanSet(caseName, armA, byPlanA, armB, byPlanB) {
  const keys = [...byPlanA.keys()].sort();
  const describe = (byPlan) => (byPlan.size === 0 ? 'none' : [...byPlan.entries()]
    // The digest, not just the scope count: a --plans dir can hold two different 3-scope splits of one
    // change, and a refusal offering only the count cannot say which plan is missing from which arm.
    .map(([key, runs]) => `${JSON.parse(key).scopes.length} scope(s) [${digest(key)}] ×${runs.length}`).sort().join(', '));
  for (const key of new Set([...byPlanA.keys(), ...byPlanB.keys()])) {
    const a = byPlanA.get(key);
    const b = byPlanB.get(key);
    if (!a || !b || a.length !== b.length) {
      throw new Error(
        `Case '${caseName}': the arms did not replay the same plans, so their runs cannot be paired — ` +
        `${armA.label} (${armA.root}) has ${describe(byPlanA)}; ${armB.label} (${armB.root}) has ${describe(byPlanB)}. ` +
        'A paired A/B holds the plan fixed across arms: run both suites with the same --plans <dir>.',
      );
    }
  }
  return keys;
}

// [LAW:no-silent-failure] Every run of a case must have been scored against the same must-find
// inventory. A differing id set means the case's expected.json moved between the two replays, so the
// two arms answered different questions — the defect copirate-determinism-5od.xlo closes at the source,
// refused here because pairing is where it would otherwise be laundered into a rate.
function agreedInventory(caseName, runs) {
  const [first, ...rest] = runs;
  const inventory = [...first.outcomes.keys()].sort();
  for (const run of rest) {
    const ids = [...run.outcomes.keys()].sort();
    if (ids.join(',') !== inventory.join(',')) {
      // The ids themselves, not their counts: a same-size swap (5 for 6) prints two identical halves and
      // leaves the operator with a refusal they cannot act on. [LAW:no-silent-failure]
      const only = (a, b) => a.filter(id => !b.includes(id));
      throw new Error(
        `Case '${caseName}': ${run.dir} was scored against must-find(s) [${ids.join(', ')}] but ${first.dir} against [${inventory.join(', ')}] — ` +
        `only in the first: [${only(ids, inventory).join(', ')}]; only in the second: [${only(inventory, ids).join(', ')}]. ` +
        'The case inventory moved between these replays; they measure different things and cannot be paired.',
      );
    }
  }
  return inventory;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// The statistic (pure)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

// P(X ≤ k) for X ~ Binomial(n, ½), summed EXACTLY in log space. Log space rather than raw binomial
// coefficients so the sum stays finite for any pair count this harness could ever produce, instead of
// silently returning NaN past n≈1030 where C(n, n/2) overflows a double. [LAW:no-silent-failure]
function binomialTailHalf(n, k) {
  const logFactorial = [0, 0];
  for (let i = 2; i <= n; i++) logFactorial[i] = logFactorial[i - 1] + Math.log(i);
  let sum = 0;
  for (let i = 0; i <= k; i++) {
    sum += Math.exp(logFactorial[n] - logFactorial[i] - logFactorial[n - i] - n * Math.LN2);
  }
  return Math.min(1, sum);
}

// McNemar's test, EXACT (the two-sided binomial sign test on the discordant pairs) rather than the
// chi-square approximation: the discordant counts this harness produces are small — a handful out of a
// hundred pairs — and the approximation is untrustworthy exactly there.
// Zero discordant pairs is p = 1, which is the honest reading: the arms disagreed nowhere, so there is
// no evidence of a difference — NOT an absence of data. [LAW:parse-dont-validate]
function mcnemarExact(discordantAB, discordantBA) {
  const n = discordantAB + discordantBA;
  if (n === 0) return 1;
  return Math.min(1, 2 * binomialTailHalf(n, Math.min(discordantAB, discordantBA)));
}

// [LAW:effects-at-boundaries] Pure: pairs in, verdict out. The two pooled rates are reported alongside
// the paired statistic, over the SAME paired set, so the effect size and its significance describe one
// population and cannot be quoted against each other.
//
// `mde95` is the resolution this comparison bought: 1.96 × the SE of the paired difference (√(b+c)/n),
// which is the smallest arm difference a NORMAL approximation would call significant at 95%. It is
// printed unconditionally, including when the result is null, because "no significant difference" is
// uninterpretable without the size of the difference the instrument could have seen — and it is the
// number copirate-determinism-5od.6e8 consumes to state a design's power before it is bought.
// It is an APPROXIMATION and it is optimistic at small discordant counts: with b+c under about ten,
// 1.96·SE can sit below a difference the exact test above still declines to call significant. The exact
// p is the ruling; mde95 is the design figure. Both are reported so neither can be quoted as the other.
function reducePaired(pairs) {
  const tally = { bothFound: 0, discordantAB: 0, discordantBA: 0, bothMissed: 0 };
  for (const { a, b } of pairs) {
    if (a && b) tally.bothFound++;
    else if (a && !b) tally.discordantAB++;
    else if (!a && b) tally.discordantBA++;
    else tally.bothMissed++;
  }
  const n = pairs.length;
  const discordant = tally.discordantAB + tally.discordantBA;
  const rate = (found) => (n === 0 ? null : found / n);
  return {
    pairs: n,
    ...tally,
    discordant,
    rateA: rate(tally.bothFound + tally.discordantAB),
    rateB: rate(tally.bothFound + tally.discordantBA),
    difference: n === 0 ? null : (tally.discordantAB - tally.discordantBA) / n,
    standardError: n === 0 ? null : Math.sqrt(discordant) / n,
    mde95: n === 0 ? null : (1.96 * Math.sqrt(discordant)) / n,
    p: mcnemarExact(tally.discordantAB, tally.discordantBA),
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Rendering (pure). ONE renderer — Markdown — for the same reason compare.js has one: the table is meant
// to be pasted into a PR body or a ticket comment, and it reads fine in a terminal. [LAW:no-mode-explosion]
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

function renderPairedMarkdown(report) {
  const pct = (v) => (v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`);
  const signedPct = (v) => (v === null ? 'n/a' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`);
  const s = report.stat;
  const significant = s.p < 0.05;
  const lines = [
    `## Paired A/B — inventory must-find recall`,
    '',
    `Arm A \`${report.armA.label}\` (effort ${report.armA.effort}) vs arm B \`${report.armB.label}\` (effort ${report.armB.effort}) · ` +
      `${report.blocks.length} plan block(s) over ${report.cases.length} case(s) · ${s.pairs} paired opportunities.`,
    '',
    `**Paired result:** ${s.discordantAB} pair(s) found only by A, ${s.discordantBA} only by B ` +
      `(${s.discordant} discordant of ${s.pairs}; ${s.bothFound} found by both, ${s.bothMissed} by neither) → ` +
      `exact McNemar **p = ${s.p.toFixed(4)}**${significant ? ' (significant at α=0.05)' : ' (not significant at α=0.05)'}.`,
    '',
    `**Pooled over the same paired set:** A ${pct(s.rateA)} vs B ${pct(s.rateB)} → Δ **${signedPct(s.difference)}** ` +
      `(paired SE ${pct(s.standardError)}; approximate 95% resolution **${pct(s.mde95)}** — the design figure, not the ruling).`,
    '',
    '| case | plan | scopes | provenance | replicates/arm | must-finds | A only | B only | both | neither |',
    '|------|------|--------|------------|----------------|------------|--------|--------|------|---------|',
  ];
  for (const block of report.blocks) {
    lines.push(
      `| \`${block.case}\` | \`${block.plan}\` | ${block.scopeCount} | ${block.provenance} | ${block.replicates} | ${block.findings} | ` +
      `${block.stat.discordantAB} | ${block.stat.discordantBA} | ${block.stat.bothFound} | ${block.stat.bothMissed} |`,
    );
  }
  lines.push('');
  lines.push(
    significant
      ? `**VERDICT: arm ${s.difference >= 0 ? 'A' : 'B'} found more**, holding the plan fixed — ${signedPct(Math.abs(s.difference))} on ${s.discordant} discordant pair(s), p = ${s.p.toFixed(4)}.`
      : `**VERDICT: no measured difference** between the arms with the plan held fixed (p = ${s.p.toFixed(4)}). ` +
        `The point estimate is ${signedPct(s.difference)}, against an approximate 95% resolution of ${pct(s.mde95)}.`,
  );
  lines.push('');
  return lines.join('\n') + '\n';
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Effects (main) — read both roots, pair, reduce, write.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(USAGE);
    return;
  }

  const armA = readArm(opts.armA, 'A');
  const armB = readArm(opts.armB, 'B');
  const { pairs, blocks } = pairArms(armA, armB);

  const [labelA, labelB] = armLabels(armA.root, armB.root);
  const report = {
    armA: { label: labelA, root: armA.root, effort: armA.effort },
    armB: { label: labelB, root: armB.root, effort: armB.effort },
    cases: [...new Set(blocks.map(b => b.case))],
    // Every block carries its own reduction of the same shape as the whole — one statistic function, so a
    // per-block number and the headline can never be computed two different ways. [LAW:one-source-of-truth]
    blocks: blocks.map(block => ({
      ...block,
      stat: reducePaired(pairs.filter(p => p.case === block.case && p.planKey === block.planKey)),
    })),
    stat: reducePaired(pairs),
  };
  // The block's plan key is its identity for grouping, not something a report reader needs; it is the
  // whole plan JSON and would swamp the artifact.
  for (const block of report.blocks) delete block.planKey;

  const outDir = path.resolve(opts.out || path.join(__dirname, 'out', pairedOutName(armA.root, armB.root)));
  fs.mkdirSync(outDir, { recursive: true });
  const markdown = renderPairedMarkdown(report);
  fs.writeFileSync(path.join(outDir, 'paired.json'), JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, 'paired.md'), markdown);
  process.stdout.write('\n' + markdown);
  process.stdout.write(`Wrote paired.{md,json} → ${outDir}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`paired: ${err.message}\n`);
    // 2 = could not run, the same trichotomy slot eval/compare.js uses for a refusal. Never 1: this
    // reporter has no failing outcome to signal.
    process.exit(2);
  }
}

module.exports = { parseArgs, planKey, digest, armLabels, pairedOutName, canonicalize, readArm, pairArms, agreedCaseSet, agreedPlanSet, agreedInventory, binomialTailHalf, mcnemarExact, reducePaired, renderPairedMarkdown };
