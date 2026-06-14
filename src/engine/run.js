'use strict';
const { spawn } = require('child_process');

const MAX_RESPONSE_SIZE = 1024 * 1024;

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
function runEngine(adapter, config, prompt, home, collector) {
  return new Promise((resolve, reject) => {
    const { command, args, env } = adapter.buildCommand({ config, collector, home });
    const timeoutMs = adapter.timeoutMs ?? 3_000_000;
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
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

    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.length > MAX_RESPONSE_SIZE) {
        finish(() => {
          child.kill('SIGTERM');
          reject(new Error(`${adapter.name} response exceeded size limit.`));
        });
      }
    });

    child.stderr.on('data', chunk => {
      stderr += chunk;
      if (stderr.length > MAX_RESPONSE_SIZE) {
        stderr = stderr.slice(-MAX_RESPONSE_SIZE);
      }
    });

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

module.exports = { parseJsonEnvelope, formatOutputTail, runEngine };
