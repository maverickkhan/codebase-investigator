import { readFileSync, statSync } from 'node:fs';
import { safeJoin } from '../repo/manager.js';
import type { Citation, AuditResult } from '../session/store.js';

const CONTEXT_LINES = 3;

export type ProgrammaticReport = AuditResult['programmatic'] & {
  /** Map citation key -> verbatim slice of file (line-numbered). For judge prompt. */
  evidence: Map<string, string>;
};

/**
 * Verify each citation: file exists, lines exist, optional quote substring match.
 */
export function verifyCitations(repoRoot: string, citations: Citation[]): ProgrammaticReport {
  const invalid: ProgrammaticReport['citations_invalid'] = [];
  const mismatches: ProgrammaticReport['quote_mismatches'] = [];
  const evidence = new Map<string, string>();
  let valid = 0;

  for (const c of citations) {
    const key = `${c.path}:${c.start}-${c.end}`;
    let full: string;
    try { full = safeJoin(repoRoot, c.path); }
    catch (e: any) { invalid.push({ citation: c, reason: `path escapes repo: ${e.message}` }); continue; }

    let s;
    try { s = statSync(full); }
    catch { invalid.push({ citation: c, reason: 'file not found' }); continue; }
    if (!s.isFile()) { invalid.push({ citation: c, reason: 'not a file' }); continue; }

    let text: string;
    try { text = readFileSync(full, 'utf8'); }
    catch (e: any) { invalid.push({ citation: c, reason: `read failed: ${e.message}` }); continue; }

    const lines = text.split('\n');
    if (c.start < 1 || c.start > lines.length) {
      invalid.push({ citation: c, reason: `start line ${c.start} out of range (file has ${lines.length} lines)` });
      continue;
    }
    if (c.end < c.start || c.end > lines.length) {
      invalid.push({ citation: c, reason: `end line ${c.end} out of range (file has ${lines.length} lines)` });
      continue;
    }

    const slice = lines.slice(c.start - 1, c.end).join('\n');
    if (c.quote) {
      const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
      if (!norm(slice).includes(norm(c.quote))) {
        mismatches.push({ citation: c, reason: 'quoted text not found in cited line range' });
      } else {
        valid++;
      }
    } else {
      valid++;
    }
    const ctxStart = Math.max(1, c.start - CONTEXT_LINES);
    const ctxEnd = Math.min(lines.length, c.end + CONTEXT_LINES);
    const numbered = lines.slice(ctxStart - 1, ctxEnd)
      .map((l, i) => {
        const ln = ctxStart + i;
        const inRange = ln >= c.start && ln <= c.end;
        const marker = inRange ? '>' : ' ';
        return `${marker} ${String(ln).padStart(5, ' ')}  ${l}`;
      })
      .join('\n');
    const header = `>>> CITATION ${c.path}:${c.start}${c.end !== c.start ? '-' + c.end : ''}  (showing lines ${ctxStart}-${ctxEnd}, cited lines marked with >)`;
    evidence.set(key, `${header}\n${numbered}\n<<< END CITATION`);
  }

  return {
    citations_total: citations.length,
    citations_valid: valid,
    citations_invalid: invalid,
    quote_mismatches: mismatches,
    evidence,
  };
}
