'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const core = require('@actions/core');

// [LAW:one-source-of-truth] One well-known location for session transcripts, defined once. RUNNER_TEMP
// is set by GitHub Actions and Gitea's act_runner alike; os.tmpdir() is the local-dev fallback. A
// workflow points actions/upload-artifact at this directory to download the full session — the
// action also sets it as the `transcript-dir` output so no path is hardcoded in the workflow.
const TRANSCRIPT_DIR = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'agent-review-transcripts');

const RULE = '='.repeat(72);
const section = label => `\n${RULE}\n== ${label}\n${RULE}\n`;

// [LAW:effects-at-boundaries] Pure: assembles the verbatim session transcript from the values it is
// given. It does NOT reconstruct a narrative — the engine's own raw streams ARE the source of truth;
// this only frames them with section headers. [LAW:one-source-of-truth] Secrets are never an input
// here (the engine's env, which holds the API key, is deliberately not passed), so none can leak into
// a transcript that is echoed to the log and uploaded as an artifact.
function buildTranscript({ engine, model, prompt, stdout, stderr }) {
  return [
    'Agent review — debug transcript',
    `engine: ${engine}`,
    `model: ${model || '(default)'}`,
    section('PROMPT (delivered to the engine on stdin)'),
    prompt || '<empty>',
    section('RAW STDOUT (engine output stream — includes thinking and tool calls in debug mode)'),
    (stdout && stdout.length) ? stdout : '<empty>',
    section('RAW STDERR'),
    (stderr && stderr.trim()) ? stderr : '<empty>',
    '',
  ].join('\n');
}

// [LAW:effects-at-boundaries] The surfacing effect, kept entirely out of the engine's judgment path:
// write the transcript to a file under TRANSCRIPT_DIR AND echo it to the Actions log inside a collapsible
// group, so the full prompt/response/thinking flow is both clickable in the run and downloadable as an
// artifact. [LAW:no-silent-failure] a log or write failure is announced as a warning and never aborts
// the review — debug plumbing must not break the actual review. The file write and the log echo are
// independent so a failure of one still yields the other.
function emitTranscript({ engine, model, prompt, stdout, stderr, label }) {
  const transcript = buildTranscript({ engine, model, prompt, stdout, stderr });
  try {
    core.startGroup(`🛠️  Session transcript — ${label}`);
    core.info(transcript);
    core.endGroup();
  } catch (e) {
    core.warning(`Session transcript could not be echoed to the log: ${e.message}`);
  }
  try {
    fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
    const file = path.join(TRANSCRIPT_DIR, `${label}.txt`);
    fs.writeFileSync(file, transcript);
    core.info(`Session transcript written to ${file}`);
  } catch (e) {
    core.warning(`Session transcript could not be written to a file: ${e.message}`);
  }
}

module.exports = { TRANSCRIPT_DIR, buildTranscript, emitTranscript };
