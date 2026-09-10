'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { symbolsOf, changedSymbolsOf, seamsOf } = require('../src/seams');

// The seams of a change (zai-timing-8jk.5): where two changed files couple through the symbols the
// change touches, derived from text the engine already holds. [LAW:verifiable-goals] these state the
// declaration shapes recognised per language, what a changed line contributes, and the weight rule.

describe('symbolsOf — what a text defines and mentions', () => {
  test('Go: functions, methods, types, grouped consts and vars', () => {
    const go = [
      'package driver', '', 'type Conn struct {', '\tdb *sql.DB', '}', '',
      'func (c *Conn) Close() error { return nil }', 'func NewConnector(dsn string) *Connector { return nil }',
      'var (', '\tErrNoRows = errors.New("no rows")', ')', 'const timeout = 5',
    ].join('\n');
    assert.deepEqual(symbolsOf(go).defines, ['Close', 'Conn', 'ErrNoRows', 'NewConnector', 'timeout']);
    // uses: `*sql.DB` (type and member), `*Conn`/`*Connector` (type), `errors.New(` (member — the package qualifier is not a use)
    assert.deepEqual(symbolsOf(go).uses.filter(u => ['DB', 'New', 'sql', 'errors', 'Connector', 'Conn'].includes(u)), ['Conn', 'Connector', 'DB', 'New', 'sql']);
  });

  test('JavaScript/TypeScript: function, class, const, exports, methods, exported and async forms', () => {
    const js = [
      'function planRecord(fields) {}', 'export default class Ledger {', '  merge(findings) {', '  }',
      '  async flush(): Promise<void> {', '  }', '  count = 0;', '}', 'const SCHEMA = 1;', 'exports.parsePlan = () => 1;',
      'export async function fetchAll() {}', 'export interface Scope {}', 'export type Plan = {};',
      '  if (x) {', '  for (const y of z) {', '  } catch (e) {',
    ].join('\n');
    assert.deepEqual(symbolsOf(js).defines, ['Ledger', 'Plan', 'SCHEMA', 'Scope', 'count', 'fetchAll', 'flush', 'merge', 'parsePlan', 'planRecord']);
  });

  test('Python, Rust and shell declaration forms', () => {
    const text = ['def score(run):', 'class Judge:', '    threshold = 0.5', 'pub fn render(x: u8) {}', 'pub(crate) struct Case {}', 'freeze_case() {', '}', 'function verify_tasks {'].join('\n');
    assert.deepEqual(symbolsOf(text).defines, ['Case', 'Judge', 'freeze_case', 'render', 'score', 'threshold', 'verify_tasks']);
  });

  test('a use is call-shaped: a bare word in prose or a hash line is neither a definition nor a use', () => {
    const prose = 'Run the check step, then Close the connection and call Work as documented.';
    assert.deepEqual(symbolsOf(prose), { defines: [], uses: [] });
    const sum = 'github.com/dolthub/driver v1.2.3 h1:A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q7R8S9T0U1V2W3X4Y5Z6a7b8=';
    assert.deepEqual(symbolsOf(sum).defines, []);
    assert.deepEqual(symbolsOf(sum).uses, ['com']); // member-shaped, harmless: nothing defines it
    assert.deepEqual(symbolsOf('x := NewConnector(dsn)\nrows.Close()\nc := &Conn{}\nvar p *Rows\nList<Item>').uses, ['Close', 'Conn', 'NewConnector', 'Rows']);
    // An operand is not a use: a comparison is not a generic, and unspaced arithmetic is not a pointer.
    assert.deepEqual(symbolsOf('for (let i = 0; i < len; i++) { total += a*height; mask = flags&MASK; }').uses, []);
    assert.deepEqual(symbolsOf(''), { defines: [], uses: [] });
  });

  test('a comparison is not a definition, and a block keyword with parentheses is not a method', () => {
    assert.deepEqual(symbolsOf('  if (a == b) {\n  while (x) {\n  ok == 1').defines, []);
  });
});

describe('changedSymbolsOf — the symbols on the changed lines of a patch', () => {
  test('reads the + and − lines only, and a patchless file contributes nothing', () => {
    const patch = '@@ -1,3 +1,3 @@\n context();\n-function old() {}\n+function fresh() { return helper(); }\n';
    assert.deepEqual(changedSymbolsOf(patch), { defines: ['fresh', 'old'], uses: ['fresh', 'helper', 'old'] });
    assert.deepEqual(changedSymbolsOf(undefined), { defines: [], uses: [] });
  });
});

describe('seamsOf — the weighted seams among a changed set', () => {
  const file = (filename, text, patch) => ({ filename, patch, content: { symbols: symbolsOf(text) } });

  test("a change in A that calls what B defines is a seam; so is a change in B's definition of what A calls", () => {
    const a = file('src/a.js', 'function alpha() { return beta(); }', '@@ -1 +1 @@\n+function alpha() { return beta(); }');
    const b = file('src/b.js', 'function beta() {}', '@@ -1 +1 @@\n context');
    assert.deepEqual(seamsOf([a, b]), [{ a: 'src/a.js', b: 'src/b.js', weight: 1 }]);
    // Now the change is on B's side: A mentions beta anywhere, and B's changed lines define it.
    const a2 = file('src/a.js', 'function alpha() { return beta(); }', '@@ -1 +1 @@\n context');
    const b2 = file('src/b.js', 'function beta() {}', '@@ -1 +1 @@\n+function beta() {}');
    assert.deepEqual(seamsOf([a2, b2]), [{ a: 'src/a.js', b: 'src/b.js', weight: 1 }]);
  });

  test('a definition the change DELETED is still its file\'s: a caller that still uses it is a seam of weight 1, never a division by no definer', () => {
    const b = file('src/b.js', '// helper is gone', '@@ -1 +1 @@\n-function helper() {}\n+// helper is gone');
    const a = file('src/a.js', 'const x = helper();', '@@ -1 +1 @@\n context');
    assert.deepEqual(seamsOf([a, b]), [{ a: 'src/a.js', b: 'src/b.js', weight: 1 }]);
    // ...and a live symbol beside it is not poisoned: the seam carries both.
    const b2 = file('src/b.js', 'function other() {}', '@@ -1,2 +1,2 @@\n-function helper() {}\n+function other() {}');
    const a2 = file('src/a.js', 'helper(); other();', '@@ -1 +1 @@\n+other();');
    assert.deepEqual(seamsOf([a2, b2]), [{ a: 'src/a.js', b: 'src/b.js', weight: 2 }]);
  });

  test('two files that share no touched symbol have no seam, and unchanged uses of unchanged definitions are none either', () => {
    const a = file('src/a.js', 'function alpha() { return beta(); }', '@@ -1 +1 @@\n+// comment');
    const b = file('src/b.js', 'function beta() {}', '@@ -1 +1 @@\n+// comment');
    assert.deepEqual(seamsOf([a, b]), []);
  });

  test('a symbol defined in several changed files weighs 1/definers per pair, and one both files define is neither\'s seam', () => {
    const rows = file('rows.go', 'func (r *Rows) Close() error {}', '@@ -1 +1 @@\n+func (r *Rows) Close() error {}');
    const conn = file('conn.go', 'func (c *Conn) Close() error {}', '@@ -1 +1 @@\n+func (c *Conn) Close() error {}');
    const stmt = file('stmt.go', 'func (s *Stmt) Exec() { s.rows.Close() }', '@@ -1 +1 @@\n+func (s *Stmt) Exec() { s.rows.Close() }');
    const seams = seamsOf([rows, conn, stmt]);
    assert.deepEqual(seams, [{ a: 'conn.go', b: 'stmt.go', weight: 0.5 }, { a: 'rows.go', b: 'stmt.go', weight: 0.5 }]);
  });

  test('seams are ordered heaviest first, then by name', () => {
    const a = file('a.js', 'function one() {}\nfunction two() {}', '@@ -1 +1 @@\n+function one() {}\n+function two() {}');
    const b = file('b.js', 'one(); two();', '@@ -1 +1 @@\n+one(); two();');
    const c = file('c.js', 'one();', '@@ -1 +1 @@\n+one();');
    assert.deepEqual(seamsOf([c, b, a]).map(s => [s.a, s.b, s.weight]), [['a.js', 'b.js', 2], ['a.js', 'c.js', 1]]);
  });

  test("this repository's own plan and multiscope modules have a seam on the plan record: a real JavaScript pair, no fixture", () => {
    const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
    const plan = file('src/plan.js', read('plan.js'), '@@ -1 +1 @@\n+function planRecord(fields) {');
    const multi = file('src/multiscope.js', read('multiscope.js'), '@@ -1 +1 @@\n context');
    const [seam] = seamsOf([plan, multi]);
    assert.equal(seam.a, 'src/multiscope.js');
    assert.equal(seam.b, 'src/plan.js');
    assert.ok(seam.weight >= 1, `weight ${seam.weight}`);
  });
});
