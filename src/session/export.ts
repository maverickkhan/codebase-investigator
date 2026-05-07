import type { Session } from './store.js';

export function exportSessionJson(s: Session): unknown {
  return {
    session_id: s.id,
    created_at: s.createdAt,
    repo: {
      url: s.repo.url,
      owner: s.repo.owner,
      repo: s.repo.repo,
      branch: s.repo.branch ?? null,
    },
    turns: s.turns.map(t => ({
      index: t.index,
      created_at: t.createdAt,
      question: t.question,
      answer: t.answer,
      citations: t.citations,
      tool_calls: t.toolCalls,
      audit: t.audit,
    })),
  };
}

export function exportSessionMarkdown(s: Session): string {
  const lines: string[] = [];
  lines.push(`# Codebase Investigator session`);
  lines.push('');
  lines.push(`- Repo: \`${s.repo.owner}/${s.repo.repo}\`${s.repo.branch ? ` (branch: ${s.repo.branch})` : ''}`);
  lines.push(`- URL: ${s.repo.url}`);
  lines.push(`- Session ID: \`${s.id}\``);
  lines.push(`- Started: ${new Date(s.createdAt).toISOString()}`);
  lines.push(`- Turns: ${s.turns.length}`);
  lines.push('');

  if (s.turns.length === 0) {
    lines.push('_(no turns yet)_');
    return lines.join('\n');
  }

  // Trust trend table
  lines.push('## Audit summary');
  lines.push('');
  lines.push('| Turn | Trust | Cites valid | Tool calls | Findings | Judge ms |');
  lines.push('|------|-------|-------------|------------|----------|----------|');
  for (const t of s.turns) {
    const a = t.audit;
    const trust = a ? a.trust_score : '-';
    const valid = a ? `${a.programmatic.citations_valid}/${a.programmatic.citations_total}` : '-';
    const tools = t.toolCalls.length;
    const findings = a ? a.judge.findings.length : '-';
    const ms = a ? a.generated_ms : '-';
    lines.push(`| ${t.index} | ${trust} | ${valid} | ${tools} | ${findings} | ${ms} |`);
  }
  lines.push('');

  for (const t of s.turns) {
    lines.push(`---`);
    lines.push(`## Turn ${t.index}`);
    lines.push(`_Asked at ${new Date(t.createdAt).toISOString()}_`);
    lines.push('');
    lines.push(`### Question`);
    lines.push('');
    lines.push(`> ${t.question.replace(/\n/g, '\n> ')}`);
    lines.push('');
    lines.push(`### Answer`);
    lines.push('');
    lines.push(t.answer);
    lines.push('');

    if (t.citations.length) {
      lines.push(`### Citations (${t.citations.length})`);
      lines.push('');
      for (const c of t.citations) {
        lines.push(`- \`${c.path}:${c.start}${c.end !== c.start ? '-' + c.end : ''}\`${c.quote ? ` - quote: "${c.quote}"` : ''}`);
      }
      lines.push('');
    }

    if (t.toolCalls.length) {
      lines.push(`### Tool calls (${t.toolCalls.length})`);
      lines.push('');
      lines.push('| # | Tool | OK | Bytes | Args |');
      lines.push('|---|------|----|-------|------|');
      t.toolCalls.forEach((tc, i) => {
        const args = JSON.stringify(tc.args).replace(/\|/g, '\\|').slice(0, 120);
        lines.push(`| ${i + 1} | \`${tc.name}\` | ${tc.ok ? '✓' : '✗'} | ${tc.bytes} | \`${args}\` |`);
      });
      lines.push('');
    }

    if (t.audit) {
      const a = t.audit;
      lines.push(`### Audit`);
      lines.push('');
      lines.push(`- **Trust score:** ${a.trust_score}/100`);
      lines.push(`- **Citations valid (programmatic):** ${a.programmatic.citations_valid} / ${a.programmatic.citations_total}`);
      lines.push(`- **Hallucinated citations:** ${a.programmatic.citations_invalid.length}`);
      lines.push(`- **Quote mismatches:** ${a.programmatic.quote_mismatches.length}`);
      lines.push(`- **Judge model:** \`${a.judge.model}\``);
      lines.push(`- **Audit duration:** ${a.generated_ms}ms`);
      lines.push('');
      lines.push(`**Judge summary:** ${a.judge.summary}`);
      lines.push('');
      if (a.programmatic.citations_invalid.length) {
        lines.push(`**Invalid citations:**`);
        for (const inv of a.programmatic.citations_invalid) {
          lines.push(`- \`${inv.citation.path}:${inv.citation.start}-${inv.citation.end}\` - ${inv.reason}`);
        }
        lines.push('');
      }
      if (a.programmatic.quote_mismatches.length) {
        lines.push(`**Quote mismatches:**`);
        for (const mm of a.programmatic.quote_mismatches) {
          lines.push(`- \`${mm.citation.path}:${mm.citation.start}-${mm.citation.end}\` - ${mm.reason}`);
        }
        lines.push('');
      }
      if (a.judge.findings.length) {
        lines.push(`**Findings (${a.judge.findings.length}):**`);
        for (const f of a.judge.findings) {
          const cite = f.citation ? ` - \`${f.citation.path}:${f.citation.start}-${f.citation.end}\`` : '';
          lines.push(`- **${f.severity.toUpperCase()}** [${f.category}]${cite}: ${f.message}`);
        }
        lines.push('');
      } else {
        lines.push(`_No judge findings._`);
        lines.push('');
      }
      if (a.judge.contradicts_prior_turn) {
        lines.push(`**Contradicts prior turn:** ${a.judge.contradiction_note || '(no note)'}`);
        lines.push('');
      }
    }
  }
  return lines.join('\n');
}
