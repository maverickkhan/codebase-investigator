import { GoogleGenAI, type Content, type Part } from '@google/genai';
import { TOOL_DECLARATIONS } from '../tools/declarations.js';
import { runTool } from '../tools/index.js';
import { AGENT_SYSTEM_PROMPT } from './prompts.js';
import { extractCitations } from './citations.js';
import type { Session, Turn } from '../session/store.js';
import { buildLedger, trimHistory } from '../session/store.js';
import { randomUUID } from 'node:crypto';

const MAX_TOOL_ITERATIONS = 16;
const MAX_TOOL_RESULT_CHARS = 14000;
const NO_TOOL_REPROMPT = `Hold on. You produced an answer without calling any tools this turn. That means any file paths or line numbers you cited come from your pretraining memory, NOT from the actual repository - and codebases drift, so those citations are very likely hallucinated.

Discard the previous answer. Start over for this turn:
1. Call list_dir on the repo root (or a relevant subdir) to see what files actually exist NOW.
2. Use grep or find_symbol to locate the relevant code.
3. Use read_file to confirm the lines you want to cite.
4. Then write the answer, citing only ranges you saw in tool output this turn.`;

export type AgentEvent =
  | { type: 'iteration'; data: { iter: number; pass: number; model?: string; retried?: boolean; err?: string } }
  | { type: 'text_delta'; data: { text: string } }
  | { type: 'text_clear'; data: { reason: string } }
  | { type: 'tool_call'; data: { name: string; args: any } }
  | { type: 'tool_result'; data: { name: string; ok: boolean; bytes: number } }
  | { type: 'model_text'; data: { text: string } };

export type EventSink = (e: AgentEvent) => void | Promise<void>;

function getClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');
  return new GoogleGenAI({ apiKey });
}

function agentModelChain(): string[] {
  const primary = process.env.AGENT_MODEL || 'gemini-2.5-pro';
  const chain = [primary, 'gemini-2.5-flash', 'gemini-2.0-flash-exp', 'gemini-2.5-pro'];
  return chain.filter((m, i, a) => a.indexOf(m) === i);
}

const TRANSIENT_ERR = /503|UNAVAILABLE|429|RESOURCE_EXHAUSTED|overloaded|high demand/i;

/**
 * Stream a model response with multi-model fallback. Emits text_delta events
 * during streaming. Returns the accumulated parts (text + functionCalls).
 */
async function streamWithFallback(
  ai: GoogleGenAI,
  contents: Content[],
  systemInstruction: string,
  tools: any,
  onEvent: EventSink | undefined,
  iter: number,
  pass: number,
): Promise<{ parts: Part[]; modelUsed: string }> {
  let lastErr: Error | null = null;
  for (const m of agentModelChain()) {
    try {
      await onEvent?.({ type: 'iteration', data: { iter, pass, model: m } });
      const stream = await ai.models.generateContentStream({
        model: m,
        contents,
        config: {
          systemInstruction,
          tools,
          temperature: 0.2,
        },
      });

      const fnCalls: Part[] = [];
      let textBuf = '';
      for await (const chunk of stream) {
        const cand = chunk.candidates?.[0];
        const cParts: Part[] = cand?.content?.parts ?? [];
        for (const p of cParts) {
          if ((p as any).functionCall) {
            fnCalls.push(p);
          } else if ((p as any).text) {
            const t = (p as any).text as string;
            textBuf += t;
            await onEvent?.({ type: 'text_delta', data: { text: t } });
          }
        }
      }

      const parts: Part[] = [];
      if (textBuf) parts.push({ text: textBuf } as Part);
      parts.push(...fnCalls);
      return { parts, modelUsed: m };
    } catch (e: any) {
      lastErr = e;
      const msg = e?.message || String(e);
      await onEvent?.({ type: 'iteration', data: { iter, pass, model: m, retried: true, err: msg.slice(0, 160) } });
      if (!TRANSIENT_ERR.test(msg)) throw e;
    }
  }
  throw lastErr ?? new Error('all agent models failed');
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n... (truncated ${s.length - max} chars)`;
}

export async function runAgentTurn(
  session: Session,
  question: string,
  onEvent?: EventSink,
): Promise<Turn> {
  const ai = getClient();
  const turnIndex = session.turns.length + 1;

  const ledger = buildLedger(session, turnIndex);
  const repoBlurb = `Repo: ${session.repo.owner}/${session.repo.repo}${session.repo.branch ? ` (branch: ${session.repo.branch})` : ''}\nLocal path is sandboxed; use repo-relative paths in tools.`;
  const systemInstruction = `${AGENT_SYSTEM_PROMPT}\n\n# Current session\n${repoBlurb}\n\n# Prior-claims ledger (compressed)\n${ledger}\n\n# Current turn\nThis is turn ${turnIndex}. Answer turn ${turnIndex}'s question, citing files you actually inspect this turn.`;

  const trimmed = trimHistory(session.history, 3);
  const contents: Content[] = [
    ...trimmed,
    { role: 'user', parts: [{ text: question }] },
  ];
  const newEntries: Content[] = [{ role: 'user', parts: [{ text: question }] }];

  const toolCalls: Turn['toolCalls'] = [];
  let finalText = '';
  let rePrompted = false;
  let toolCallsBeforeFinal = 0;

  outer: for (let pass = 0; pass < 2; pass++) {
    for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
      const { parts } = await streamWithFallback(
        ai,
        contents,
        systemInstruction,
        [{ functionDeclarations: TOOL_DECLARATIONS as any }],
        onEvent,
        iter,
        pass,
      );

      const modelContent: Content = { role: 'model', parts };
      contents.push(modelContent);
      newEntries.push(modelContent);

      const fnCalls: Array<{ id?: string; name: string; args: any }> = [];
      let textPart = '';
      for (const p of parts) {
        if ((p as any).functionCall) fnCalls.push((p as any).functionCall);
        else if ((p as any).text) textPart += (p as any).text;
      }

      if (fnCalls.length === 0) {
        const candidateText = textPart.trim();
        const noToolsThisPass = toolCalls.length === toolCallsBeforeFinal;
        const hasCitations = /\([^()\s]+?\.[A-Za-z0-9]{1,8}:L?\d+/.test(candidateText);
        const userAskedToVerify = /\b(verify|check|grep|look (?:at|up|in)|find|search|confirm|inspect)\b/i.test(question);
        const looksLikeRepoClaim = /\b(this (?:repo|repository|file|function|service|codebase)|the (?:file|function|class|module|repo|repository|codebase))\b/i.test(candidateText);
        const shouldReprompt = noToolsThisPass && (hasCitations || userAskedToVerify || (looksLikeRepoClaim && candidateText.length > 200));
        if (shouldReprompt && !rePrompted) {
          rePrompted = true;
          const repromptMsg: Content = { role: 'user', parts: [{ text: NO_TOOL_REPROMPT }] };
          contents.push(repromptMsg);
          newEntries.push(repromptMsg);
          toolCallsBeforeFinal = toolCalls.length;
          await onEvent?.({ type: 'text_clear', data: { reason: 'no tool calls - retrying' } });
          continue outer;
        }
        finalText = candidateText;
        await onEvent?.({ type: 'model_text', data: { text: finalText } });
        break outer;
      }

      const responseParts: Part[] = [];
      for (const fc of fnCalls) {
        await onEvent?.({ type: 'tool_call', data: { name: fc.name, args: fc.args } });
        const result = runTool({ repoRoot: session.repo.path }, fc.name, fc.args);
        const responseStr = result.ok
          ? clip(result.content, MAX_TOOL_RESULT_CHARS)
          : `ERROR: ${result.error}`;
        await onEvent?.({ type: 'tool_result', data: { name: fc.name, ok: result.ok, bytes: responseStr.length } });
        toolCalls.push({ name: fc.name, args: fc.args, ok: result.ok, bytes: responseStr.length });
        responseParts.push({
          functionResponse: {
            id: fc.id,
            name: fc.name,
            response: { content: responseStr },
          },
        } as any);
      }
      const fnResponseContent: Content = { role: 'user', parts: responseParts };
      contents.push(fnResponseContent);
      newEntries.push(fnResponseContent);
    }
    if (!finalText) break;
  }

  if (!finalText) {
    finalText = '(agent did not produce a final answer within iteration cap - try a more specific question)';
  }

  session.history.push(...newEntries);

  const citations = extractCitations(finalText);
  const turn: Turn = {
    id: randomUUID(),
    index: turnIndex,
    question,
    answer: finalText,
    citations,
    toolCalls,
    createdAt: Date.now(),
  };
  session.turns.push(turn);
  return turn;
}
