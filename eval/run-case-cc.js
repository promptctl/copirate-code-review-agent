#!/usr/bin/env node
'use strict';
// THE SECOND PRODUCER — replay a FROZEN eval case through Claude Code's built-in `/code-review` skill and
// write the same run record eval/score.js already reduces.
//
// The question this exists to answer, cheaply and repeatably: is this repo's review engine better than
// just running the built-in reviewer on the same diff? Both arms are measured against the SAME
// hand-annotated ground truth (eval/cases/*/expected.json) by the SAME scorer, because the scorer reduces
// run dirs and never learns which producer wrote one. [LAW:decomposition]
//
// It is a SEPARATE SCRIPT from eval/run-case.js, not a `--producer` flag on it: the two differ in
// MECHANISM — one drives this repo's plan→workers engine in-process, the other spawns a CLI and reads its
// transcript — and nothing but the run-dir contract is shared. A mode flag would have made one file two
// programs wearing one name. [LAW:one-type-per-behavior] [LAW:no-mode-explosion]
//
//   node eval/run-case-cc.js <case-dir> --level <low|medium|high|xhigh|max> [-n N] [--model <id>]
//                            [--out <dir>] [--timeout <minutes>]
//
// The credential is read from CLAUDE_CODE_OAUTH_TOKEN, the same var the action uses.
//
// [LAW:effects-at-boundaries] Module load is PURE: stdlib and the pure readers in eval/cc-review.js.
// Every world-effect — spawning, temp dirs, git, fs — lives inside main() or a helper it calls.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { writeRunRecord } = require('./run-record');
const { parseFindings, parseResultEvent, usageFromResult, modelOf } = require('./cc-review');
const { CC_REVIEW_SCHEMA, CC_REVIEW_LEVELS } = require('./effort-record');

const CREDENTIAL_VAR = 'CLAUDE_CODE_OAUTH_TOKEN';

const DEFAULT_TIMEOUT_MINUTES = 30;
const KILL_GRACE_MS = 20_000;

const USAGE = `Replay a frozen eval case through Claude Code's built-in /code-review.

  node eval/run-case-cc.js <case-dir> --level <${CC_REVIEW_LEVELS.join('|')}> [options]

  -n <repeats>        Runs of this case (default 1). Each lands in its own run dir.
  --level <level>     The level an operator would type. Required — there is no default, because a
                      review's level is the arm and a defaulted arm is one nobody chose.
  --model <id>        Pin the model. Omitted, the CLI's default serves it and the run records which.
  --out <dir>         Output root (default eval/out).
  --timeout <min>     Per-run deadline in minutes (default ${DEFAULT_TIMEOUT_MINUTES}).
`;

// [LAW:parse-dont-validate] Arguments in, a complete and legal invocation out — every downstream reader
// takes a value that could not have been wrong. A level outside the skill's own set is refused HERE
// rather than running at the skill's fallback and being recorded as the level nobody ran.
function parseArgs(argv) {
  const opts = { caseDir: null, repeats: 1, level: null, model: null, out: 'eval/out', timeout: DEFAULT_TIMEOUT_MINUTES };
  const keyFor = { repeats: 'repeats', level: 'level', model: 'model', out: 'out', timeout: 'timeout' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    const key = arg === '-n' ? 'repeats' : (arg.startsWith('--') ? keyFor[arg.slice(2)] : undefined);
    if (key !== undefined) {
      i += 1;
      if (i >= argv.length) throw new Error(`${arg} needs a value.\n\n${USAGE}`);
      opts[key] = argv[i];
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option ${arg}.\n\n${USAGE}`);
    } else if (opts.caseDir === null) {
      opts.caseDir = arg;
    } else {
      throw new Error(`Unexpected argument ${JSON.stringify(arg)} — one case dir per invocation.\n\n${USAGE}`);
    }
  }
  if (opts.caseDir === null) throw new Error(`A case directory is required.\n\n${USAGE}`);
  if (!CC_REVIEW_LEVELS.includes(opts.level)) {
    throw new Error(`--level must be one of ${CC_REVIEW_LEVELS.join(', ')}, got ${JSON.stringify(opts.level)}.\n\n${USAGE}`);
  }
  opts.repeats = positiveInt(opts.repeats, '-n');
  opts.timeout = positiveInt(opts.timeout, '--timeout');
  if (opts.model !== null && (typeof opts.model !== 'string' || opts.model.trim() === '')) {
    throw new Error('--model needs a model id.');
  }
  return opts;
}

function positiveInt(value, flag) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be an integer ≥ 1, got ${JSON.stringify(value)}.`);
  return n;
}

// [LAW:effects-at-boundaries] Pure. The whole spawn spec, so a test can assert what would be run without
// running it.
//
// The env is an explicit ALLOWLIST, never a `process.env` spread — the same isolation posture
// src/engine/claude-code.js documents for the production adapter, and for the same reason: the reviewer
// is an agent that could surface an env var through a tool result, and the diff under review is
// untrusted input. Two facts the live probe made concrete:
//   - HOME is a THROWAWAY dir. Inheriting the operator's HOME pulls their global CLAUDE.md, their
//     settings and their SessionStart hooks into the arm — the first probe run fired three of them. That
//     is not the built-in reviewer any other user would get, and it would make this measurement a
//     measurement of one machine. [LAW:no-ambient-temporal-coupling]
//   - `--no-session-persistence` keeps a replay from leaving a session behind in that HOME.
function reviewSpawnSpec({ repoDir, home, level, model, range, token }) {
  const args = [
    '-p', `/code-review ${level} ${range}`,
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'dontAsk',
    '--no-session-persistence',
    ...(model === null ? [] : ['--model', model]),
  ];
  return {
    command: 'claude',
    args,
    cwd: repoDir,
    env: {
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      HOME: home,
      [CREDENTIAL_VAR]: token,
    },
  };
}

// [LAW:no-ambient-temporal-coupling] A deadline is owned state, not a hope: the child runs in its own
// process GROUP, and the timer that kills it is cleared by whichever handler ends the run — an
// uncancelled escalation would still fire SIGKILL after the OS had reissued that pid. The same shape
// freeze-suite.js's superviseSpawn uses, for the same reason.
function superviseReview({ command, args, cwd, env, transcriptPath, timeoutMinutes }) {
  return new Promise(resolve => {
    const startedAt = new Date().toISOString();
    const stream = fs.createWriteStream(transcriptPath);
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const stderr = [];
    child.stdout.pipe(stream, { end: false });
    child.stderr.on('data', chunk => stderr.push(chunk));
    stream.on('error', err => process.stderr.write(`run-case-cc: could not write ${transcriptPath}: ${err.message}\n`));

    let timedOut = false;
    let escalation = null;
    const signalGroup = sig => { try { process.kill(-child.pid, sig); } catch { /* already gone */ } };
    const finish = () => { clearTimeout(deadline); clearTimeout(escalation); };
    const deadline = setTimeout(() => {
      timedOut = true;
      signalGroup('SIGTERM');
      escalation = setTimeout(() => signalGroup('SIGKILL'), KILL_GRACE_MS);
      escalation.unref();
    }, timeoutMinutes * 60_000);

    // [LAW:no-ambient-temporal-coupling] The child exiting and the transcript being ON DISK are two
    // different completions, and the record is not whole until both have happened. `stream.end()` only
    // QUEUES the final flush, so resolving in the same tick lets main() read a truncated transcript —
    // and a truncated transcript does not crash, it REFUSES: `parseResultEvent` reports "no result
    // event", or `parseFindings` reports "no findings payload", for a review that succeeded and was
    // paid for. That launders a good run into the same signal as a walled credential, and since
    // transcript size grows with review depth it would drop the deepest runs preferentially — a bias
    // in exactly the arm a reader is comparing. So the settle waits for 'finish'. [LAW:no-silent-failure]
    const closed = new Promise(done => stream.on('finish', done));
    const settle = async outcome => {
      finish();
      stream.end();
      await closed;
      resolve(outcome);
    };
    child.on('error', err => {
      settle({ exitCode: -1, timedOut, startedAt, endedAt: new Date().toISOString(), stderr: err.message });
    });
    child.on('close', exitCode => {
      settle({ exitCode, timedOut, startedAt, endedAt: new Date().toISOString(), stderr: Buffer.concat(stderr).toString('utf8') });
    });
  });
}

// [LAW:parse-dont-validate] [LAW:no-silent-failure] The checkpoint between "a process exited" and "a
// review happened". Every arm here is a way a spawn fails to be a measurement, and each one would
// otherwise reach the scorer as a run that found nothing.
function assertReviewSucceeded({ exitCode, timedOut, stderr }, timeoutMinutes, label) {
  if (timedOut) {
    throw new Error(`${label}: the review exceeded its ${timeoutMinutes}m deadline and was killed — an unfinished review is not a review that found nothing.`);
  }
  if (exitCode !== 0) {
    throw new Error(`${label}: claude exited ${exitCode}.${stderr.trim() === '' ? '' : ` stderr: ${stderr.trim().slice(0, 500)}`}`);
  }
}

function readEvents(transcriptPath, label) {
  const text = fs.readFileSync(transcriptPath, 'utf8');
  return text.split('\n').filter(line => line.trim() !== '').map((line, i) => {
    try {
      return JSON.parse(line);
    } catch (e) {
      throw new Error(`${label}: transcript line ${i + 1} is not JSON (${e.message}) — the stream was truncated, so the review cannot be read.`);
    }
  });
}

// The run dir's name, matching run-case.js's so one output root holds both arms' runs interleaved and a
// reader sorts them by time. [LAW:one-source-of-truth]
function runDirName(now, index) {
  return `${now.toISOString().replace(/[:.]/g, '-')}-run${index}`;
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const token = process.env[CREDENTIAL_VAR];
  if (typeof token !== 'string' || token.trim() === '') {
    throw new Error(`${CREDENTIAL_VAR} is unset or empty — a review cannot be spawned without a credential.`);
  }
  const { materializeCase } = require('./materialize-case');
  const { parseCaseManifest, extractTree } = require('./run-case');
  const caseDir = path.resolve(opts.caseDir);
  const manifest = parseCaseManifest(fs.readFileSync(path.join(caseDir, 'case.json'), 'utf8'), caseDir);
  const caseOutRoot = path.join(path.resolve(opts.out), manifest.name);
  fs.mkdirSync(caseOutRoot, { recursive: true });

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-review-'));
  const runDirs = [];
  try {
    for (let i = 1; i <= opts.repeats; i += 1) {
      // A FRESH REPO PER REPEAT, and this is not caution — the reviewer WRITES. Across the 11 runs of the
      // first real arm, `copirate-93-dependency-diff` run 2 ran `npm run build` inside the materialized
      // tree and run 3 ran it twice, so run 3 reviewed a `dist/` that run 2 had rebuilt. Reusing one repo
      // makes repeat N's input depend on what repeat N-1 happened to do, which is the one assumption every
      // number in the table rests on: the repeats are replicates of ONE frozen change, and an interval
      // over runs that reviewed different trees describes nothing. [LAW:no-ambient-temporal-coupling]
      //
      // Re-materializing rather than cleaning between runs: a `git checkout -- . && git clean -fd` repairs
      // contamination instead of making it unrepresentable, and it only sees what git sees — a rebuilt
      // `dist/` that the tree gitignores survives it. Materialization is deterministic (fixed identity and
      // dates, asserted by a test that materializes twice and compares both shas), so a fresh repo is
      // byte-identical to the last one and costs a tar extract against a review that takes minutes.
      const repoDir = path.join(scratch, `repo-${i}`);
      const { range } = materializeCase({ caseDir, destDir: repoDir, extractTree });

      const label = `${manifest.name} run ${i}/${opts.repeats}`;
      const runDir = path.join(caseOutRoot, runDirName(new Date(), i));
      fs.mkdirSync(path.join(runDir, 'transcripts'), { recursive: true });
      const transcriptPath = path.join(runDir, 'transcripts', 'code-review.jsonl');
      // A THROWAWAY HOME per run, so no run can inherit state a previous one left.
      const home = fs.mkdtempSync(path.join(scratch, 'home-'));

      const spec = reviewSpawnSpec({ repoDir, home, level: opts.level, model: opts.model, range, token });
      process.stderr.write(`[${label}] /code-review ${opts.level} ${range} …\n`);
      const outcome = await superviseReview({ ...spec, transcriptPath, timeoutMinutes: opts.timeout });
      assertReviewSucceeded(outcome, opts.timeout, label);

      const events = readEvents(transcriptPath, label);
      const result = parseResultEvent(events, label);
      const findings = parseFindings(events, label);
      const model = modelOf(result);
      const span = { from: outcome.startedAt, to: outcome.endedAt };

      writeRunRecord(runDir, {
        meta: {
          case: manifest.name,
          timestamp: outcome.startedAt,
          run: i,
          repeats: opts.repeats,
          config: { name: 'claude-code-review', engine: 'claude-code-cli', model, reasoning: opts.level },
          // The arm, as a variant of the union eval/effort-record.js owns: what an operator TYPED and
          // what actually served it. [LAW:types-are-the-program]
          effort: { level: opts.level, model },
          effortSchema: CC_REVIEW_SCHEMA,
          // TRUTHFUL, and load-bearing: no tree of THIS repo produced this run, so there is no candidate
          // to name. It is also exactly what makes compare.js and measurement-index.js classify the run
          // as foreign rather than blend it into a gate for the engine. [LAW:no-silent-failure]
          candidate: null,
          findingCount: findings.length,
        },
        summary: result.result,
        usage: usageFromResult(result, span, label),
        findings,
        // The whole envelope, so every number in the report can be traced back to what the CLI said.
        artifacts: { 'code-review.json': result },
      });
      const usd = result.total_cost_usd;
      process.stderr.write(`[${label}] ${findings.length} finding(s), ${model}, $${typeof usd === 'number' ? usd.toFixed(4) : '?'} → ${runDir}\n`);
      runDirs.push(runDir);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  process.stdout.write(`${runDirs.join('\n')}\n`);
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(err => {
    process.stderr.write(`run-case-cc: ${err.message}\n`);
    process.exitCode = 2;
  });
}

module.exports = { parseArgs, reviewSpawnSpec, assertReviewSucceeded, runDirName, CREDENTIAL_VAR };
