// Direct smoke test of tools - no LLM needed.
import { runTool } from '../tools/index.js';
import { ensureRepo } from '../repo/manager.js';

const url = process.argv[2] ?? 'https://github.com/expressjs/express';

const repo = await ensureRepo(url, m => console.log(`[repo] ${m}`));
const ctx = { repoRoot: repo.path };

function show(label: string, r: ReturnType<typeof runTool>) {
  console.log(`\n=== ${label} ===`);
  if (!r.ok) console.log('ERROR:', r.error);
  else console.log(r.content.slice(0, 600) + (r.content.length > 600 ? `\n... (${r.content.length} chars)` : ''));
}

show('list_dir root', runTool(ctx, 'list_dir', { depth: 2 }));
show('grep "express()"', runTool(ctx, 'grep', { pattern: 'function express\\(', glob: '*.js' }));
show('find_symbol Router', runTool(ctx, 'find_symbol', { name: 'Router', kind: 'def' }));
show('read_file index.js', runTool(ctx, 'read_file', { path: 'index.js', start: 1, end: 30 }));
show('git_log limit 5', runTool(ctx, 'git_log', { limit: 5 }));
show('escape attempt', runTool(ctx, 'read_file', { path: '../../etc/passwd' }));
show('unknown tool', runTool(ctx, 'eval_code', {}));
