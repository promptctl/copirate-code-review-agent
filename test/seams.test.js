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

  test('an indented assignment defines a name only as a member of a declaration block: a reassigned local is not a definition', () => {
    const go = ['func f() error {', '\terr = g()', '\tcount = 0', '\treturn err', '}', 'var (', '\tErrNoRows = errors.New("x")', '\ttimeout time.Duration', ')', 'const ( // modes', '\tA = iota', '\tB', ')'].join('\n');
    assert.deepEqual(symbolsOf(go).defines, ['A', 'B', 'ErrNoRows', 'f', 'timeout']);
    // A class body's members are definitions; its methods' locals, one indent deeper, are not.
    const py = ['class Judge:', '    threshold: float = 0.5', '    def score(self, run):', '        result = run.total', '        return result'].join('\n');
    assert.deepEqual(symbolsOf(py).defines, ['Judge', 'score', 'threshold']);
    const ts = ['export class Ledger {', '  private count: number;', '  limit = 10;', '  merge(findings) {', '    total = findings.length;', '  }', '}', 'total = 0;'].join('\n');
    assert.deepEqual(symbolsOf(ts).defines, ['Ledger', 'count', 'limit', 'merge']);
  });

  test('a Go group member sits at one tab: a wrapped value is not a member, and a group inside a function holds locals', () => {
    const go = [
      'var (', '\tdefaults = Config{', '\t\tTimeout: 30 * time.Second,', '\t\tretry(3),', '\t}', ')',
      'func run() {', '\tvar (', '\t\tresult = 1', '\t\terr error', '\t)', '}',
    ].join('\n');
    assert.deepEqual(symbolsOf(go).defines, ['defaults', 'run']);
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

  test('a control keyword is never a symbol: a class body\'s else: is not a member, and } else { is not a use', () => {
    const py = ['class Loader:', '    try:', '        import fast', '    except ImportError:', '        fast = None', '    else:', '        ready = True', '    finally:', '        done = 1'].join('\n');
    assert.deepEqual(symbolsOf(py).defines, ['Loader']);
    assert.deepEqual(symbolsOf('if (a) { x(); } else { y(); }\ntry { z(); } finally { w(); }\ndo { v(); } while (u);').uses, ['v', 'w', 'x', 'y', 'z']);
  });
});

describe('changedSymbolsOf — the symbols on the changed lines of a patch', () => {
  test('reads the + and − lines only, and a patchless file contributes nothing', () => {
    const patch = '@@ -1,3 +1,3 @@\n context();\n-function old() {}\n+function fresh() { return helper(); }\n';
    assert.deepEqual(changedSymbolsOf(patch), { defines: ['fresh', 'old'], uses: ['fresh', 'helper', 'old'] });
    assert.deepEqual(changedSymbolsOf(undefined), { defines: [], uses: [] });
  });

  test('a changed member of a Go group is a definition when the hunk holds the opener, or its section heading names it', () => {
    const inHunk = '@@ -1,4 +1,5 @@\n var (\n \tErrA = errors.New("a")\n+\tErrB = errors.New("b")\n )';
    assert.deepEqual(changedSymbolsOf(inHunk), { defines: ['ErrB'], uses: ['New'] });
    const deep = '@@ -40,6 +40,6 @@ var (\n \tErrY = errors.New("y")\n-\tErrZ = errors.New("z")\n+\tErrZ = errors.New("zz")\n \tErrW = errors.New("w")';
    assert.deepEqual(changedSymbolsOf(deep).defines, ['ErrZ']);
  });

  test('a block never outlives its hunk: an opener whose close is out of view does not make later hunks\' locals definitions', () => {
    const patch = [
      '@@ -1,3 +1,3 @@', '-var (', '+const (', ' \tA = 1',
      '@@ -30,4 +30,4 @@ func f() error {', '-\terr = g()', '+\terr = h()', '-\tcount = 1', '+\tcount = 2',
    ].join('\n');
    assert.deepEqual(changedSymbolsOf(patch).defines, []);
  });

  test('a class named only by the section heading has an unknown member indent: a method local deep in its body is not a member', () => {
    const patch = '@@ -20,6 +20,6 @@ class Judge:\n         total = 0\n-        result = 1\n+        result = 2';
    assert.deepEqual(changedSymbolsOf(patch).defines, []);
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

  test('a changed Go group member deep in its group is a seam to a file that uses it, through the hunk\'s section heading', () => {
    const errs = file('errs.go', 'var (\n\tErrNoRows = errors.New("no rows")\n)', '@@ -12,5 +12,5 @@ var (\n-\tErrNoRows = errors.New("none")\n+\tErrNoRows = errors.New("no rows")');
    const rows = file('rows.go', 'func (r *Rows) Next() error { return driver.ErrNoRows }', '@@ -1 +1 @@\n context');
    assert.deepEqual(seamsOf([errs, rows]), [{ a: 'errs.go', b: 'rows.go', weight: 1 }]);
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
