'use strict';

// THE SEAMS OF A CHANGE — where two changed files couple through the symbols the change touches — as a
// pure function of each file's text and its patch. Same change, same seams, every run.
//
// [FRAMING:parts-and-seams] A scope says what a worker JUDGES; what it may LOOK AT beyond that is set
// by the seams the change actually has (zai-timing-8jk.5). Until this module the only second read the
// partition could hand out was "every sibling part of a cut concern, in full" — a flat rate that read
// the whole concern k times and, measured on links-317 (8jk.4), bought no wall clock: each half's
// eyesight was still the whole. A seam is narrower than a sibling: file A has a seam with file B when
// the change's own lines in A use a symbol B defines (A calls into what B owns), or the change's own
// lines in B define a symbol A uses anywhere (B alters what A relies on). That is the coupling a
// cross-file defect lives on, and it is discoverable from material the engine already holds — the
// patch and the checkout — with no spawn and no model.
//
// [LAW:effects-at-boundaries] Nothing here reads a file or a clock. symbolsOf takes text; changedSymbolsOf
// takes a patch; seamsOf takes the stamped records and returns weights. measureChangedFiles (src/window.js)
// is the one reader, and it stamps symbolsOf's result beside the token and line measurement so the
// partition never sees text.

// [LAW:one-source-of-truth] The one reading of "a use": an identifier in the position a call, a member
// access, a type or a constructor puts it — `Name(`, `.Name`, `Name{`, `&Name`, `*Name` — a word the
// languages under review agree on (letter or underscore, then word characters) in a shape only code
// produces. A bare word is NOT a use: prose in a README, a LICENSE, a comment, or a go.sum line mentions
// `check` and `run` and `Work` freely, and counting those made every changed file couple to every other
// (the first cut of this module spent the whole read budget on all four frozen cases, docs included).
// Nor is an operand: `i < len` is a comparison, not a generic, so `<` is not a use shape (a generic's
// type is used elsewhere in a shape that is), and `&`/`*` count only at a token's start — `&Conn{` and
// `*sql.DB`, never `flags&MASK` or `a*height`. A use matters only when some changed file defines the
// same name.
const USE_MEMBER = /\.([A-Za-z_][A-Za-z0-9_]*)\b/g;
const USE_CALL = /(?:^|[^A-Za-z0-9_.])([A-Za-z_][A-Za-z0-9_]*)\s*[({]/g;
const USE_TYPE = /(?:^|[\s(,=:[])[&*]([A-Za-z_][A-Za-z0-9_]*)\b/g;

// [LAW:one-type-per-behavior] What DEFINES a symbol, as one table of line shapes with one capture each —
// the declaration forms of the languages this reviewer meets (Go, JavaScript/TypeScript, Python, Rust,
// Kotlin/Scala, shell), not one parser per language. A shape is here because a real changed set carried
// it; a language whose declarations take none of these shapes contributes no seams and its files are
// read by their owner alone, which is the pre-seam behavior, never an error.
const DEFINITION_SHAPES = [
  // Go: `func Name(` and `func (r *T) Name(`.
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/,
  // Keyworded declarations, optionally exported/public/async: JS/TS, Python, Rust, Kotlin, Go's type/const/var.
  /^\s*(?:export\s+(?:default\s+)?|pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|struct|trait|def|fn|const|let|var|val|namespace|module)\s+([A-Za-z_]\w*)/,
  // CommonJS: `exports.name =` and `module.exports.name =`.
  /^\s*(?:module\.)?exports\.([A-Za-z_]\w*)\s*=/,
  // Shell: `name() {`.
  /^\s*([A-Za-z_]\w*)\s*\(\)\s*\{/,
  // A method: `  name(args) {` and TypeScript's `  async name(args): T {`. Keywords that open a block
  // with parentheses (if, for, while, switch, catch) are the shapes this rule must NOT read as methods.
  /^\s+(?:(?:static|async|public|private|protected|readonly|override)\s+)*([A-Za-z_]\w*)\s*\([^()]*\)\s*(?::[^{;]*)?\{\s*$/,
];
const BLOCK_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'match', 'select', 'elif', 'except', 'until', 'unless', 'when', 'case']);
// [LAW:one-type-per-behavior] A declaration BLOCK: a line that opens a body whose members, at exactly one
// indent, are definitions — and only there. An indented `name = value` elsewhere is a reassigned local
// (`err = f()`, `    result = g()`), and reading it as a definition made every file that reassigns
// `err`, `count` or `result` a definer of that name. Two blocks, one table:
//   - Go's grouped declaration, `var (` / `const (` / `type (` at column 0 (a trailing comment allowed).
//     gofmt indents a group inside a function body, whose members are locals, so the column-0 anchor is
//     what excludes it; and gofmt puts every member at one tab, so a wrapped value (`\t\tTimeout: 30,`
//     inside `\tdefaults = Config{`) is a continuation, never a member.
//   - A class body: JavaScript/TypeScript `class X … {`, Python `class X…:`, Kotlin. Its member indent is
//     whatever the first line after the opener uses, so a method body, one indent deeper, is not a member.
// A block closes at the first non-blank line indented no deeper than its opener: Go's `)`, a JavaScript
// class's `}`, a Python dedent.
const BLOCKS = [
  { opener: /^(?:var|const|type)\s*\(\s*(?:\/\/.*)?$/, member: /^([A-Za-z_]\w*)\b/, indent: '\t' },
  {
    opener: /^\s*(?:export\s+(?:default\s+)?)?(?:(?:abstract|data|sealed|open)\s+)*class\s+[A-Za-z_]\w*[^;{}]*[{:]\s*$/,
    member: /^(?:(?:static|public|private|protected|readonly|declare|override)\s+)*([A-Za-z_]\w*)\s*[?!]?\s*(?::|=(?!=))/,
    indent: null,
  },
];
// The value a scan reads between a hunk's section heading and the hunk itself: the two are not adjacent,
// so a block the heading opens cannot learn its member indent from what follows. [LAW:dataflow-not-control-flow]
const GAP = null;

// [LAW:effects-at-boundaries] Pure: the symbols each line defines and uses, in order, as one pass that
// carries the open blocks from line to line. An entry is a line of text, or GAP. A block's memberIndent is
// the indent its members use — null until the first line after its opener sets it, false once a GAP has
// made it unknowable (no line is a member of such a block).
function scanLines(lines) {
  const open = [];
  return lines.map((line) => {
    const symbols = { defines: [], uses: [] };
    if (line === GAP) {
      for (const block of open) block.memberIndent ??= false;
      return symbols;
    }
    if (line.trim() === '') return symbols;
    const indent = /^\s*/.exec(line)[0];
    while (open.length > 0 && indent.length <= open[open.length - 1].openerIndent) open.pop();
    for (const shape of DEFINITION_SHAPES) {
      const m = shape.exec(line);
      if (m && !BLOCK_KEYWORDS.has(m[1])) symbols.defines.push(m[1]);
    }
    const inside = open[open.length - 1];
    if (inside) {
      inside.memberIndent ??= indent;
      const m = indent === inside.memberIndent && inside.kind.member.exec(line.slice(indent.length));
      if (m) symbols.defines.push(m[1]);
    }
    const kind = BLOCKS.find(b => b.opener.test(line));
    if (kind) open.push({ kind, openerIndent: indent.length, memberIndent: kind.indent });
    for (const shape of [USE_CALL, USE_MEMBER, USE_TYPE]) {
      for (const m of line.matchAll(shape)) if (!BLOCK_KEYWORDS.has(m[1])) symbols.uses.push(m[1]);
    }
    return symbols;
  });
}

// The symbols a set of scanned lines carries, each once, as sorted arrays so the stamp is a plain,
// comparable, serialisable value.
function foldSymbols(scanned) {
  const defines = new Set(scanned.flatMap(s => s.defines));
  const uses = new Set(scanned.flatMap(s => s.uses));
  return { defines: [...defines].sort(), uses: [...uses].sort() };
}

// [LAW:effects-at-boundaries] Pure: the symbols a text defines and the symbols it uses, each once.
function symbolsOf(text) {
  return foldSymbols(scanLines(text.split('\n')));
}

// [LAW:one-source-of-truth] The changed lines of a patch are the lines fileChurn (src/diff.js) counts —
// a `+` or `-` at column 0. A changed line's meaning depends on the block around it, which a spliced list
// of changed lines no longer has (a member added to an unchanged `var (` group loses its opener; a
// replaced opener whose `)` is context leaks its group over every later hunk). So each hunk is scanned
// on its own, one side at a time — the old side (context and `-` lines) and the new side (context and
// `+` lines) — with the block its section heading names (git writes the nearest preceding unindented
// line after the `@@ … @@`, which for a line deep in a Go group is the `var (` itself) standing before a
// GAP; and only the changed lines' symbols are kept. A file with no patch (binary, or too large for the
// host to render) changed nothing this module can see.
function changedSymbolsOf(patch) {
  const hunks = [{ heading: GAP, old: [], new: [] }];
  for (const line of (patch ?? '').split('\n')) {
    const header = /^@@[^@]*@@ ?(.*)$/.exec(line);
    if (header) {
      hunks.push({ heading: header[1], old: [], new: [] });
      continue;
    }
    const hunk = hunks[hunks.length - 1];
    const entry = { text: line.slice(1), changed: line[0] !== ' ' };
    if (line[0] === ' ' || line[0] === '-') hunk.old.push(entry);
    if (line[0] === ' ' || line[0] === '+') hunk.new.push(entry);
  }
  return foldSymbols(hunks.flatMap(({ heading, old, new: added }) => [old, added].flatMap((side) => {
    const scanned = scanLines([heading, GAP, ...side.map(e => e.text)]).slice(2);
    return scanned.filter((_, i) => side[i].changed);
  })));
}

// [LAW:effects-at-boundaries] Pure: the seams among a changed set, as weighted unordered pairs.
//   files — [{ filename, patch, content: { symbols: { defines, uses } } }], the measured changed set.
// Returns [{ a, b, weight }] with a < b and weight > 0, heaviest first (ties by name), where weight is
// the number of symbols the seam carries, each discounted by how many changed files define it: a name
// one file owns is a seam of weight 1; a name five files define (`Close` on five types, `err` assigned
// in every function) is ambiguous and weighs a fifth per pair. No threshold decides what counts —
// every live symbol counts, and the read budget (src/partition.js) decides how far down the ranking a
// review can afford to look. [LAW:dataflow-not-control-flow]
// A file DEFINES a symbol if its current text does, or its changed lines did: a definition the change
// DELETED is still that file's, and a caller elsewhere that still uses it is the seam this module most
// exists to find (a removed or renamed export still used elsewhere) — it weighs 1, never a division
// by no definer. A symbol both files define is neither's seam: A's use of it is A's own.
function seamsOf(files) {
  const used = new Map(files.map(f => [f.filename, new Set(f.content.symbols.uses)]));
  const changed = new Map(files.map(f => [f.filename, changedSymbolsOf(f.patch)]));
  const defined = new Map(files.map(f => [f.filename, new Set([...f.content.symbols.defines, ...changed.get(f.filename).defines])]));
  const definers = new Map();
  for (const [name, symbols] of defined) {
    for (const s of symbols) definers.set(s, (definers.get(s) ?? 0) + 1);
  }
  const live = (a, b) => {
    // The change's lines in `a` use what `b` defines, or the change's lines in `b` define what `a` uses.
    const symbols = new Set();
    for (const s of changed.get(a).uses) if (defined.get(b).has(s)) symbols.add(s);
    for (const s of changed.get(b).defines) if (used.get(a).has(s)) symbols.add(s);
    return [...symbols].filter(s => !defined.get(a).has(s));
  };
  const names = [...defined.keys()].sort();
  const seams = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const symbols = new Set([...live(names[i], names[j]), ...live(names[j], names[i])]);
      const weight = [...symbols].reduce((sum, s) => sum + 1 / definers.get(s), 0);
      if (weight > 0) seams.push({ a: names[i], b: names[j], weight });
    }
  }
  return seams.sort((x, y) => y.weight - x.weight || (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : 1));
}

module.exports = { symbolsOf, changedSymbolsOf, seamsOf };
