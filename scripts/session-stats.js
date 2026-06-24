'use strict';
// [LAW:effects-at-boundaries] Pure: given a captured session transcript (or any raw engine stream),
// report what tools the engine actually invoked. This is the analytical counterpart to buildTranscript
// (src/debug.js): that one FRAMES the engine's raw streams; this one READS them back to answer the one
// question the transcript exists to answer — did the engine explore the repo (Read/Grep/Glob), or only
// consume the inline diff? No IO, no parsing of a specific framing: it scans for tool-invocation events
// in whatever JSONL the engine emitted, so it works on a framed transcript and on raw stdout alike.

const EXPLORE_TOOLS = ['Read', 'Grep', 'Glob'];

// [LAW:dataflow-not-control-flow] One recursive walk over the parsed value yields every tool invocation
// as a value, regardless of where the engine nests it. claude-code emits {type:'tool_use', name, input};
// codex emits {type:'function_call', name, arguments} / {type:'local_shell_call', ...}. Both are captured
// here so the summary is engine-agnostic; the caller decides what to highlight.
function collectToolUses(node, out) {
  if (Array.isArray(node)) {
    for (const item of node) collectToolUses(item, out);
    return;
  }
  if (!node || typeof node !== 'object') return;

  if (node.type === 'tool_use' && typeof node.name === 'string') {
    out.push({ name: node.name, input: node.input || {} });
  } else if (node.type === 'function_call' && typeof node.name === 'string') {
    out.push({ name: node.name, input: node.arguments || {} });
  } else if (node.type === 'local_shell_call') {
    out.push({ name: 'shell', input: node.action || node });
  }

  for (const key of Object.keys(node)) collectToolUses(node[key], out);
}

// Scan a transcript/stream for tool invocations. A line that does not parse as JSON (the transcript's
// header and section rules, or a partial stream chunk) is skipped — it carries no tool event.
// [LAW:no-silent-failure] parse failures are skipped deliberately, not swallowing a real signal: tool
// events are always emitted as complete JSON objects on their own line by every supported engine.
function extractToolUses(text) {
  const uses = [];
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    collectToolUses(parsed, uses);
  }
  return uses;
}

function summarizeSession(text) {
  const uses = extractToolUses(text);

  const toolCounts = {};
  for (const u of uses) toolCounts[u.name] = (toolCounts[u.name] || 0) + 1;

  const valuesFor = (name, field) =>
    uses.filter(u => u.name === name).map(u => u.input && u.input[field]).filter(Boolean);

  const reads = valuesFor('Read', 'file_path');
  const greps = valuesFor('Grep', 'pattern');
  const globs = valuesFor('Glob', 'pattern');

  const exploreCalls = EXPLORE_TOOLS.reduce((n, t) => n + (toolCounts[t] || 0), 0);

  return {
    toolCounts,
    totalToolCalls: uses.length,
    reads,
    greps,
    globs,
    exploreCalls,
    explored: exploreCalls > 0,
  };
}

module.exports = { summarizeSession, extractToolUses, collectToolUses, EXPLORE_TOOLS };
