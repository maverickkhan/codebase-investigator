import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { ensureRepo, safeJoin } from './repo/manager.js';
import { createSession, getSession, deleteSession, listSessions } from './session/store.js';
import { runAgentTurn } from './agent/loop.js';
import { auditTurn } from './audit/judge.js';
import { exportSessionJson, exportSessionMarkdown } from './session/export.js';

const app = new Hono();

app.get('/api/health', c => c.json({ ok: true, ts: Date.now() }));

const startSessionSchema = z.object({ url: z.string().url() });

app.post('/api/session', async c => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = startSessionSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  try {
    const repo = await ensureRepo(parsed.data.url);
    const s = createSession(repo);
    return c.json({
      session_id: s.id,
      repo: { owner: repo.owner, repo: repo.repo, branch: repo.branch ?? null, url: repo.url },
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

app.get('/api/session/:id', c => {
  const s = getSession(c.req.param('id'));
  if (!s) return c.json({ error: 'session not found' }, 404);
  return c.json({
    session_id: s.id,
    repo: { owner: s.repo.owner, repo: s.repo.repo, branch: s.repo.branch ?? null, url: s.repo.url },
    turns: s.turns.map(t => ({
      id: t.id,
      index: t.index,
      question: t.question,
      answer: t.answer,
      citations: t.citations,
      tool_calls: t.toolCalls,
      audit: t.audit,
      created_at: t.createdAt,
    })),
  });
});

app.delete('/api/session/:id', c => {
  const ok = deleteSession(c.req.param('id'));
  return c.json({ ok });
});

app.get('/api/sessions', c => {
  return c.json({
    sessions: listSessions().map(s => ({
      id: s.id,
      repo: `${s.repo.owner}/${s.repo.repo}`,
      turns: s.turns.length,
      created_at: s.createdAt,
    })),
  });
});

const chatSchema = z.object({ session_id: z.string(), question: z.string().min(1) });

app.post('/api/chat', async c => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = chatSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const s = getSession(parsed.data.session_id);
  if (!s) return c.json({ error: 'session not found' }, 404);
  try {
    const turn = await runAgentTurn(s, parsed.data.question);
    // Run audit (await - small enough to keep simple; optimize to async later)
    try {
      turn.audit = await auditTurn(s, turn);
    } catch (e: any) {
      turn.audit = {
        trust_score: 0,
        programmatic: { citations_total: turn.citations.length, citations_valid: 0, citations_invalid: [], quote_mismatches: [] },
        judge: { model: 'unavailable', summary: `Audit failed: ${e.message}`, findings: [], contradicts_prior_turn: false },
        generated_ms: 0,
      };
    }
    return c.json({
      turn: {
        id: turn.id,
        index: turn.index,
        question: turn.question,
        answer: turn.answer,
        citations: turn.citations,
        tool_calls: turn.toolCalls,
        audit: turn.audit,
        created_at: turn.createdAt,
      },
    });
  } catch (e: any) {
    return c.json({ error: e.message, stack: process.env.NODE_ENV === 'development' ? e.stack : undefined }, 500);
  }
});

app.post('/api/chat/stream', c => {
  return streamSSE(c, async stream => {
    let body: any;
    try { body = await c.req.json(); } catch { body = {}; }
    const parsed = chatSchema.safeParse(body);
    if (!parsed.success) {
      await stream.writeSSE({ event: 'error', data: JSON.stringify({ error: parsed.error.flatten() }) });
      return;
    }
    const s = getSession(parsed.data.session_id);
    if (!s) {
      await stream.writeSSE({ event: 'error', data: JSON.stringify({ error: 'session not found' }) });
      return;
    }
    let aborted = false;
    stream.onAbort(() => { aborted = true; });
    try {
      const turn = await runAgentTurn(s, parsed.data.question, async ev => {
        if (aborted) return;
        await stream.writeSSE({ event: ev.type, data: JSON.stringify(ev.data) });
      });
      if (aborted) return;
      await stream.writeSSE({ event: 'auditing', data: JSON.stringify({ message: 'running audit...' }) });
      try {
        turn.audit = await auditTurn(s, turn);
      } catch (e: any) {
        turn.audit = {
          trust_score: 0,
          programmatic: { citations_total: turn.citations.length, citations_valid: 0, citations_invalid: [], quote_mismatches: [] },
          judge: { model: 'unavailable', summary: `Audit failed: ${e.message}`, findings: [], contradicts_prior_turn: false },
          generated_ms: 0,
        };
      }
      if (aborted) return;
      await stream.writeSSE({
        event: 'final',
        data: JSON.stringify({
          turn: {
            id: turn.id,
            index: turn.index,
            question: turn.question,
            answer: turn.answer,
            citations: turn.citations,
            tool_calls: turn.toolCalls,
            audit: turn.audit,
            created_at: turn.createdAt,
          },
        }),
      });
    } catch (e: any) {
      await stream.writeSSE({ event: 'error', data: JSON.stringify({ error: e.message }) });
    }
  });
});

app.get('/api/session/:id/export', c => {
  const s = getSession(c.req.param('id'));
  if (!s) return c.json({ error: 'session not found' }, 404);
  const fmt = c.req.query('format') || 'json';
  if (fmt === 'md' || fmt === 'markdown') {
    const md = exportSessionMarkdown(s);
    return new Response(md, {
      headers: {
        'content-type': 'text/markdown; charset=utf-8',
        'content-disposition': `attachment; filename="session-${s.repo.owner}-${s.repo.repo}-${s.id.slice(0, 8)}.md"`,
      },
    });
  }
  const json = JSON.stringify(exportSessionJson(s), null, 2);
  return new Response(json, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="session-${s.repo.owner}-${s.repo.repo}-${s.id.slice(0, 8)}.json"`,
    },
  });
});

// Serve a slice of a file - used by the UI to render citation snippets.
const fileSchema = z.object({
  session_id: z.string(),
  path: z.string(),
  start: z.coerce.number().int().min(1).optional(),
  end: z.coerce.number().int().min(1).optional(),
});

app.get('/api/file', c => {
  const parsed = fileSchema.safeParse({
    session_id: c.req.query('session_id'),
    path: c.req.query('path'),
    start: c.req.query('start'),
    end: c.req.query('end'),
  });
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const s = getSession(parsed.data.session_id);
  if (!s) return c.json({ error: 'session not found' }, 404);
  try {
    const full = safeJoin(s.repo.path, parsed.data.path);
    const text = readFileSync(full, 'utf8');
    const lines = text.split('\n');
    const start = parsed.data.start ?? 1;
    const end = Math.min(parsed.data.end ?? lines.length, lines.length);
    const slice = lines.slice(start - 1, end);
    return c.json({
      path: parsed.data.path,
      start,
      end,
      total_lines: lines.length,
      lines: slice,
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

app.use('/*', serveStatic({ root: './public' }));
app.get('/', c => c.redirect('/index.html'));

const port = Number(process.env.PORT || 3000);
serve({ fetch: app.fetch, port }, info => {
  console.log(`Codebase Investigator listening on http://localhost:${info.port}`);
});
