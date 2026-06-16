'use strict';
const { spawn } = require('child_process');
const core = require('@actions/core');

// [LAW:no-ambient-temporal-coupling] An engine may legitimately emit an arbitrarily large
// stream — codex `exec --json` streams every reasoning delta and tool call as a JSONL line,
// so a dense, law-comment-heavy diff easily produces many megabytes. What we RETAIN is bounded
// to a trailing window so memory stays flat on a big review; the engine is NOT killed for being
// verbose. "The process never terminates" is owned by the per-invocation timeout below — never
// by output volume. The events the caller needs (turn.completed / turn.failed and the cumulative
// usage that rides the terminal event) are the LAST emitted, so a tail preserves exactly them.
const MAX_RETAINED_OUTPUT = 8 * 1024 * 1024;

// [LAW:one-type-per-behavior] stdout and stderr are the same behavior — captured child output
// bounded to a trailing window. Append, then clip to the last MAX_RETAINED_OUTPUT bytes. A clip
// can sever the first retained line mid-JSON; every consumer parses line-by-line and skips
// unparseable lines, so a severed leading fragment is harmlessly dropped. `clipped` reports
// whether bytes were dropped, so the caller can announce the information loss rather than let a
// stream-summed usage silently undercount. [LAW:no-silent-failure]
function appendBounded(buffer, chunk) {
  const next = buffer + chunk;
  if (next.length > MAX_RETAINED_OUTPUT) return { text: next.slice(-MAX_RETAINED_OUTPUT), clipped: true };
  return { text: next, clipped: false };
}

function parseJsonEnvelope(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    const trimmed = stdout.trim();
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      return undefined;
    }
    try {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    } catch {
      return undefined;
    }
  }
}

function formatOutputTail(label, value) {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return `${label}: <empty>`;
  }
  return `${label}:\n${trimmed.slice(-4000)}`;
}

// [LAW:decomposition] Generic spawn runner: owns timeout, size-cap, and process lifecycle.
// All engine-specific logic (args, env, success check, error classification) lives in the adapter.
// Resolves with the child's captured stdout so the caller can extract usage/cost from it.
// [LAW:no-ambient-temporal-coupling] The per-invocation timeout is owned here, not in callers.
// [LAW:effects-at-boundaries] This is the only place that spawns a child process.
// cwd is the engine's working directory — an isolated scratch dir outside the reviewed repo tree
// (see cli.js) so no repo-committed project-instruction file is auto-loaded as reviewer directives.
function runEngine(adapter, config, prompt, home, collector, cwd) {
  return new Promise((resolve, reject) => {
    const { command, args, env } = adapter.buildCommand({ config, collector, home });
    const timeoutMs = adapter.timeoutMs ?? 3_000_000;
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'], cwd });
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let settled = false;

    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      result();
    };

    const timeout = setTimeout(() => {
      finish(() => {
        child.kill('SIGTERM');
        reject(new Error(`${adapter.name} review timed out.`));
      });
    }, timeoutMs);

    // [LAW:no-silent-failure] A verbose-but-complete review must finish and be parsed, not be
    // aborted for tripping a byte ceiling — that turned every substantial review into a crash.
    // Retention is bounded (appendBounded); completion is judged by adapter.assertSucceeded on
    // close, which throws loud when the terminal event is absent. An oversized stream is never
    // laundered into a clean pass. When stdout is clipped, `truncated` records it so close can
    // announce that a stream-summed usage (e.g. OpenCode) may undercount — never a silent drop.
    child.stdout.on('data', chunk => {
      const { text, clipped } = appendBounded(stdout, chunk);
      stdout = text;
      truncated = truncated || clipped;
    });
    child.stderr.on('data', chunk => { stderr = appendBounded(stderr, chunk).text; });

    child.on('error', err => {
      finish(() => reject(adapter.classifyError(err, '')));
    });

    child.on('close', code => {
      finish(() => {
        if (code !== 0) {
          const msg = [
            `${adapter.name} exited with status ${code}.`,
            `Command: ${command} ${args.map(a => JSON.stringify(a)).join(' ')}`,
            formatOutputTail('stderr tail', stderr),
            formatOutputTail('stdout tail', stdout),
          ].join('\n\n');
          reject(adapter.classifyError(new Error(msg), `${stdout}\n${stderr}`));
          return;
        }
        try {
          adapter.assertSucceeded(stdout);
          // [LAW:no-silent-failure] The trailing window holds the terminal completion event and
          // last-event usage (codex/claude), so completion and their usage are exact. A stream-
          // summed usage (OpenCode adds per-event tokens/cost) loses the dropped prefix, so the
          // loss is announced here rather than reported as an exact figure.
          if (truncated) {
            core.warning(
              `${adapter.name} output exceeded the ${MAX_RETAINED_OUTPUT} byte retention window; ` +
              'kept the trailing window. Completion and last-event usage are intact; a stream-summed ' +
              'usage/cost for this run may be a lower bound.',
            );
          }
          // [LAW:dataflow-not-control-flow] The captured stdout is the engine's output value;
          // the caller derives usage/cost from it via the adapter's extractUsage. Findings
          // still flow out-of-band through the MCP collector — stdout carries only usage.
          resolve(stdout);
        } catch (err) {
          reject(adapter.classifyError(err, stdout));
        }
      });
    });

    child.stdin.end(prompt);
  });
}

module.exports = { parseJsonEnvelope, formatOutputTail, runEngine, appendBounded, MAX_RETAINED_OUTPUT };
