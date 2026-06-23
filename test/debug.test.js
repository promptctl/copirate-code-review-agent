'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildTranscript } = require('../src/debug');

// buildTranscript is pure: it frames the engine's own raw streams verbatim. These assert the
// contract — the verbatim content survives, the sections are present, and no secret can leak
// because env is not even an input.
describe('buildTranscript', () => {
  test('includes the prompt, raw stdout, and stderr verbatim under labelled sections', () => {
    const t = buildTranscript({
      engine: 'claude-code',
      model: 'deepseek-v4-pro',
      prompt: 'REVIEW THIS DIFF\n+ added line',
      stdout: '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"hmm"}]}}',
      stderr: 'a warning on stderr',
    });
    assert.match(t, /engine: claude-code/);
    assert.match(t, /model: deepseek-v4-pro/);
    assert.match(t, /PROMPT \(delivered to the engine on stdin\)/);
    assert.match(t, /REVIEW THIS DIFF\n\+ added line/);
    assert.match(t, /RAW STDOUT/);
    assert.match(t, /"type":"thinking","thinking":"hmm"/);
    assert.match(t, /RAW STDERR/);
    assert.match(t, /a warning on stderr/);
  });

  test('renders <empty> for absent stdout/stderr and (default) for an absent model', () => {
    const t = buildTranscript({ engine: 'codex', model: '', prompt: 'p', stdout: '', stderr: '' });
    assert.match(t, /model: \(default\)/);
    // both the stdout and stderr sections fall back to the empty marker
    assert.equal((t.match(/<empty>/g) || []).length, 2);
  });

  test('never receives or emits a credential — env is not an input to the transcript', () => {
    // The shape only accepts engine/model/prompt/stdout/stderr; there is no channel for the API key.
    const t = buildTranscript({
      engine: 'claude-code',
      model: 'm',
      prompt: 'no secrets here',
      stdout: 'no secrets here either',
      stderr: '',
      apiKey: 'sk-SHOULD-NOT-APPEAR', // extraneous field must be ignored
    });
    assert.doesNotMatch(t, /sk-SHOULD-NOT-APPEAR/);
  });
});

// emitTranscript is an effect; this confirms the file-write half lands a real transcript file in a
// directory we control, without coupling to the Actions log. RUNNER_TEMP is redirected to a temp dir.
describe('emitTranscript file output', () => {
  test('writes a transcript file under RUNNER_TEMP/agent-review-transcripts', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'debug-test-runner-temp-'));
    const prevRunnerTemp = process.env.RUNNER_TEMP;
    process.env.RUNNER_TEMP = tmp;
    // Require fresh so TRANSCRIPT_DIR is computed against the redirected RUNNER_TEMP.
    const modPath = require.resolve('../src/debug');
    delete require.cache[modPath];
    try {
      const { emitTranscript, TRANSCRIPT_DIR } = require('../src/debug');
      assert.equal(TRANSCRIPT_DIR, path.join(tmp, 'agent-review-transcripts'));
      emitTranscript({
        engine: 'claude-code', model: 'm', prompt: 'P', stdout: 'OUT', stderr: '', label: 'transcript-x',
      });
      const file = path.join(TRANSCRIPT_DIR, 'transcript-x.txt');
      assert.ok(fs.existsSync(file), 'transcript file should exist');
      const content = fs.readFileSync(file, 'utf8');
      assert.match(content, /RAW STDOUT/);
      assert.match(content, /OUT/);
    } finally {
      if (prevRunnerTemp === undefined) delete process.env.RUNNER_TEMP;
      else process.env.RUNNER_TEMP = prevRunnerTemp;
      delete require.cache[modPath];
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
