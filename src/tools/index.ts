import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { safeJoin } from '../repo/manager.js';

const MAX_READ_LINES = 400;
const MAX_GREP_RESULTS = 80;
const MAX_DIR_ENTRIES = 200;
const IGNORED_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', '.next', '.venv', 'venv', '__pycache__',
  'target', 'vendor', '.cache', '.turbo', 'out', 'coverage', '.pytest_cache',
]);
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.tar',
  '.gz', '.mp4', '.mp3', '.wav', '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.bin', '.so', '.dylib', '.dll', '.class', '.jar', '.wasm', '.exe',
]);

export type ToolContext = { repoRoot: string };

export type ToolResult = { ok: true; content: string } | { ok: false; error: string };

function ok(content: string): ToolResult { return { ok: true, content }; }
function err(error: string): ToolResult { return { ok: false, error }; }

export function listDir(ctx: ToolContext, args: { path?: string; depth?: number }): ToolResult {
  try {
    const root = args.path ? safeJoin(ctx.repoRoot, args.path) : ctx.repoRoot;
    const depth = Math.max(1, Math.min(args.depth ?? 2, 4));
    const lines: string[] = [];
    let count = 0;
    const walk = (dir: string, d: number, prefix: string) => {
      if (d > depth || count >= MAX_DIR_ENTRIES) return;
      let entries: string[];
      try { entries = readdirSync(dir).sort(); } catch { return; }
      for (const name of entries) {
        if (count >= MAX_DIR_ENTRIES) { lines.push(`${prefix}... (truncated)`); return; }
        if (IGNORED_DIRS.has(name)) continue;
        const full = join(dir, name);
        let s;
        try { s = statSync(full); } catch { continue; }
        const rel = relative(ctx.repoRoot, full);
        if (s.isDirectory()) {
          lines.push(`${prefix}${name}/`);
          count++;
          walk(full, d + 1, prefix + '  ');
        } else {
          lines.push(`${prefix}${name}  (${s.size}b)`);
          count++;
        }
      }
    };
    walk(root, 1, '');
    return ok(lines.length ? lines.join('\n') : '(empty)');
  } catch (e: any) { return err(e.message); }
}

export function readFile(ctx: ToolContext, args: { path: string; start?: number; end?: number }): ToolResult {
  try {
    if (!args.path) return err('path required');
    const full = safeJoin(ctx.repoRoot, args.path);
    const s = statSync(full);
    if (!s.isFile()) return err(`Not a file: ${args.path}`);
    if (BINARY_EXT.has(extname(args.path).toLowerCase())) return err(`Binary file: ${args.path}`);
    if (s.size > 2 * 1024 * 1024) return err(`File too large: ${(s.size / 1024).toFixed(0)}KB`);
    const text = readFileSync(full, 'utf8');
    const lines = text.split('\n');
    const total = lines.length;
    const start = Math.max(1, args.start ?? 1);
    let end = args.end ?? Math.min(total, start + MAX_READ_LINES - 1);
    if (end - start + 1 > MAX_READ_LINES) end = start + MAX_READ_LINES - 1;
    end = Math.min(end, total);
    const chunk = lines.slice(start - 1, end);
    const numbered = chunk.map((l, i) => `${String(start + i).padStart(5, ' ')}  ${l}`).join('\n');
    const header = `// ${args.path}  lines ${start}-${end} of ${total}`;
    const footer = end < total ? `\n// ... ${total - end} more lines. call again with start=${end + 1}.` : '';
    return ok(`${header}\n${numbered}${footer}`);
  } catch (e: any) { return err(e.message); }
}

export function grep(ctx: ToolContext, args: { pattern: string; glob?: string; case_sensitive?: boolean }): ToolResult {
  try {
    if (!args.pattern) return err('pattern required');
    const rgArgs = ['-n', '--no-heading', '--max-count', '40', '--max-columns', '300'];
    if (!args.case_sensitive) rgArgs.push('-i');
    if (args.glob) rgArgs.push('-g', args.glob);
    for (const d of IGNORED_DIRS) rgArgs.push('-g', `!${d}`);
    rgArgs.push('-e', args.pattern, '.');
    let out = '';
    try {
      out = execFileSync('rg', rgArgs, { cwd: ctx.repoRoot, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    } catch (e: any) {
      if (e.status === 1) return ok('(no matches)');
      return err(`rg failed: ${e.message}`);
    }
    const lines = out.split('\n').filter(Boolean);
    const head = lines.slice(0, MAX_GREP_RESULTS);
    const more = lines.length > MAX_GREP_RESULTS ? `\n... (${lines.length - MAX_GREP_RESULTS} more matches truncated)` : '';
    return ok(head.length ? head.join('\n') + more : '(no matches)');
  } catch (e: any) { return err(e.message); }
}

export function findSymbol(ctx: ToolContext, args: { name: string; kind?: 'def' | 'use' | 'any' }): ToolResult {
  try {
    if (!args.name) return err('name required');
    const kind = args.kind ?? 'def';
    let pattern: string;
    if (kind === 'def') {
      const n = args.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      pattern = `(function|class|interface|type|const|let|var|def|fn|struct|enum|trait)\\s+${n}\\b|\\b${n}\\s*[:=]\\s*(\\(|function|async|\\{)`;
    } else if (kind === 'use') {
      pattern = `\\b${args.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`;
    } else {
      pattern = `\\b${args.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`;
    }
    return grep(ctx, { pattern, case_sensitive: true });
  } catch (e: any) { return err(e.message); }
}

export function gitLog(ctx: ToolContext, args: { path?: string; limit?: number }): ToolResult {
  try {
    const limit = Math.max(1, Math.min(args.limit ?? 10, 30));
    const gitArgs = ['log', `-${limit}`, '--pretty=format:%h %ad %an  %s', '--date=short'];
    if (args.path) {
      const safe = safeJoin(ctx.repoRoot, args.path);
      gitArgs.push('--', relative(ctx.repoRoot, safe));
    }
    const out = execFileSync('git', gitArgs, { cwd: ctx.repoRoot, encoding: 'utf8', maxBuffer: 1024 * 1024 });
    return ok(out.trim() || '(no commits)');
  } catch (e: any) { return err(`git log failed: ${e.message}`); }
}

export const TOOL_REGISTRY = {
  list_dir: listDir,
  read_file: readFile,
  grep,
  find_symbol: findSymbol,
  git_log: gitLog,
} as const;

export type ToolName = keyof typeof TOOL_REGISTRY;

export function runTool(ctx: ToolContext, name: string, args: any): ToolResult {
  const fn = (TOOL_REGISTRY as any)[name];
  if (!fn) return err(`Unknown tool: ${name}`);
  return fn(ctx, args ?? {});
}
