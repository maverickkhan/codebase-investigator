import { randomUUID } from 'node:crypto';
import type { Content } from '@google/genai';
import type { RepoInfo } from '../repo/manager.js';

export type Citation = {
  path: string;
  start: number;
  end: number;
  /** Optional verbatim snippet the agent quoted; lets verifier do substring check. */
  quote?: string;
};

export type AuditFinding = {
  severity: 'info' | 'warn' | 'error';
  category: 'citation' | 'support' | 'overconfidence' | 'gap' | 'risk' | 'consistency';
  message: string;
  citation?: Citation;
};

export type AuditResult = {
  trust_score: number; // 0-100
  programmatic: {
    citations_total: number;
    citations_valid: number;
    citations_invalid: Array<{ citation: Citation; reason: string }>;
    quote_mismatches: Array<{ citation: Citation; reason: string }>;
  };
  judge: {
    model: string;
    summary: string;
    findings: AuditFinding[];
    contradicts_prior_turn: boolean;
    contradiction_note?: string;
  };
  generated_ms: number;
};

export type Turn = {
  id: string;
  index: number;
  question: string;
  answer: string;
  citations: Citation[];
  toolCalls: Array<{ name: string; args: any; ok: boolean; bytes: number }>;
  audit?: AuditResult;
  createdAt: number;
};

export type Session = {
  id: string;
  repo: RepoInfo;
  history: Content[]; // raw Gemini conversation history (user+model+function turns)
  turns: Turn[];
  createdAt: number;
};

const sessions = new Map<string, Session>();

export function createSession(repo: RepoInfo): Session {
  const s: Session = {
    id: randomUUID(),
    repo,
    history: [],
    turns: [],
    createdAt: Date.now(),
  };
  sessions.set(s.id, s);
  return s;
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

export function deleteSession(id: string): boolean {
  return sessions.delete(id);
}

export function listSessions(): Session[] {
  return [...sessions.values()];
}

/**
 * Compressed ledger of prior claims. Passed each turn so the agent can
 * stay coherent across 8-15 turns and detect when the user references
 * an earlier statement.
 */
export function buildLedger(s: Session, currentTurnIdx: number): string {
  const past = s.turns.filter(t => t.index < currentTurnIdx);
  if (past.length === 0) return '(no prior turns)';
  const lines: string[] = [];
  for (const t of past) {
    lines.push(`Turn ${t.index} - Q: ${oneLine(t.question, 140)}`);
    lines.push(`  A: ${oneLine(t.answer, 240)}`);
    if (t.citations.length) {
      const cs = t.citations.slice(0, 6).map(c => `${c.path}:${c.start}-${c.end}`).join(', ');
      lines.push(`  Cites: ${cs}${t.citations.length > 6 ? ` (+${t.citations.length - 6} more)` : ''}`);
    }
    if (t.audit) {
      lines.push(`  Trust: ${t.audit.trust_score}/100${t.audit.judge.findings.length ? ` (${t.audit.judge.findings.length} findings)` : ''}`);
    }
  }
  return lines.join('\n');
}

function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + '...';
}

/**
 * Trim raw conversation history sent to Gemini. Keep last N turns of
 * function-call traces; older turns are represented in the ledger summary
 * so context doesn't explode.
 *
 * IMPORTANT: cut MUST land on a user-question boundary. Cutting in the middle
 * of a function-call sequence produces Gemini's "function call turn comes
 * immediately after a user turn or after a function response turn" error.
 */
export function trimHistory(history: Content[], keepLastUserTurns = 3): Content[] {
  let userCount = 0;
  let cutIdx = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const c = history[i];
    if (c.role === 'user' && !c.parts?.some(p => 'functionResponse' in p)) {
      userCount++;
      if (userCount === keepLastUserTurns) {
        cutIdx = i;
        break;
      }
    }
  }
  return history.slice(cutIdx);
}
