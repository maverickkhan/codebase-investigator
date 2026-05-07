import { simpleGit } from 'simple-git';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, normalize, relative, isAbsolute } from 'node:path';
import { rm } from 'node:fs/promises';

const CACHE_DIR = resolve(process.env.REPO_CACHE_DIR || './repos_cache');
const MAX_REPO_BYTES = 200 * 1024 * 1024; // 200MB cap

export type RepoInfo = {
  url: string;
  owner: string;
  repo: string;
  branch?: string;
  path: string;
  hash: string;
};

export function parseGithubUrl(url: string): { owner: string; repo: string; branch?: string } {
  const trimmed = url.trim().replace(/\.git$/, '').replace(/\/$/, '');
  const m = trimmed.match(/github\.com[:/]+([^/]+)\/([^/]+?)(?:\/tree\/([^/]+))?$/i);
  if (!m) throw new Error(`Not a valid GitHub URL: ${url}`);
  return { owner: m[1], repo: m[2], branch: m[3] };
}

export function hashUrl(url: string): string {
  return createHash('sha1').update(url).digest('hex').slice(0, 12);
}

export async function ensureRepo(url: string, onProgress?: (msg: string) => void): Promise<RepoInfo> {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  const { owner, repo, branch } = parseGithubUrl(url);
  const hash = hashUrl(url);
  const path = join(CACHE_DIR, `${owner}__${repo}__${hash}`);

  if (existsSync(path) && existsSync(join(path, '.git'))) {
    onProgress?.(`Cache hit: ${owner}/${repo}`);
    return { url, owner, repo, branch, path, hash };
  }

  onProgress?.(`Cloning ${owner}/${repo}...`);
  const cloneUrl = `https://github.com/${owner}/${repo}.git`;
  const git = simpleGit();
  const args = ['--depth', '50', '--single-branch'];
  if (branch) args.push('--branch', branch);

  try {
    await git.clone(cloneUrl, path, args);
  } catch (e: any) {
    throw new Error(`Clone failed: ${e.message}`);
  }

  const size = dirSize(path);
  if (size > MAX_REPO_BYTES) {
    await rm(path, { recursive: true, force: true });
    throw new Error(`Repo too large: ${(size / 1024 / 1024).toFixed(1)}MB > 200MB`);
  }
  onProgress?.(`Cloned (${(size / 1024 / 1024).toFixed(1)}MB)`);
  return { url, owner, repo, branch, path, hash };
}

function dirSize(dir: string): number {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const p = stack.pop()!;
    let s;
    try { s = statSync(p); } catch { continue; }
    if (s.isDirectory()) {
      for (const e of readdirSync(p)) stack.push(join(p, e));
    } else {
      total += s.size;
    }
  }
  return total;
}

/**
 * Resolve a user-supplied path against repo root, refusing escapes.
 * Returns absolute path inside repo.
 */
export function safeJoin(repoRoot: string, userPath: string): string {
  const rel = userPath.replace(/^\/+/, '');
  const joined = normalize(join(repoRoot, rel));
  const r = relative(repoRoot, joined);
  if (r.startsWith('..') || isAbsolute(r)) {
    throw new Error(`Path escapes repo root: ${userPath}`);
  }
  return joined;
}
