'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { parseArgs, parseCaseManifest, resolvePinnedConfig, assertConfigMatchesPin, runDirName, buildCaseMaterial } = require('../eval/run-case');
const { DEFAULT_SWEEP_CAP, DEFAULT_READ_SET, READ_SETS } = require('../src/effort');

test('parseArgs takes the required positional and applies defaults', () => {
  const o = parseArgs(['eval/cases/foo']);
  assert.equal(o.caseDir, 'eval/cases/foo');
  assert.equal(o.repeats, 1);
  assert.equal(o.out, 'eval/out');
  // No budget given: the recorded absence, resolved to the whole host where the host is read.
  assert.equal(o.memoryBudget, null);
  // The arm has no absent case: unset IS the engine's own bound, read from the axis's owner rather than
  // copied, so main builds one effort profile with no branch on "was it given?".
  assert.equal(o.sweepCap, DEFAULT_SWEEP_CAP);
});

// [LAW:verifiable-goals] AC (copirate-measurement-2mg.1): the sweeps-off arm is expressible at the CLI,
// and only integers at or above 0 are — the cap bounds the chain, so a negative or fractional one is a
// typo, never a setting.
describe('parseArgs takes --sweep-cap as a non-negative integer, in both flag forms', () => {
  test('0 is a legal SETTING — the sweeps-off arm — not a rejected value', () => {
    assert.equal(parseArgs(['foo', '--sweep-cap', '0']).sweepCap, 0);
    assert.equal(parseArgs(['foo', '--sweep-cap=0']).sweepCap, 0);
    assert.equal(parseArgs(['foo', '--sweep-cap', '4']).sweepCap, 4);
  });

  test('a value outside {0,1,2,…} is refused, naming the flag and echoing what was typed', () => {
    for (const bad of ['-1', '1.5', 'lots', '']) {
      assert.throws(() => parseArgs(['foo', `--sweep-cap=${bad}`]), /--sweep-cap must be a non-negative integer/, `--sweep-cap=${bad}`);
    }
  });

  test('the counts keep their own floor: --repeats still refuses 0', () => {
    assert.throws(() => parseArgs(['foo', '-n', '0']), /must be a positive integer/);
  });
});

test('parseArgs takes --memory-budget as a positive integer of bytes, in both flag forms', () => {
  assert.equal(parseArgs(['foo', '--memory-budget', '8589934592']).memoryBudget, 8589934592);
  assert.equal(parseArgs(['foo', '--memory-budget=1024']).memoryBudget, 1024);
  assert.throws(() => parseArgs(['foo', '--memory-budget', '0']), /--memory-budget must be a positive integer/);
  assert.throws(() => parseArgs(['foo', '--memory-budget', '1.5']), /--memory-budget must be a positive integer/);
  assert.throws(() => parseArgs(['foo', '--memory-budget', 'lots']), /--memory-budget must be a positive integer/);
  assert.throws(() => parseArgs(['foo', '--memory-budget']), /--memory-budget requires a value/);
});

// [LAW:verifiable-goals] AC (copirate-measurement-2mg.2): the whole-changed-set read arm is expressible
// at the CLI, and ONLY the declared arms are — a misspelled arm must never resolve to the shipped one,
// because the arm's whole job is to name which behavior produced the recall number.
describe('parseArgs takes --read-set as one of the declared arms, in both flag forms', () => {
  test('the unshipped arm is a legal SETTING, and the vocabulary is the axis owner\'s, not a copy', () => {
    assert.equal(parseArgs(['foo', '--read-set', 'changed']).readSet, 'changed');
    assert.equal(parseArgs(['foo', '--read-set=changed']).readSet, 'changed');
    assert.equal(parseArgs(['foo', '--read-set=assigned']).readSet, 'assigned');
    for (const arm of READ_SETS) assert.equal(parseArgs(['foo', `--read-set=${arm}`]).readSet, arm);
  });

  test('unset is the engine\'s own default arm, with no absent case to branch on', () => {
    assert.equal(parseArgs(['foo']).readSet, DEFAULT_READ_SET);
  });

  test('a value outside the vocabulary is refused, naming the arms and echoing what was typed', () => {
    // '' is the `--read-set=` form: refused by membership, with no coercion step that could invent an
    // arm out of it — the enum counterpart of --sweep-cap='s Number('') === 0 trap.
    for (const bad of ['', 'all', 'Assigned', 'asigned', 'none', '0']) {
      assert.throws(() => parseArgs(['foo', `--read-set=${bad}`]), /--read-set must be one of assigned, changed/, `--read-set=${bad}`);
    }
    assert.throws(() => parseArgs(['foo', '--read-set']), /--read-set requires a value/);
  });
});

// [LAW:effects-at-boundaries] The plan leaves the parser as a PATH, never a record: reading and parsing
// the file is IO, and main does it at the run boundary beside every other file this replay opens. null is
// the absence with a meaning — 'this replay scouts its own partition' — and it is the SAME value
// runMultiScope's own parameter defaults to, so it flows all the way to the pass untranslated.
describe('parseArgs takes --plan as the path to a pinned plan', () => {
  test('both flag forms carry the path through unresolved', () => {
    assert.equal(parseArgs(['foo', '--plan', 'eval/out/c/run1/plan.json']).plan, 'eval/out/c/run1/plan.json');
    assert.equal(parseArgs(['foo', '--plan=plan.json']).plan, 'plan.json');
  });

  test('unset is the null the engine already means by it — no pinned/unpinned mode to set', () => {
    assert.equal(parseArgs(['foo']).plan, null);
  });

  test('a missing value is refused here, not discovered as a file named --out', () => {
    assert.throws(() => parseArgs(['foo', '--plan']), /--plan requires a value/);
    assert.throws(() => parseArgs(['foo', '--plan', '--out', 'x']), /--plan requires a value, but got what looks like another flag/);
  });
});

test('parseArgs supports -n alias, --flag=value, and --help', () => {
  const o = parseArgs(['eval/cases/foo', '-n', '3', '--out=tmp/out']);
  assert.equal(o.repeats, 3);
  assert.equal(o.out, 'tmp/out');
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).help, true);
});

test('parseArgs rejects bad input loudly', () => {
  assert.throws(() => parseArgs([]), /Missing required <case-dir>/);
  assert.throws(() => parseArgs(['a', 'b']), /Unexpected second positional/);
  assert.throws(() => parseArgs(['foo', '--nope', 'v']), /Unknown option/);
  assert.throws(() => parseArgs(['foo', '--repeats']), /requires a value/);
  // An alias is reported under its canonical spelling — a flag the reader can find, not --n.
  assert.throws(() => parseArgs(['foo', '-n']), /Option --repeats requires a value/);
  assert.throws(() => parseArgs(['foo', '-n', '0']), /positive integer/);
  assert.throws(() => parseArgs(['foo', '-n', 'x']), /positive integer/);
  // Non-integers are rejected, never silently truncated (parseInt('2.5') would have accepted 2).
  assert.throws(() => parseArgs(['foo', '-n', '2.5']), /positive integer/);
  assert.throws(() => parseArgs(['foo', '-n', '3.7']), /positive integer/);
  assert.throws(() => parseArgs(['foo', '-n', '2abc']), /positive integer/);
  // A valid positive integer still parses to a number.
  assert.equal(parseArgs(['foo', '-n', '3']).repeats, 3);
  // A `--`-prefixed value is a swallowed flag, not a path — rejected rather than silently consumed.
  assert.throws(() => parseArgs(['foo', '--out', '--repeats=2']), /looks like another flag/);
  // A single-dash value (a negative number) still routes to its own validator, not the flag guard.
  assert.throws(() => parseArgs(['foo', '-n', '-1']), /positive integer/);
});

const VALID_CASE = JSON.stringify({
  name: 'demo', diff: 'change.diff', tree: 'repo.tar.gz', expected: 'expected.json',
  engine: { provider: 'deepseek', model: 'deepseek-v4-pro', reasoning: null },
  excludePatterns: ['*.lock'],
});

test('parseCaseManifest resolves paths and normalizes reasoning', () => {
  const m = parseCaseManifest(VALID_CASE, '/cases/demo');
  assert.equal(m.name, 'demo');
  assert.equal(m.diffPath, path.join('/cases/demo', 'change.diff'));
  assert.equal(m.treePath, path.join('/cases/demo', 'repo.tar.gz'));
  assert.deepEqual(m.engine, { provider: 'deepseek', model: 'deepseek-v4-pro', reasoning: null });
  assert.deepEqual(m.excludePatterns, ['*.lock']);
});

test('parseCaseManifest defaults absent reasoning to null and excludePatterns to []', () => {
  const m = parseCaseManifest(JSON.stringify({
    name: 'x', diff: 'd', tree: 't', engine: { provider: 'deepseek', model: 'm' },
  }), '/cases/x');
  assert.equal(m.engine.reasoning, null);
  assert.deepEqual(m.excludePatterns, []);
});

test('parseCaseManifest fails loudly on malformed input', () => {
  assert.throws(() => parseCaseManifest('{not json', '/cases/x'), /not valid JSON/);
  assert.throws(() => parseCaseManifest('{}', '/cases/x'), /missing a valid string 'name'/);
  assert.throws(() => parseCaseManifest(JSON.stringify({ name: 'x', diff: 'd', tree: 't' }), '/cases/x'), /missing an 'engine'/);
  assert.throws(() => parseCaseManifest(JSON.stringify({ name: 'x', diff: 'd', tree: 't', engine: { model: 'm' } }), '/cases/x'), /engine\.provider/);
  assert.throws(() => parseCaseManifest(JSON.stringify({ name: 'x', diff: 'd', tree: 't', engine: { provider: 'p' } }), '/cases/x'), /engine\.model/);
  assert.throws(() => parseCaseManifest(JSON.stringify({ name: 'x', diff: 'd', tree: 't', engine: { provider: 'p', model: 'm' }, excludePatterns: 'no' }), '/cases/x'), /excludePatterns.*array/);
  assert.throws(() => parseCaseManifest(JSON.stringify({ name: 'x', diff: 'd', tree: 't', engine: { provider: 'p', model: 'm', reasoning: 3 } }), '/cases/x'), /reasoning.*non-empty string/);
  // An empty-string reasoning is rejected at the boundary, not surfaced as a confusing pin mismatch later.
  assert.throws(() => parseCaseManifest(JSON.stringify({ name: 'x', diff: 'd', tree: 't', engine: { provider: 'p', model: 'm', reasoning: '' } }), '/cases/x'), /reasoning.*non-empty string/);
  // A name that isn't a plain path component can't reach path.join.
  assert.throws(() => parseCaseManifest(JSON.stringify({ name: '../evil', diff: 'd', tree: 't', engine: { provider: 'p', model: 'm' } }), '/c'), /plain directory component/);
  assert.throws(() => parseCaseManifest(JSON.stringify({ name: 'a/b', diff: 'd', tree: 't', engine: { provider: 'p', model: 'm' } }), '/c'), /plain directory component/);
  assert.throws(() => parseCaseManifest(JSON.stringify({ name: '..', diff: 'd', tree: 't', engine: { provider: 'p', model: 'm' } }), '/c'), /plain directory component/);
  // A name carrying a comma cannot travel on freeze-suite.js's comma-separated --cases.
  assert.throws(() => parseCaseManifest(JSON.stringify({ name: 'a,b', diff: 'd', tree: 't', engine: { provider: 'p', model: 'm' } }), '/c'), /plain directory component.*commas/);
  // One identity per case: the manifest's name must be its directory's name.
  assert.throws(() => parseCaseManifest(JSON.stringify({ name: 'alpha', diff: 'd', tree: 't', engine: { provider: 'p', model: 'm' } }), '/cases/renamed'), /"alpha" but its directory is "renamed"/);
});

// THE regression this file exists to hold. The harness used to hand-build the provider input bag from a
// list of key names it kept privately, and that list omitted claude-subscription — so the instrument
// that measures review quality could not replay on the provider production runs on, and said so only as
// a confusing "credential not set". Parameterizing over the real PROVIDERS table means a provider row
// added tomorrow is covered the day it lands, rather than the day someone notices. [LAW:no-silent-failure]
describe('resolvePinnedConfig reaches every provider in the table', () => {
  const { PROVIDERS, PRESETS } = require('../src/provider');

  for (const [name, spec] of Object.entries(PROVIDERS)) {
    test(`'${name}': a case pinned to it resolves to a config carrying the pin`, () => {
      const engine = { provider: name, model: spec.defaultModel, reasoning: null };
      const config = resolvePinnedConfig(engine, { [spec.credentialInput]: 'test-credential' });
      assert.equal(config.model, spec.defaultModel);
      assert.equal(config.engine, spec.engine);
      assert.equal(config.endpoint.credential.value, 'test-credential');
    });

    // The credential must come from the row's OWN env var: a case pinned to one provider must never
    // resolve by picking up whatever other credential happens to be in the environment.
    test(`'${name}': never resolves from another provider's credential`, () => {
      const foreign = Object.values(PROVIDERS)
        .filter(s => s.credentialInput !== spec.credentialInput)
        .reduce((env, s) => ({ ...env, [s.credentialInput]: 'wrong-credential' }), {});
      // Reduced to a value so both outcomes are asserted the same way, rather than one of them being
      // an early return out of the test. [LAW:dataflow-not-control-flow]
      const outcome = (() => {
        try {
          return { credential: resolvePinnedConfig({ provider: name, model: spec.defaultModel, reasoning: null }, foreign).endpoint.credential.value };
        } catch (err) {
          return { error: err.message };
        }
      })();

      // The invariant itself, identical for every row: a credential the row did not name never reaches
      // the config.
      assert.notStrictEqual(outcome.credential, 'wrong-credential');

      // How a row can UPHOLD it differs, and `credentialOptional` — table data, never a hardcoded
      // provider name — says which shape to expect. A row that needs a credential has only refusal
      // available, and the refusal must name the input to set. A row whose credential is optional has
      // nothing to demand, so it upholds the same invariant by resolving carrying none; asserting the
      // refusal alone would read that compliant shape as a violation and push the row out of this
      // sweep, which is the one place the invariant is checked over the whole table.
      // Either way the value is stringified before matching, so an outcome of the wrong SHAPE — an
      // absent key — matches neither pattern and fails here rather than passing vacuously.
      const expected = PRESETS[spec.preset].credentialOptional
        ? { key: 'credential', matches: /^$/ }
        : { key: 'error', matches: new RegExp(spec.credentialInput) };
      assert.match(String(outcome[expected.key]), expected.matches);
    });
  }
});

test('resolvePinnedConfig pins a non-default model through the provider it names', () => {
  const config = resolvePinnedConfig(
    { provider: 'claude-subscription', model: 'claude-opus-5', reasoning: null },
    { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token' },
  );
  assert.equal(config.model, 'claude-opus-5');
});

test('resolvePinnedConfig refuses a pin the resolved provider cannot carry', () => {
  // claude-subscription's row declares no reasoning key, so a reasoning pin has nowhere to land and is
  // silently dropped by resolution. The checkpoint is what turns that into a loud refusal — replaying
  // at a different effort than the case pins would corrupt every number measured against it.
  assert.throws(
    () => resolvePinnedConfig(
      { provider: 'claude-subscription', model: 'claude-sonnet-5', reasoning: 'high' },
      { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token' },
    ),
    /Reasoning-pin mismatch/,
  );
});

test('resolvePinnedConfig resolves the `auto` alias to the provider production runs on', () => {
  // The drift this whole change exists to close: `auto` is what production names, and a case pinned to
  // it must reach the concrete provider the alias currently points at, credential and all.
  const { PROVIDER_ALIASES, PROVIDERS } = require('../src/provider');
  const target = PROVIDERS[PROVIDER_ALIASES.auto];
  const config = resolvePinnedConfig(
    { provider: 'auto', model: target.defaultModel, reasoning: null },
    { [target.credentialInput]: 'live-credential' },
  );
  assert.equal(config.endpoint.credential.value, 'live-credential');
  assert.equal(config.model, target.defaultModel);
});

test('assertConfigMatchesPin returns the config when the pin holds', () => {
  const config = { model: 'deepseek-v4-pro', reasoning: null };
  assert.equal(assertConfigMatchesPin(config, { model: 'deepseek-v4-pro', reasoning: null }), config);
  // undefined reasoning on the config is treated as the same "no reasoning" as a null pin
  const c2 = { model: 'm' };
  assert.equal(assertConfigMatchesPin(c2, { model: 'm', reasoning: null }), c2);
});

test('assertConfigMatchesPin refuses a model or reasoning drift loudly', () => {
  assert.throws(
    () => assertConfigMatchesPin({ model: 'other-model' }, { model: 'deepseek-v4-pro', reasoning: null }),
    /Model-pin mismatch.*deepseek-v4-pro.*other-model/,
  );
  assert.throws(
    () => assertConfigMatchesPin({ model: 'm', reasoning: 'low' }, { model: 'm', reasoning: 'high' }),
    /Reasoning-pin mismatch/,
  );
});

test('runDirName composes an append-only, sortable run directory name', () => {
  assert.equal(runDirName('2026-08-01T17-43-00-123Z', 2), '2026-08-01T17-43-00-123Z-run2');
});

// ── buildCaseMaterial — the replay's filter → material path ───────────────────────────────────────
// This wiring broke silently once already: filterFiles' return shape changed and nothing under
// `npm test` executed it, so a green suite hid a guaranteed TypeError. The contract asserted here is
// what a replay must reproduce — production's filtering AND production's material, note included.

const CASE_FILES = [
  { filename: 'src/a.js', status: 'modified', patch: '@@ -1,1 +1,1 @@\n+const x = 1;' },
  { filename: 'dist/index.js', status: 'modified', patch: '@@ -1,1 +1,1 @@\n+bundled' },
];
const CASE_TOOL_NAMES = {
  requestChange: 'mcp__review_collector__request_change',
  finishReview: 'mcp__review_collector__finish_review',
  addScope: 'mcp__review_collector__add_scope',
  assessDependency: 'mcp__review_collector__assess_dependency',
};

test("buildCaseMaterial filters the case through production's seam and returns the split", () => {
  const { files, excluded, material } = buildCaseMaterial({
    allFiles: CASE_FILES, excludePatterns: ['dist/**'], reviewedRepoRoot: '/tmp/tree',
  });
  assert.deepEqual(files.map(f => f.filename), ['src/a.js']);
  assert.deepEqual(excluded, { patterns: ['dist/**'], paths: ['dist/index.js'] });
  assert.deepEqual(material.changedPaths, ['src/a.js']);
});

// The specific regression the extraction exists to catch: `excluded` silently dropping out of the
// buildPrMaterial call would leave a replay scoring the reviewer against a prompt production never sends.
test("buildCaseMaterial threads the exclusion record into the material, so a replay renders production's prompts", () => {
  const { material } = buildCaseMaterial({
    allFiles: CASE_FILES, excludePatterns: ['dist/**'], reviewedRepoRoot: '/tmp/tree',
  });
  const worker = material.buildWorkerPrompt('scope', CASE_TOOL_NAMES, { assigned: ['src/a.js'], read: ['src/a.js'] });
  assert.match(worker, /Withheld from this diff — changed in this pull request:\*\* dist\/index\.js/);
  assert.match(material.buildScoutPrompt(CASE_TOOL_NAMES), /Withheld from the list above — changed in this pull request:\*\* dist\/index\.js/);
});

test('buildCaseMaterial with no exclusions reviews every file and says nothing about exclusion', () => {
  const { files, excluded, material } = buildCaseMaterial({
    allFiles: CASE_FILES, excludePatterns: [], reviewedRepoRoot: '/tmp/tree',
  });
  assert.equal(files.length, 2);
  assert.deepEqual(excluded.paths, []);
  assert.ok(!material.buildWorkerPrompt('scope', CASE_TOOL_NAMES).includes('EXCLUDE_PATTERNS'));
});

test('buildCaseMaterial refuses a case whose patterns exclude everything, rather than replaying it empty', () => {
  assert.throws(
    () => buildCaseMaterial({ allFiles: CASE_FILES, excludePatterns: ['**'], reviewedRepoRoot: '/tmp/tree' }),
    /All 2 changed file\(s\) were excluded/,
  );
});

// The `reasoning` coverage above proves only that the field is correctly ABSENT: it goes through
// claude-subscription, whose row declares no `reasoning` key, so no reasoning value is ever threaded
// through the assembly loop at all. `credential` and `model` on that two-field row were the only fields
// any test carried end-to-end — a scrambled `Object.entries(spec.inputKeys)` mapping would go unseen on
// the third and fourth field every other row declares. Parameterized over the table for the same reason
// the block above is: a row that grows a field tomorrow is covered the day it lands. [LAW:no-silent-failure]
describe('resolvePinnedConfig carries a pinned reasoning through the rows that declare one', () => {
  const { PROVIDERS } = require('../src/provider');
  const registry = require('../src/engine/registry');

  for (const [name, spec] of Object.entries(PROVIDERS).filter(([, s]) => 'reasoning' in s.inputKeys)) {
    for (const effort of registry.get(spec.engine).capabilities.reasoningEfforts) {
      test(`'${name}' pinned to reasoning '${effort}' resolves to a config carrying it`, () => {
        const config = resolvePinnedConfig(
          { provider: name, model: spec.defaultModel, reasoning: effort },
          { [spec.credentialInput]: 'test-credential' },
        );
        assert.equal(config.reasoning, effort);
        assert.equal(config.model, spec.defaultModel);
      });
    }

    test(`'${name}' rejects a reasoning its engine does not offer, naming what is allowed`, () => {
      assert.throws(
        () => resolvePinnedConfig(
          { provider: name, model: spec.defaultModel, reasoning: 'ludicrous' },
          { [spec.credentialInput]: 'test-credential' },
        ),
        /reasoning 'ludicrous' is not valid for engine/,
      );
    });
  }
});

// ── tree identity: what a run records, what the gate compares ─────────────────────────────────────────
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const { workingTree, treeIdentity, writeRunRecord } = require('../eval/run-case');

// Minted through the real producer for the same reason the schedule fixtures are: these tests are the
// only prose describing what a run dir contains, so a hand-fabricated plan here is a shape a future
// reader would code against and no producer would ever emit. [LAW:one-source-of-truth]
const mintedPlan = () => require('../src/plan').planRecord({
  provenance: 'scout',
  context: 'ctx',
  scopes: [{ name: 'auth', focus: 'the auth change', files: ['src/auth.js'] }],
  scoutUsage: null,
});

test('workingTree reads this checkout: HEAD as git reports it, dirtiness as a known boolean', () => {
  const tree = workingTree();
  assert.equal(tree.sha, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.join(__dirname, '..') }).toString().trim());
  assert.equal(typeof tree.dirty, 'boolean');
});

test('workingTree outside any git repo fails with git\'s own message — never a tree reported clean', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-repo-'));
  try {
    assert.throws(() => workingTree(dir), /not a git repository/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('workingTree counts tracked modifications as dirty and untracked files as nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-'));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
    git('init', '-q');
    git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    git('add', 'a.txt'); git('commit', '-q', '-m', 'a');
    const sha = git('rev-parse', 'HEAD');
    assert.deepEqual(workingTree(dir), { sha, dirty: false });
    fs.writeFileSync(path.join(dir, 'scratch.txt'), 'untracked\n');
    assert.deepEqual(workingTree(dir), { sha, dirty: false });
    fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
    assert.deepEqual(workingTree(dir), { sha, dirty: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('treeIdentity: only a clean commit is an identity', () => {
  assert.equal(treeIdentity({ sha: 'abc123', dirty: false }), 'abc123');
  assert.equal(treeIdentity({ sha: 'abc123', dirty: true }), null);
});

test('writeRunRecord: a counted run dir is a complete one — findings.json lands last, and a record that cannot finish is never counted', () => {
  const { listRunDirs } = require('../eval/score');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-record-'));
  try {
    const ok = path.join(root, 'case', 'r1');
    fs.mkdirSync(ok, { recursive: true });
    // Minted, not fabricated — this test is about write ORDER, but a wrong-shaped schedule sitting in it is
    // still a shape a reader could copy. [LAW:one-source-of-truth]
    const schedule = require('../src/schedule').scheduleRecord({ laneCount: 2, sweepCap: 1, scopeCount: 2, spawns: [] });
    const plan = mintedPlan();
    writeRunRecord(ok, { meta: { case: 'case' }, summary: 's', usage: { u: 1 }, schedule, plan, findings: [{ path: 'a', line: 1 }] });
    assert.deepEqual(fs.readdirSync(ok).sort(), ['findings.json', 'meta.json', 'plan.json', 'schedule.json', 'summary.txt', 'usage.json']);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ok, 'findings.json'), 'utf8')), [{ path: 'a', line: 1 }]);

    const broken = path.join(root, 'case', 'r2');
    fs.mkdirSync(broken, { recursive: true });
    assert.throws(() => writeRunRecord(broken, { meta: { case: 'case' }, summary: 's', usage: {}, schedule, plan, findings: [1n] }), TypeError);
    assert.deepEqual(fs.readdirSync(broken).sort(), ['meta.json', 'plan.json', 'schedule.json', 'summary.txt', 'usage.json']);
    assert.deepEqual(listRunDirs(path.join(root, 'case')), [ok]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writeRunRecord: an absent fact fails loudly instead of landing as a file that parses as nothing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-undef-'));
  try {
    const schedule = require('../src/schedule').scheduleRecord({ laneCount: 1, sweepCap: 1, scopeCount: 1, spawns: [] });
    const record = { meta: { case: 'case' }, summary: 's', usage: { u: 1 }, schedule, plan: mintedPlan(), findings: [] };
    // `JSON.stringify(undefined)` is the VALUE undefined, and `undefined + '\n'` is the literal text
    // "undefined" — so an unguarded write lands an artifact that reports as JSON and parses as nothing.
    // Every field carries the same exposure, so every field is checked, not just the newest one.
    // summary.txt is raw text rather than JSON, and corrupts by the identical coercion — so it is checked
    // here with the rest. Every field the record carries, not only the ones that render as JSON.
    const artifact = { meta: 'meta.json', usage: 'usage.json', schedule: 'schedule.json', plan: 'plan.json', findings: 'findings.json', summary: 'summary.txt' };
    for (const [field, file] of Object.entries(artifact)) {
      const dir = path.join(root, field);
      fs.mkdirSync(dir, { recursive: true });
      assert.throws(
        () => writeRunRecord(dir, { ...record, [field]: undefined }),
        new RegExp(`${field} is undefined`),
        `${field}: an absent fact must abort the record, not be written as the text "undefined"`,
      );
      assert.equal(fs.existsSync(path.join(dir, file)), false, `${file} must not exist`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writeRunRecord: a replay\'s wall clock survives as an artifact, readable through the same span boundary the rest of the system uses', () => {
  // Built through the REAL mints, never hand-fabricated: this test is the only thing documenting what
  // schedule.json contains, so a shape invented here is a shape a future reader would code against and a
  // producer would never emit. Going through scheduleRecord/spawnRecord means the fixture cannot drift from
  // what src/schedule.js actually writes — it would throw first. [LAW:one-source-of-truth]
  const { spanMs, scheduleRecord, spawnRecord } = require('../src/schedule');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-clock-'));
  try {
    const runDir = path.join(root, 'case', 'r1');
    fs.mkdirSync(runDir, { recursive: true });
    // One scout of 60s and one worker of 90s — the shape run.js already posts, so the eval artifact and the
    // PR footer read one timing fact, not two. The span rides on `usage`, which is where describeSchedule
    // reads it from.
    const schedule = scheduleRecord({
      laneCount: 1,
      sweepCap: 2,
      scopeCount: 1,
      spawns: [
        spawnRecord({ phase: 'scout' }, 'completed', { span: { from: '2026-09-08T00:00:00.000Z', to: '2026-09-08T00:01:00.000Z' } }),
        spawnRecord({ phase: 'worker', scope: 'docs', pass: 0 }, 'completed', { span: { from: '2026-09-08T00:01:00.000Z', to: '2026-09-08T00:02:30.000Z' } }),
      ],
    });
    writeRunRecord(runDir, { meta: { case: 'case' }, summary: 's', usage: {}, schedule, plan: mintedPlan(), findings: [] });

    const recorded = JSON.parse(fs.readFileSync(path.join(runDir, 'schedule.json'), 'utf8'));
    assert.deepEqual(recorded, schedule);
    // The point of recording it: a per-replay duration is derivable from the artifact alone, with no CI
    // log to scrape and nothing to re-measure. This is what LEVER 3 on zai-eval-harness-5ux needs.
    assert.deepEqual(recorded.spawns.map(s => spanMs(s.usage.span)), [60_000, 90_000]);
    // The discriminator a reader keys on: a worker names its scope and pass, a scout carries neither.
    assert.deepEqual(recorded.spawns.map(s => s.phase), ['scout', 'worker']);
    assert.equal(recorded.spawns[1].scope, 'docs');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
