# Codebase Investigator

Paste a public GitHub URL, ask plain-English questions, get answers grounded in specific files and line ranges. Each non-trivial answer is shipped with an independent audit so a reviewer can see whether to trust it.

Stack: Node + TypeScript, Hono, Google Gemini (free tier).

## Audit, three independent layers

The brief rules out self-scoring in the same call as the answer. Independence here comes from three places at once:

1. Programmatic verifier (deterministic). After each turn, code re-reads every cited file and confirms the line range exists. If the agent quoted text, the quote must substring-match. Catches hallucinated paths and out-of-range ranges with no LLM involved.
2. Loop guard (structural). If the agent answers without calling any tools but the answer cites files, references the repo, or the user explicitly asked it to verify/grep/check, a corrective message is injected and the loop reruns once. Catches answers cribbed from pretraining memory before they ship.
3. Judge model (semantic). A different Gemini model runs in an isolated context: it sees only the question, the answer, the cited file slices with +/-3 lines of context, and a compressed summary of prior turns. It does not see the agent's tool trace. Returns structured findings: unsupported claims, overconfidence, reasoning gaps, risky suggestions, contradictions with prior turns.

A trust score (0-100) blends programmatic and judge into one number. The UI breaks it down so reviewers can see what each layer found.

A fourth heuristic catches a specific failure mode: any citation spanning 50+ lines on a file the agent never opened with `read_file` (and that wasn't covered by a whole-repo grep) is flagged as "likely a guessed whole-file range from training data". This was added after seeing the agent cite `Dockerfile:1-477` and `nginx.conf:1-577` from priors instead of reading the files.

## Multi-turn coherence

Realistic investigation is 8-15 turns of pushback. To keep the agent sharp:

- Claim ledger. Every prior turn's question, answer, citations, and audit verdict are stored separately from raw chat and compressed into the agent's system prompt each turn. The agent always sees what it has previously asserted.
- History trim with safe boundaries. Raw conversation history is trimmed to the last 3 user-question turns to bound token usage. The cut always lands on a user-question boundary so Gemini's function-call/response invariants are preserved (this was a real bug; Gemini rejects history that begins mid-tool-sequence).
- Pushback handling. When the user references an earlier turn ("you said X"), the ledger entry is in the agent's prompt; it can acknowledge, verify, and explicitly own a contradiction if it changes its mind.
- Judge contradiction detection. Judge gets a summary of recent turns and flags `consistency` findings when the current answer silently contradicts an earlier one.

## Run

Prereqs: Node 20+, `git`, `ripgrep` (`brew install ripgrep` on macOS), a Google AI Studio API key (free tier, https://aistudio.google.com/apikey).

```
npm install
cp .env.example .env
# paste key into GEMINI_API_KEY
npm run dev
```

Open http://localhost:3000.

1. Paste a GitHub URL (e.g. `https://github.com/expressjs/express`). Clones to `./repos_cache`, reused next time.
2. Ask questions. Citations render as clickable chips; click to see the file slice in a modal. Right panel shows the audit (trust score, programmatic stats, judge summary, findings).
3. Use **Export .md** / **Export .json** in the header to download the entire session.

### Environment

```
GEMINI_API_KEY=...           # required
PORT=3000                    # default
REPO_CACHE_DIR=./repos_cache # local clone cache
AGENT_MODEL=gemini-2.5-pro   # main investigator
JUDGE_MODEL=gemini-2.5-flash # independent auditor; must differ from AGENT_MODEL
```

If Pro free quota is exhausted, set `AGENT_MODEL=gemini-2.5-flash` and `JUDGE_MODEL=gemini-2.0-flash-exp`. Independence is preserved as long as agent and judge models differ. Agent and judge both retry through a fallback chain on 503/UNAVAILABLE/429; if all fail the audit returns a "judge unavailable" warning and trust is capped at 60.

### Verify deterministic parts without burning Gemini quota

```
npm test                                                # 27 unit tests
npx tsx --env-file=.env src/scripts/tools-smoke.ts      # exercise every tool against a real repo
```

### Drive an 8-turn investigation end-to-end

```
npx tsx --env-file=.env src/scripts/extended-demo.ts    # uses expressjs/express by default
```

The script asks one question of each type the brief lists (retrieval, walkthrough, opinion, why, dead-code, pushback) plus a contradiction stress-test and a final scoped opinion. Prints a one-line summary per turn and the URL to download the full markdown export.

## Flow

```
[paste URL]              clone + cache
[ask question]           agent loop (Gemini Pro)
                            list_dir / grep / find_symbol  (orient)
                            read_file <range>              (confirm)
                            answer with (path:Lstart-Lend) citations
[loop guard]             if zero tool calls + claim, inject correction, rerun once
[programmatic verifier]  re-read cited lines, check quotes, check tool-touched
[judge model (Flash)]    isolated context, structured findings
[filter]                 drop "evidence missing" complaints that contradict programmatic ground truth
[trust score]            visible in UI + audit panel + export
```

## Architecture

```
src/
  server.ts                 Hono server, REST + SSE endpoints
  agent/
    loop.ts                 Gemini function-calling loop, streaming, loop guard, fallback chain
    prompts.ts              agent + judge system prompts
    citations.ts            extract (path:Lstart-Lend) citations, multi-cite parens
  audit/
    verifier.ts             programmatic citation/quote check, +/-3 line context evidence
    judge.ts                judge model call, false-positive filter, trust scoring
  tools/
    index.ts                list_dir / read_file / grep / find_symbol / git_log
    declarations.ts         function declarations exposed to Gemini
  repo/
    manager.ts              GitHub URL parsing, clone + cache, safeJoin sandbox
  session/
    store.ts                in-memory sessions, claim ledger, history trim
    export.ts               .md / .json exporters
  scripts/
    tools-smoke.ts          tools-only smoke test (no LLM)
    extended-demo.ts        8-turn multi-question demo driver
public/
  index.html  style.css  app.js
```

### API

- `POST /api/session  { url }` returns `{ session_id, repo }`
- `POST /api/chat     { session_id, question }` returns `{ turn: { answer, citations, tool_calls, audit, ... } }` (blocking; used by tests/scripts)
- `POST /api/chat/stream { session_id, question }` SSE stream. Events: `iteration`, `tool_call`, `tool_result`, `text_delta`, `text_clear` (loop-guard retry), `auditing`, `final`, `error`. Used by the UI so users see text + tool calls live instead of waiting in silence.
- `GET  /api/session/:id` full snapshot
- `GET  /api/session/:id/export?format=md|json` downloadable transcript
- `GET  /api/file?session_id&path&start&end` file slice (citation modal)
- `GET  /api/sessions` list of in-memory sessions
- `DELETE /api/session/:id` drop session

### Tools the agent gets

| Tool | Purpose |
|------|---------|
| `list_dir(path?, depth?)` | Tree view, depth 1-4. Skips `.git`, `node_modules`, build dirs. |
| `read_file(path, start?, end?)` | Line-numbered slice, capped at 400 lines. Refuses binaries and >2MB files. |
| `grep(pattern, glob?)` | Ripgrep wrapper. Returns `path:line: text`. Capped at 80 matches. |
| `find_symbol(name, kind?)` | Definitions or call-sites. Regex over common keywords. |
| `git_log(path?, limit?)` | Recent commits, optionally path-filtered. |

All paths run through a `safeJoin` primitive that refuses anything resolving outside the repo root.

## Concrete demo run

`npx tsx src/scripts/extended-demo.ts` against `expressjs/express`:

| Turn | Type             | Trust | Cites valid | Tools | Findings | What the audit caught |
|------|------------------|-------|-------------|-------|----------|------------------------|
| 1 | retrieval           | 100   | 9/9         | 7     | 0        | clean |
| 2 | walkthrough         | 10    | 10/10       | 0     | 1        | agent answered with citations but zero tool calls; flagged as memory-based, trust hard-capped |
| 3 | opinion             | 100   | 4/4         | 3     | 0        | clean |
| 4 | why                 | 100   | 2/2         | 2     | 0        | clean |
| 5 | dead-code           | 88    | 2/2         | 6     | 2        | judge flagged two unsupported claims about specific npm packages used in examples |
| 6 | pushback            | 70    | 5/5         | 7     | 2        | judge caught two real citation/claim mismatches: agent said `lazyrouter` was at `lib/application.js:122-132` but those lines show `this.locals` setup, not `lazyrouter` |
| 7 | contradiction       | 100   | 5/5         | 1     | 0        | reconciled prior turns coherently using ledger |
| 8 | final scoped opinion| 100   | 3/3         | 3     | 0        | clean |

Turn 6 is the interesting one. Programmatic verifier passed all 5 citations (line ranges exist, file is correct), so a naive audit would say "fine". Judge, looking only at the cited lines, caught that the agent's claim about `lazyrouter` doesn't match what those lines actually contain. That's the failure mode the brief asked us to catch: "reasoning with a hole in it".

## Scope cuts (intentional)

- No embeddings/RAG. grep + read_file is enough for citation-grade answers and keeps citations precise. An embedding-based retriever would blur the cite-back-to-line discipline.
- No tree-sitter. `find_symbol` falls back to regex over common definition keywords. Catches the common cases; users can drop to `grep` for exotic syntax.
- No persistent storage. Sessions are in-memory; restart loses them. Markdown export covers the "save the investigation" use case.
- Single repo per session. Keeps the path sandbox simple.

## Safety

- All tool paths run through `safeJoin`, which refuses any path resolving outside the repo root after normalization. The `/api/file` endpoint uses the same primitive.
- `read_file` rejects binaries and files larger than 2 MB.
- Repos > 200 MB are rejected after clone (cache cleaned up).
- The agent never gets a generic shell tool; only the five typed tools above.

## Known limits

- Judge is occasionally cautious to the point of false-positive on short citations. A filter drops "X was not provided in evidence" complaints when the cited key is in the agent's text and structurally valid. Remaining noise tends to be conservative; it errs toward flagging, not silently passing.
- Free-tier rate limits on Gemini Pro can bite during long sessions. Both agent and judge calls retry through a fallback chain (`gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.0-flash-exp`).
- `find_symbol` is regex-based and misses computed-name JS methods, dynamically-built classes, and similar exotic shapes. Drop to `grep` with a tailored pattern for those.
- Loop guard is a heuristic (regex over user prompt + answer text). Indirect prompts asking the agent to investigate may still slip through; the per-citation tool-touch check and the "no tool calls + citations" hard cap catch the residue.

## Tests

```
npm test
```

27 unit tests covering:

- Citation extractor: single, range, L-prefixed, multi-path, multi-range same path, mixed, dedupe, invalid ranges, URL parens skipped, quoted-snippet attachment.
- Verifier: valid lines, missing files, out-of-range lines, quote match/mismatch, path traversal rejection, +/-3 context evidence.
- Session ledger: empty session, prior turns listed with citations, current/future excluded, long-answer truncation.
- History trim: keeps last N user turns, function-response entries don't count, cut lands on safe boundary.

## Files to look at first

- `src/agent/prompts.ts` -- what the agent and judge are told.
- `src/audit/judge.ts` -- how the audit is independent and how false positives are filtered.
- `src/audit/verifier.ts` -- the deterministic citation check.
- `src/agent/loop.ts` -- function-calling loop with streaming and loop guard.
- `src/session/store.ts` -- claim ledger and history trim.
- `src/scripts/extended-demo.ts` -- the canned 8-turn driver.
- `samples/expressjs-8-turn-demo.md` -- full export from the run summarized above. Read end-to-end to see exactly what the agent + audit pipeline produce on a realistic 8-turn investigation.
