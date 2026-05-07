import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildLedger, trimHistory } from './store.js';
import type { Session, Turn } from './store.js';

function makeTurn(idx: number, q: string, a: string, cites: { path: string; start: number; end: number }[] = []): Turn {
  return {
    id: `t${idx}`,
    index: idx,
    question: q,
    answer: a,
    citations: cites,
    toolCalls: [],
    createdAt: Date.now(),
  };
}

test('ledger empty when no prior turns', () => {
  const s: any = { turns: [] };
  assert.equal(buildLedger(s as Session, 1), '(no prior turns)');
});

test('ledger lists prior turn questions and citations', () => {
  const s: any = {
    turns: [
      makeTurn(1, 'how does auth work', 'JWT used here', [{ path: 'auth.ts', start: 5, end: 10 }]),
      makeTurn(2, 'is it safe', 'mostly', []),
    ],
  };
  const out = buildLedger(s as Session, 3);
  assert.match(out, /Turn 1/);
  assert.match(out, /how does auth work/);
  assert.match(out, /auth\.ts:5-10/);
  assert.match(out, /Turn 2/);
});

test('ledger excludes current and future turns', () => {
  const s: any = {
    turns: [
      makeTurn(1, 'q1', 'a1'),
      makeTurn(2, 'q2', 'a2'),
      makeTurn(3, 'q3', 'a3'),
    ],
  };
  const out = buildLedger(s as Session, 2);
  assert.match(out, /Turn 1/);
  assert.doesNotMatch(out, /Turn 2/);
  assert.doesNotMatch(out, /Turn 3/);
});

test('ledger truncates very long answers', () => {
  const long = 'X'.repeat(1000);
  const s: any = { turns: [makeTurn(1, 'q', long)] };
  const out = buildLedger(s as Session, 2);
  assert.ok(out.length < 600, `ledger too long: ${out.length}`);
  assert.match(out, /\.\.\./);
});

test('trimHistory keeps last N user turns', () => {
  const h: any[] = [
    { role: 'user', parts: [{ text: 'Q1' }] },
    { role: 'model', parts: [{ text: 'A1' }] },
    { role: 'user', parts: [{ text: 'Q2' }] },
    { role: 'model', parts: [{ text: 'A2' }] },
    { role: 'user', parts: [{ text: 'Q3' }] },
    { role: 'model', parts: [{ text: 'A3' }] },
    { role: 'user', parts: [{ text: 'Q4' }] },
    { role: 'model', parts: [{ text: 'A4' }] },
  ];
  const trimmed = trimHistory(h, 2);
  // Should drop Q1/Q2 turns, keep Q3 and Q4.
  const texts = trimmed.flatMap((c: any) => c.parts.map((p: any) => p.text));
  assert.ok(texts.includes('Q3'), 'should keep Q3');
  assert.ok(texts.includes('Q4'), 'should keep Q4');
  assert.ok(!texts.includes('Q1'), 'should drop Q1');
  assert.ok(!texts.includes('Q2'), 'should drop Q2');
});

test('trimHistory ignores function-response user entries', () => {
  const h: any[] = [
    { role: 'user', parts: [{ text: 'Q1' }] },
    { role: 'model', parts: [{ functionCall: { name: 'grep', args: {} } }] },
    { role: 'user', parts: [{ functionResponse: { name: 'grep', response: { content: 'r' } } }] },
    { role: 'model', parts: [{ text: 'A1' }] },
    { role: 'user', parts: [{ text: 'Q2' }] },
    { role: 'model', parts: [{ text: 'A2' }] },
  ];
  const trimmed = trimHistory(h, 1);
  // Should keep only the Q2 turn boundary forward.
  const texts = trimmed.flatMap((c: any) => c.parts.map((p: any) => p.text).filter(Boolean));
  assert.ok(texts.includes('Q2'));
  assert.ok(!texts.includes('Q1'));
});
