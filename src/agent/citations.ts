import type { Citation } from '../session/store.js';

const PAREN_RE = /\(([^()]+)\)/g;
const PATH_LINE_RE = /^\s*([^\s,]+\.[A-Za-z0-9]{1,8}):L?(\d+)(?:[-–]L?(\d+))?\s*$/;
const LINE_ONLY_RE = /^\s*L?(\d+)(?:[-–]L?(\d+))?\s*$/;
const QUOTE_RE = />\s*"([^"]+)"\s*\(([^()]+)\)/g;

/**
 * Extract inline citations from agent text. Supports:
 *   (path/file.ts:42)
 *   (path/file.ts:42-58)
 *   (path/file.ts:L42-L58)
 *   (a.ts:10, b.ts:20)            - multi-path
 *   (a.ts:10, 20-30, 40)          - same path, multi range
 *   (a.ts:10, b.ts:20-30, 40)     - mixed; "40" reuses last path b.ts
 *
 * Skips parens that don't contain at least one `path.ext:line` form.
 * Non-citation parens (e.g. "(see below)") are ignored.
 */
export function extractCitations(text: string): Citation[] {
  const out: Citation[] = [];
  const seen = new Set<string>();
  const push = (c: Citation) => {
    const key = `${c.path}:${c.start}-${c.end}`;
    if (seen.has(key)) {
      const existing = out.find(e => `${e.path}:${e.start}-${e.end}` === key);
      if (existing && c.quote && !existing.quote) existing.quote = c.quote;
      return;
    }
    seen.add(key);
    out.push(c);
  };

  for (const m of text.matchAll(PAREN_RE)) {
    const inner = m[1];
    if (inner.includes('://')) continue; // URLs
    parseGroup(inner, push);
  }

  // Quoted-snippet form: attach quote text to matching citation
  for (const m of text.matchAll(QUOTE_RE)) {
    const inner = m[2];
    if (inner.includes('://')) continue;
    parseGroup(inner, c => {
      c.quote = m[1];
      push(c);
    });
  }

  return out;
}

function parseGroup(inner: string, push: (c: Citation) => void): void {
  const parts = inner.split(',').map(s => s.trim()).filter(Boolean);
  if (!parts.length) return;
  let currentPath: string | null = null;
  let anyEmitted = false;
  for (const part of parts) {
    const pathMatch = PATH_LINE_RE.exec(part);
    if (pathMatch) {
      currentPath = pathMatch[1];
      const start = parseInt(pathMatch[2], 10);
      const end = pathMatch[3] ? parseInt(pathMatch[3], 10) : start;
      if (Number.isFinite(start) && Number.isFinite(end) && start >= 1 && end >= start) {
        push({ path: currentPath, start, end });
        anyEmitted = true;
      }
      continue;
    }
    if (currentPath) {
      const lineMatch = LINE_ONLY_RE.exec(part);
      if (lineMatch) {
        const start = parseInt(lineMatch[1], 10);
        const end = lineMatch[2] ? parseInt(lineMatch[2], 10) : start;
        if (Number.isFinite(start) && Number.isFinite(end) && start >= 1 && end >= start) {
          push({ path: currentPath, start, end });
          anyEmitted = true;
        }
      }
    }
  }
  // If no citations emitted, this paren group wasn't a citation - that's fine, skipped.
  if (!anyEmitted) return;
}
