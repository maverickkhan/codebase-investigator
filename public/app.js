const $ = sel => document.querySelector(sel);
const repoForm = $('#repo-form');
const repoInput = $('#repo-url');
const repoBtn = $('#repo-btn');
const repoStatus = $('#repo-status');
const chatForm = $('#chat-form');
const chatInput = $('#chat-input');
const chatBtn = $('#chat-btn');
const messagesEl = $('#messages');
const auditPane = $('#audit-pane');
const snippetModal = $('#snippet-modal');
const snippetTitle = $('#snippet-title');
const snippetBody = $('#snippet-body');
$('#snippet-close').onclick = () => snippetModal.classList.add('hidden');
snippetModal.addEventListener('click', e => { if (e.target === snippetModal) snippetModal.classList.add('hidden'); });

let sessionId = null;

repoForm.addEventListener('submit', async e => {
  e.preventDefault();
  const url = repoInput.value.trim();
  if (!url) return;
  repoBtn.disabled = true;
  repoStatus.textContent = '';
  repoStatus.className = 'repo-status';
  repoStatus.innerHTML = '<span class="spinner"></span>Cloning...';
  try {
    const r = await fetch('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.formErrors?.[0] || data.error || 'failed');
    sessionId = data.session_id;
    repoStatus.textContent = `Loaded ${data.repo.owner}/${data.repo.repo}${data.repo.branch ? ` @ ${data.repo.branch}` : ''}.  Session: ${sessionId.slice(0, 8)}`;
    repoStatus.className = 'repo-status good';
    chatInput.disabled = false;
    chatBtn.disabled = false;
    chatInput.focus();
    messagesEl.innerHTML = '';
    auditPane.innerHTML = '<div class="audit-empty">Audit appears here after each answer.</div>';
    const bar = document.getElementById('export-bar');
    document.getElementById('export-md').href = `/api/session/${sessionId}/export?format=md`;
    document.getElementById('export-json').href = `/api/session/${sessionId}/export?format=json`;
    bar.classList.remove('hidden');
  } catch (err) {
    repoStatus.textContent = `Error: ${err.message}`;
    repoStatus.className = 'repo-status error';
  } finally {
    repoBtn.disabled = false;
  }
});

chatInput.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    chatForm.requestSubmit();
  }
});

chatForm.addEventListener('submit', async e => {
  e.preventDefault();
  if (!sessionId) return;
  const q = chatInput.value.trim();
  if (!q) return;
  chatInput.value = '';
  chatInput.disabled = true;
  chatBtn.disabled = true;

  appendMessage('user', q);
  const pending = appendMessage('assistant', '');
  pending.body.innerHTML = `
    <div class="stream-status"><span class="spinner"></span><span class="stream-status-text">starting...</span></div>
    <div class="stream-tools"></div>
    <div class="stream-text"></div>
  `;
  const statusEl = pending.body.querySelector('.stream-status-text');
  const statusWrap = pending.body.querySelector('.stream-status');
  const toolsEl = pending.body.querySelector('.stream-tools');
  const textEl = pending.body.querySelector('.stream-text');
  let textBuf = '';
  let liveTools = []; // {name, args, ok?}

  function setStatus(msg) {
    if (statusEl) statusEl.textContent = msg;
  }
  function renderTools() {
    if (!liveTools.length) { toolsEl.innerHTML = ''; return; }
    toolsEl.innerHTML = liveTools.map(t => {
      const argsStr = JSON.stringify(t.args).slice(0, 100);
      const status = t.ok === undefined ? '<span class="spinner"></span>' : (t.ok ? '✓' : '✗');
      return `<div class="tool-row">${status} <b>${escapeHtml(t.name)}</b> <span class="tool-args">${escapeHtml(argsStr)}</span>${t.bytes !== undefined ? ` <span class="tool-bytes">${t.bytes}b</span>` : ''}</div>`;
    }).join('');
  }
  function appendText(t) {
    textBuf += t;
    textEl.textContent = textBuf;
  }
  function clearText(reason) {
    textBuf = '';
    textEl.textContent = '';
    setStatus(`retrying - ${reason}`);
  }

  try {
    const res = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ session_id: sessionId, question: q }),
    });
    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => '');
      throw new Error(`stream failed: ${res.status} ${errText.slice(0, 200)}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const chunks = buf.split('\n\n');
      buf = chunks.pop() || '';
      for (const chunk of chunks) {
        const lines = chunk.split('\n');
        let evName = 'message';
        const dataLines = [];
        for (const l of lines) {
          if (l.startsWith('event:')) evName = l.slice(6).trim();
          else if (l.startsWith('data:')) dataLines.push(l.slice(5).trim());
        }
        const dataStr = dataLines.join('\n');
        let data = {};
        try { data = dataStr ? JSON.parse(dataStr) : {}; } catch {}
        handleEvent(evName, data);
      }
    }

    function handleEvent(name, data) {
      switch (name) {
        case 'iteration':
          if (data.retried) setStatus(`retrying via ${data.model || 'fallback'}...`);
          else setStatus(`thinking with ${data.model || 'agent'}...`);
          break;
        case 'tool_call':
          liveTools.push({ name: data.name, args: data.args });
          renderTools();
          break;
        case 'tool_result':
          for (let i = liveTools.length - 1; i >= 0; i--) {
            if (liveTools[i].name === data.name && liveTools[i].ok === undefined) {
              liveTools[i].ok = data.ok;
              liveTools[i].bytes = data.bytes;
              break;
            }
          }
          renderTools();
          break;
        case 'text_delta':
          if (statusWrap) statusWrap.style.display = 'none';
          appendText(data.text);
          messagesEl.scrollTop = messagesEl.scrollHeight;
          break;
        case 'text_clear':
          clearText(data.reason || 'redo');
          if (statusWrap) statusWrap.style.display = '';
          break;
        case 'model_text':
          // Final text from a non-streamed response (rare). Use as-is.
          if (statusWrap) statusWrap.style.display = 'none';
          textEl.textContent = data.text;
          break;
        case 'auditing':
          setStatus('running audit...');
          if (statusWrap) statusWrap.style.display = '';
          auditPane.innerHTML = '<div class="audit-empty"><span class="spinner"></span>auditing...</div>';
          break;
        case 'final': {
          if (statusWrap) statusWrap.parentNode && statusWrap.remove();
          textEl.remove();
          toolsEl.remove();
          const finalDiv = document.createElement('div');
          finalDiv.innerHTML = renderAnswer(data.turn);
          pending.body.appendChild(finalDiv);
          pending.body.appendChild(renderToolTrace(data.turn.tool_calls));
          bindCitations(pending.body, data.turn);
          renderAudit(data.turn);
          break;
        }
        case 'error':
          setStatus(`error: ${data.error || 'unknown'}`);
          textEl.textContent = textBuf || `Error: ${data.error || 'stream error'}`;
          break;
      }
    }
  } catch (err) {
    pending.body.textContent = `Error: ${err.message}`;
  } finally {
    chatInput.disabled = false;
    chatBtn.disabled = false;
    chatInput.focus();
  }
});

function appendMessage(role, html) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;
  const r = document.createElement('div'); r.className = 'role'; r.textContent = role;
  const body = document.createElement('div'); body.className = 'body'; body.innerHTML = html;
  wrap.append(r, body);
  messagesEl.append(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return { wrap, body };
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderAnswer(turn) {
  let html = escapeHtml(turn.answer);
  // Linkify citation paren groups, including multi-cite forms:
  //   (a.ts:10) | (a.ts:10-20) | (a.ts:10, b.ts:20) | (a.ts:10, 20-30)
  html = html.replace(/\(([^()]+)\)/g, (full, inner) => {
    if (inner.includes('://')) return full; // skip URLs
    const parts = inner.split(',').map(s => s.trim()).filter(Boolean);
    let currentPath = null;
    const rendered = [];
    let anyCite = false;
    for (const part of parts) {
      let m = part.match(/^([^\s,]+\.[A-Za-z0-9]{1,8}):L?(\d+)(?:[-–]L?(\d+))?$/);
      if (m) {
        currentPath = m[1];
        const start = +m[2], end = m[3] ? +m[3] : start;
        const bad = isCitationBad(turn, currentPath, start, end);
        rendered.push(`<span class="cite${bad ? ' bad' : ''}" data-path="${escapeHtml(currentPath)}" data-start="${start}" data-end="${end}">${escapeHtml(currentPath)}:${start}${end !== start ? '-' + end : ''}</span>`);
        anyCite = true;
        continue;
      }
      m = part.match(/^L?(\d+)(?:[-–]L?(\d+))?$/);
      if (m && currentPath) {
        const start = +m[1], end = m[2] ? +m[2] : start;
        const bad = isCitationBad(turn, currentPath, start, end);
        rendered.push(`<span class="cite${bad ? ' bad' : ''}" data-path="${escapeHtml(currentPath)}" data-start="${start}" data-end="${end}">${escapeHtml(currentPath)}:${start}${end !== start ? '-' + end : ''}</span>`);
        anyCite = true;
        continue;
      }
      rendered.push(escapeHtml(part));
    }
    if (!anyCite) return full;
    return `(${rendered.join(', ')})`;
  });
  html = html.replace(/`([^`]+)`/g, (_, c) => `<code>${escapeHtml(c)}</code>`);
  return html;
}

function isCitationBad(turn, path, start, end) {
  if (!turn.audit) return false;
  for (const inv of turn.audit.programmatic.citations_invalid) {
    if (inv.citation.path === path && inv.citation.start === start && inv.citation.end === end) return true;
  }
  for (const m of turn.audit.programmatic.quote_mismatches) {
    if (m.citation.path === path && m.citation.start === start && m.citation.end === end) return true;
  }
  return false;
}

function bindCitations(root, turn) {
  for (const el of root.querySelectorAll('.cite')) {
    el.addEventListener('click', () => openSnippet(el.dataset.path, +el.dataset.start, +el.dataset.end));
  }
}

async function openSnippet(path, start, end) {
  snippetTitle.textContent = `${path}  L${start}-${end}`;
  snippetBody.textContent = 'loading...';
  snippetModal.classList.remove('hidden');
  try {
    const ctxStart = Math.max(1, start - 3);
    const ctxEnd = end + 3;
    const r = await fetch(`/api/file?session_id=${sessionId}&path=${encodeURIComponent(path)}&start=${ctxStart}&end=${ctxEnd}`);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'failed');
    const lines = data.lines.map((l, i) => {
      const ln = data.start + i;
      const inRange = ln >= start && ln <= end;
      const marker = inRange ? '> ' : '  ';
      return `${marker}${String(ln).padStart(5, ' ')}  ${l}`;
    }).join('\n');
    snippetBody.textContent = lines;
  } catch (err) {
    snippetBody.textContent = `Error: ${err.message}`;
  }
}

function renderToolTrace(calls) {
  const wrap = document.createElement('div');
  if (!calls?.length) return wrap;
  const det = document.createElement('details');
  const sum = document.createElement('summary');
  sum.textContent = `tool trace (${calls.length} calls)`;
  det.append(sum);
  const tt = document.createElement('div');
  tt.className = 'tool-trace';
  tt.innerHTML = calls.map(c => {
    const ok = c.ok ? '✓' : '✗';
    const args = JSON.stringify(c.args).slice(0, 200);
    return `${ok} <b>${c.name}</b> ${escapeHtml(args)}  <span style="opacity:0.6">(${c.bytes}b)</span>`;
  }).join('<br/>');
  det.append(tt);
  wrap.append(det);
  return wrap;
}

function renderAudit(turn) {
  const a = turn.audit;
  if (!a) { auditPane.innerHTML = '<div class="audit-empty">No audit available.</div>'; return; }
  const score = a.trust_score;
  const tier = score >= 75 ? 'good' : score >= 50 ? 'warn' : 'bad';
  const findings = a.judge.findings.map(f => `
    <div class="finding ${escapeHtml(f.severity || 'info')}">
      <span class="cat">${escapeHtml(f.category || '')}</span>
      ${escapeHtml(f.message || '')}
      ${f.citation ? `<div class="cite" data-path="${escapeHtml(f.citation.path)}" data-start="${f.citation.start}" data-end="${f.citation.end}" style="margin-top:4px">${escapeHtml(f.citation.path)}:${f.citation.start}-${f.citation.end}</div>` : ''}
    </div>`).join('') || '<div class="finding info">No findings - judge agrees with the answer.</div>';

  auditPane.innerHTML = `
    <div class="audit-card">
      <h3>Audit - turn ${turn.index}</h3>
      <div class="audit-score ${tier}">
        <span class="score">${score}</span>
        <span class="label">trust / 100</span>
      </div>
      <div class="audit-summary">${escapeHtml(a.judge.summary)}</div>
      <div class="kpis">
        <span><b>${a.programmatic.citations_valid}</b>/${a.programmatic.citations_total} citations valid</span>
        <span><b>${a.programmatic.citations_invalid.length}</b> hallucinated</span>
        <span><b>${a.programmatic.quote_mismatches.length}</b> quote mismatches</span>
        <span>judge: <b>${escapeHtml(a.judge.model)}</b></span>
        <span>${a.generated_ms}ms</span>
      </div>
      ${a.judge.contradicts_prior_turn ? `<div class="finding error" style="margin-top:10px"><span class="cat">consistency</span>${escapeHtml(a.judge.contradiction_note || 'contradicts a prior turn')}</div>` : ''}
      <div class="audit-section-title">Findings</div>
      ${findings}
    </div>
  `;
  for (const el of auditPane.querySelectorAll('.cite')) {
    el.addEventListener('click', () => openSnippet(el.dataset.path, +el.dataset.start, +el.dataset.end));
  }
}
