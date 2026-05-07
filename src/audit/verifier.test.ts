import { test, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyCitations } from './verifier.js';

let root: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'verifier-test-'));
  writeFileSync(join(root, 'a.txt'), 'line1\nline2\nline3\nline4\nline5\n');
  writeFileSync(join(root, 'quoted.txt'), 'hello\nfunction foo() {\n  return 42;\n}\nworld\n');
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

test('valid single line', () => {
  const r = verifyCitations(root, [{ path: 'a.txt', start: 2, end: 2 }]);
  assert.equal(r.citations_valid, 1);
  assert.equal(r.citations_invalid.length, 0);
  assert.equal(r.evidence.size, 1);
});

test('valid range', () => {
  const r = verifyCitations(root, [{ path: 'a.txt', start: 1, end: 5 }]);
  assert.equal(r.citations_valid, 1);
  assert.equal(r.citations_invalid.length, 0);
});

test('missing file', () => {
  const r = verifyCitations(root, [{ path: 'nope.txt', start: 1, end: 1 }]);
  assert.equal(r.citations_valid, 0);
  assert.equal(r.citations_invalid.length, 1);
  assert.match(r.citations_invalid[0].reason, /not found/);
});

test('line out of range', () => {
  const r = verifyCitations(root, [{ path: 'a.txt', start: 99, end: 100 }]);
  assert.equal(r.citations_valid, 0);
  assert.equal(r.citations_invalid.length, 1);
  assert.match(r.citations_invalid[0].reason, /out of range/);
});

test('quote substring match', () => {
  const r = verifyCitations(root, [{ path: 'quoted.txt', start: 2, end: 4, quote: 'return 42' }]);
  assert.equal(r.citations_valid, 1);
  assert.equal(r.quote_mismatches.length, 0);
});

test('quote mismatch flagged', () => {
  const r = verifyCitations(root, [{ path: 'quoted.txt', start: 2, end: 4, quote: 'return 99' }]);
  assert.equal(r.citations_valid, 0);
  assert.equal(r.quote_mismatches.length, 1);
});

test('path traversal rejected', () => {
  const r = verifyCitations(root, [{ path: '../../etc/passwd', start: 1, end: 1 }]);
  assert.equal(r.citations_valid, 0);
  assert.equal(r.citations_invalid.length, 1);
  assert.match(r.citations_invalid[0].reason, /escapes repo/);
});

test('evidence includes context lines', () => {
  const r = verifyCitations(root, [{ path: 'a.txt', start: 3, end: 3 }]);
  const e = [...r.evidence.values()][0];
  // Context CONTEXT_LINES=3 either side, so should include lines 1-5.
  assert.match(e, /1\s+line1/);
  assert.match(e, /5\s+line5/);
  // Cited line marked with >
  assert.match(e, />\s+3\s+line3/);
});
