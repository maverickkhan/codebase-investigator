import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { extractCitations } from './citations.js';

test('single citation', () => {
  const c = extractCitations('See (src/foo.ts:42).');
  assert.deepEqual(c, [{ path: 'src/foo.ts', start: 42, end: 42 }]);
});

test('range citation', () => {
  const c = extractCitations('Lines (src/foo.ts:42-58) matter.');
  assert.deepEqual(c, [{ path: 'src/foo.ts', start: 42, end: 58 }]);
});

test('L-prefixed', () => {
  const c = extractCitations('Look at (a.ts:L10-L20)');
  assert.deepEqual(c, [{ path: 'a.ts', start: 10, end: 20 }]);
});

test('multi-cite, multiple paths', () => {
  const c = extractCitations('See (src/a.ts:10, src/b.ts:20-30).');
  assert.deepEqual(c, [
    { path: 'src/a.ts', start: 10, end: 10 },
    { path: 'src/b.ts', start: 20, end: 30 },
  ]);
});

test('multi-cite, same path multiple ranges', () => {
  const c = extractCitations('Refer (src/foo.ts:10, 20-30, 40).');
  assert.deepEqual(c, [
    { path: 'src/foo.ts', start: 10, end: 10 },
    { path: 'src/foo.ts', start: 20, end: 30 },
    { path: 'src/foo.ts', start: 40, end: 40 },
  ]);
});

test('multi-cite, mixed', () => {
  const c = extractCitations('See (a.ts:10, 20, b.ts:30, 40-50).');
  assert.deepEqual(c, [
    { path: 'a.ts', start: 10, end: 10 },
    { path: 'a.ts', start: 20, end: 20 },
    { path: 'b.ts', start: 30, end: 30 },
    { path: 'b.ts', start: 40, end: 50 },
  ]);
});

test('skips non-citation parens', () => {
  assert.deepEqual(extractCitations('hello (world)'), []);
  assert.deepEqual(extractCitations('see https://github.com (some text)'), []);
  assert.deepEqual(extractCitations('check it out (see below)'), []);
});

test('skips URL parens', () => {
  assert.deepEqual(extractCitations('docs (https://example.com/path:42)'), []);
});

test('quoted snippet attaches quote', () => {
  const c = extractCitations(`Like this:\n> "var x = 1;" (src/foo.ts:5)`);
  assert.deepEqual(c, [{ path: 'src/foo.ts', start: 5, end: 5, quote: 'var x = 1;' }]);
});

test('quoted snippet with multi-cite uses first', () => {
  const c = extractCitations(`> "code" (src/a.ts:5, src/b.ts:10)`);
  assert.equal(c.length, 2);
  assert.equal(c[0].quote, 'code');
});

test('dedupes identical citations', () => {
  const c = extractCitations('A (a.ts:1) B (a.ts:1) C (a.ts:1-1)');
  assert.equal(c.length, 1);
  assert.deepEqual(c[0], { path: 'a.ts', start: 1, end: 1 });
});

test('rejects invalid ranges', () => {
  assert.deepEqual(extractCitations('(a.ts:10-5)'), []);
  assert.deepEqual(extractCitations('(a.ts:0)'), []);
});

test('many citations across paragraph', () => {
  const c = extractCitations(`
The router lives in (src/router.ts:10-20).
Routes wired at (src/index.ts:5, 12).
Helpers in (src/util/path.ts:1-8).
`);
  assert.equal(c.length, 4);
  assert.equal(c[0].path, 'src/router.ts');
  assert.equal(c[1].path, 'src/index.ts');
  assert.equal(c[2].path, 'src/index.ts');
  assert.equal(c[3].path, 'src/util/path.ts');
});
