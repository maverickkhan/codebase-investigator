import { GoogleGenAI } from '@google/genai';
import { judgeSystemPrompt } from '../agent/prompts.js';
import type { Session, Turn, AuditResult, AuditFinding } from '../session/store.js';
import { verifyCitations } from './verifier.js';

function getClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');
  return new GoogleGenAI({ apiKey });
}

function tryParseJson(s: string): any | null {
  let t = s.trim();
  // Strip code fences if present
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try { return JSON.parse(t); } catch {}
  // Try to extract first JSON object
  const m = t.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

export async function auditTurn(session: Session, turn: Turn): Promise<AuditResult> {
  const t0 = Date.now();
  const programmatic = verifyCitations(session.repo.path, turn.citations);

  // Build evidence block from verifier output (only verified ranges)
  const evidenceBlocks: string[] = [];
  for (const [, block] of programmatic.evidence) evidenceBlocks.push(block);
  const evidence = evidenceBlocks.join('\n\n') || '(no valid citations to show)';

  const priorTurnsSummary = session.turns
    .filter(t => t.index < turn.index)
    .slice(-5)
    .map(t => `Turn ${t.index} Q: ${t.question}\nTurn ${t.index} A: ${t.answer.slice(0, 600)}`)
    .join('\n---\n') || '(none)';

  const judgeUserPrompt = `# User question
${turn.question}

# Agent answer
${turn.answer}

# Verified evidence (only citations that passed structural checks)
${evidence}

# Programmatic verifier findings
- Citations claimed: ${programmatic.citations_total}
- Citations structurally valid: ${programmatic.citations_valid}
- Invalid citations: ${JSON.stringify(programmatic.citations_invalid.map(i => ({ ...i.citation, reason: i.reason })))}
- Quote mismatches: ${JSON.stringify(programmatic.quote_mismatches.map(i => ({ ...i.citation, reason: i.reason })))}

# Prior turns in this session (for consistency check)
${priorTurnsSummary}

Return only the JSON object specified in your instructions.`;

  const ai = getClient();
  const model = process.env.JUDGE_MODEL || 'gemini-2.5-flash';
  let parsed: any = null;
  let rawText = '';
  let judgeErr: string | null = null;
  const fallbackModels = [model, 'gemini-2.5-pro', 'gemini-2.0-flash-exp'].filter((m, i, a) => a.indexOf(m) === i);
  for (const m of fallbackModels) {
    try {
      const resp = await ai.models.generateContent({
        model: m,
        contents: [{ role: 'user', parts: [{ text: judgeUserPrompt }] }],
        config: {
          systemInstruction: judgeSystemPrompt(),
          temperature: 0.1,
          responseMimeType: 'application/json',
        },
      });
      rawText = resp.text ?? '';
      parsed = tryParseJson(rawText);
      if (parsed) { judgeErr = null; break; }
      judgeErr = 'judge returned unparseable output';
    } catch (e: any) {
      judgeErr = e.message || String(e);
      // Only retry on 503/UNAVAILABLE/429 rate-limit; bail otherwise
      if (!/503|UNAVAILABLE|429|RESOURCE_EXHAUSTED|overloaded|high demand/i.test(judgeErr || '')) break;
    }
  }
  if (!parsed) {
    parsed = {
      summary: `Judge unavailable: ${judgeErr ?? 'unknown error'}. Audit is INCOMPLETE - only programmatic verification applied.`,
      findings: [],
      contradicts_prior_turn: false,
      _judge_failed: true,
    };
  }

  if (!parsed || typeof parsed !== 'object') {
    parsed = {
      summary: 'Judge returned unparseable output.',
      findings: [],
      contradicts_prior_turn: false,
    };
  }

  const rawFindings: AuditFinding[] = Array.isArray(parsed.findings) ? parsed.findings.filter((f: any) => f && f.message) : [];

  // Programmatic verifier is ground truth on citation existence. The judge's
  // job is CLAIM SUPPORT, not citation bookkeeping. Drop noisy citation-category
  // findings the judge invents.
  const agentCiteKeys = new Set(turn.citations.map(c => `${c.path}:${c.start}-${c.end}`));
  const invalidKeys = new Set<string>([
    ...programmatic.citations_invalid.map(i => `${i.citation.path}:${i.citation.start}-${i.citation.end}`),
    ...programmatic.quote_mismatches.map(i => `${i.citation.path}:${i.citation.start}-${i.citation.end}`),
  ]);
  const findings: AuditFinding[] = [];
  let droppedCitationFindings = 0;
  // Pattern: judge complains some line range was "not provided/included/cited in evidence".
  const evidencePresenceRe = /\b(?:not (?:provided|present|included|cited|shown|visible|in|found|available|demonstrated))\b[^.]*?\b(?:evidence|snippet|context|provided range|verified|block|cited)\b/i;
  // Build mention strings for each valid citation key, e.g. "lib/foo.ts:26" / "lib/foo.ts:26-30"
  const validMentionRes: RegExp[] = [];
  for (const k of agentCiteKeys) {
    if (invalidKeys.has(k)) continue;
    const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    validMentionRes.push(new RegExp(`\\b${escaped}\\b`));
    // Single-line form too: "path:N" without "-N"
    const m = k.match(/^(.+):(\d+)-(\d+)$/);
    if (m && m[2] === m[3]) {
      const single = `${m[1]}:${m[2]}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      validMentionRes.push(new RegExp(`\\b${single}\\b`));
    }
  }
  for (const f of rawFindings) {
    // 1. Generic "not in evidence" complaint, regardless of category -> drop.
    if (evidencePresenceRe.test(f.message)) {
      droppedCitationFindings++;
      continue;
    }
    // 2. Finding mentions a valid agent citation key + sounds like a presence complaint -> drop.
    const mentionsValidKey = validMentionRes.some(re => re.test(f.message));
    if (mentionsValidKey && /\b(not\s+(?:provided|cited|included|shown|present|visible)|missing\s+from|outside)/i.test(f.message)) {
      droppedCitationFindings++;
      continue;
    }
    // 3. Citation-category finding referencing a key the agent never claimed (judge invention) -> drop.
    if (f.category === 'citation' && f.citation) {
      const k = `${f.citation.path}:${f.citation.start}-${f.citation.end}`;
      if (!agentCiteKeys.has(k) || !invalidKeys.has(k)) {
        droppedCitationFindings++;
        continue;
      }
    }
    findings.push(f);
  }

  // Inject programmatic findings as judge findings too - they are the most reliable signal.
  const progFindings: AuditFinding[] = [];
  for (const inv of programmatic.citations_invalid) {
    progFindings.push({
      severity: 'error',
      category: 'citation',
      message: `Hallucinated citation: ${inv.reason} (${inv.citation.path}:${inv.citation.start}-${inv.citation.end})`,
      citation: inv.citation,
    });
  }
  for (const mm of programmatic.quote_mismatches) {
    progFindings.push({
      severity: 'error',
      category: 'citation',
      message: `Quote does not match cited lines (${mm.citation.path}:${mm.citation.start}-${mm.citation.end})`,
      citation: mm.citation,
    });
  }

  // Heuristic: an answer with citations but ZERO tool calls is almost certainly
  // citing from pretraining memory, not from the actual repo. Flag it.
  if (turn.toolCalls.length === 0 && turn.citations.length > 0) {
    progFindings.unshift({
      severity: 'error',
      category: 'support',
      message: 'Answer cites file:line ranges but the agent made zero tool calls this turn. Citations are likely fabricated from training data, not verified against the actual repo.',
    });
  }

  // Per-citation tool-touch check: did any tool call this turn actually touch
  // the cited file? If not, the citation is almost certainly guessed from
  // pretraining memory ("Dockerfile is usually ~500 lines so :1-477"), even if
  // the path itself happens to exist in the repo.
  const touchedPaths = new Set<string>();
  for (const tc of turn.toolCalls) {
    const a = tc.args || {};
    if (typeof a.path === 'string') touchedPaths.add(a.path);
    // grep without a glob touches everything; grep with a glob is hard to map
    // to a path, so be conservative and only credit explicit path args.
    if (tc.name === 'grep' && !a.glob) {
      // Whole-repo grep - credit all paths (we cannot prove it didn't read this file).
      for (const c of turn.citations) touchedPaths.add(c.path);
    }
  }
  for (const c of turn.citations) {
    if (touchedPaths.has(c.path)) continue;
    const span = c.end - c.start + 1;
    if (span >= 50) {
      // Large range on a file we never opened - almost certainly a guess.
      progFindings.unshift({
        severity: 'error',
        category: 'support',
        message: `Suspicious citation: ${c.path}:${c.start}-${c.end} spans ${span} lines but no tool call this turn touched ${c.path}. Likely a guessed whole-file range from training data.`,
        citation: c,
      });
    }
  }

  // If judge unavailable, add an info finding so the reviewer knows audit is partial.
  if (parsed._judge_failed) {
    progFindings.unshift({
      severity: 'warn',
      category: 'gap',
      message: 'Judge model unavailable - only programmatic citation verification was applied. Trust score reflects citation hygiene only, not claim support.',
    });
  }

  const allFindings = [...progFindings, ...findings];

  const trustScore = computeTrustScore(programmatic, allFindings, turn, !!parsed._judge_failed);

  let summary = parsed.summary || '(no summary)';
  if (droppedCitationFindings > 0) {
    // Strip evidence-presence complaints from the summary too.
    summary = summary
      .replace(/[^.]*\b(?:not (?:provided|present|included|in|found|available|demonstrated)\b[^.]*\b(?:evidence|snippet|context))[^.]*\.\s?/gi, '')
      .replace(/[^.]*\b(?:were not (?:included|provided))[^.]*\.\s?/gi, '')
      .replace(/[^.]*\b(?:no evidence snippet|outside the (?:verified )?evidence|missing from (?:the )?(?:verified )?evidence)[^.]*\.\s?/gi, '')
      .trim();
    if (!summary) summary = 'Findings reduced to claim-support issues (judge raised noisy evidence-presence complaints; filtered).';
    summary += ` [auditor: filtered ${droppedCitationFindings} evidence-presence complaint${droppedCitationFindings === 1 ? '' : 's'} that contradicted programmatic verifier.]`;
  }

  return {
    trust_score: trustScore,
    programmatic: {
      citations_total: programmatic.citations_total,
      citations_valid: programmatic.citations_valid,
      citations_invalid: programmatic.citations_invalid,
      quote_mismatches: programmatic.quote_mismatches,
    },
    judge: {
      model,
      summary,
      findings: allFindings,
      contradicts_prior_turn: !!parsed.contradicts_prior_turn,
      contradiction_note: parsed.contradiction_note || '',
    },
    generated_ms: Date.now() - t0,
  };
}

function computeTrustScore(
  prog: ReturnType<typeof verifyCitations>,
  findings: AuditFinding[],
  turn: Turn,
  judgeFailed: boolean,
): number {
  let score = 100;
  if (prog.citations_total === 0) score -= 30;
  else {
    const validRatio = prog.citations_valid / prog.citations_total;
    score -= Math.round((1 - validRatio) * 50);
  }
  // Hard cap if agent answered without using tools but cited files.
  if (turn.toolCalls.length === 0 && turn.citations.length > 0) {
    score = Math.min(score, 25);
  }
  // Cap when judge unavailable - without claim-support audit we cannot fully trust.
  if (judgeFailed) score = Math.min(score, 60);
  for (const f of findings) {
    if (f.severity === 'error') score -= 15;
    else if (f.severity === 'warn') score -= 6;
    else score -= 1;
  }
  return Math.max(0, Math.min(100, score));
}
