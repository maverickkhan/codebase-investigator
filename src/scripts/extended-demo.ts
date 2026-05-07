// Drives an 8-turn investigation against a real repo via the running server.
// Run while server is up: `npx tsx --env-file=.env src/scripts/extended-demo.ts [URL]`
const BASE = process.env.BASE || 'http://localhost:3737';
const REPO_URL = process.argv[2] || 'https://github.com/expressjs/express';

async function post(path: string, body: any): Promise<any> {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(d));
  return d;
}
async function get(path: string): Promise<any> {
  const r = await fetch(`${BASE}${path}`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

const QUESTIONS = [
  { tag: 'retrieval',     q: 'How does routing work in this repo? Skip the obvious - focus on where it is wired up.' },
  { tag: 'walkthrough',   q: 'Walk me through what happens between calling express() and a response being sent. Flag any step that feels brittle.' },
  { tag: 'opinion',       q: 'Suggest a better way to handle errors in lib/application.js. Be specific and ground it in the current code.' },
  { tag: 'why',           q: 'Why is the top-level index.js so minimal? Does it need to be that way?' },
  { tag: 'dead-code',     q: 'Looking at the examples/ directory, anything that looks stale or safe to delete?' },
  { tag: 'pushback',      q: 'In your first answer you said routing is fully delegated to an external package. Is that strictly true everywhere? Verify with grep.' },
  { tag: 'contradiction', q: 'Earlier you implied app.handle does some internal request routing work. Reconcile that with your routing-is-external claim.' },
  { tag: 'final-opinion', q: 'If you had to make ONE change to lib/application.js with the most upside, what would it be? Cite the specific lines you would touch.' },
];

(async () => {
  console.log('Health:', await get('/api/health'));
  const ses = await post('/api/session', { url: REPO_URL });
  const sid = ses.session_id;
  console.log(`Session: ${sid}\nRepo: ${ses.repo.owner}/${ses.repo.repo}\n`);

  for (let i = 0; i < QUESTIONS.length; i++) {
    const { tag, q } = QUESTIONS[i];
    const t0 = Date.now();
    process.stdout.write(`Turn ${i + 1} (${tag}) ... `);
    try {
      const r = await post('/api/chat', { session_id: sid, question: q });
      const t = r.turn;
      const a = t.audit;
      const dur = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(
        `trust=${a?.trust_score ?? '?'}/100 ` +
        `cites=${a?.programmatic.citations_valid ?? 0}/${a?.programmatic.citations_total ?? 0} ` +
        `tools=${t.tool_calls.length} ` +
        `findings=${a?.judge.findings.length ?? 0} ` +
        `(${dur}s)`,
      );
    } catch (e: any) {
      console.log(`ERROR ${e.message}`);
    }
  }

  console.log(`\nExport: ${BASE}/api/session/${sid}/export?format=md`);
})();
