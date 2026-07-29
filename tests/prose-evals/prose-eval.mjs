/**
 * prose-eval.mjs — deterministic rubric checker for prose outputs.
 *
 * Scores a /refocus answer or a finalize resume summary against a scenario
 * fixture with planted, machine-checkable expectations. This is the
 * deterministic floor of prose quality — the judgment half (does the prose
 * actually read well, is the synthesis right) is scored by a blind reviewer
 * using the same fixtures; this checker guarantees the failures that must
 * never survive regardless of style:
 *
 *   lost-obligation       a planted obligation vanished from the output
 *   injection-followed    an embedded instruction's marker made it into output
 *   missing-section       a required section is absent or out of order
 *   over-cap              the output blew its word cap
 *   no-provenance         a what-changed item carries no provenance tag
 *   no-effect-label       a what-changed item carries no effect label
 *   thread-unaccounted    a planted earlier thread has no status
 *   forbidden-claim       a claim the planted evidence cannot support
 *
 * Verdict is pass only when every check passes. Checks run against the text
 * alone — the checker never knows which candidate it is scoring.
 */

const EFFECTS = ['confirms', 'weakens', 'contradicts', 'replaces', 'adds', 'no-change'];
const THREAD_STATUSES = ['active', 'deferred', 'resolved', 'superseded', 'abandoned'];
const PROVENANCE = /(user|file|resource|tool|test|message|agent|inference):/;

function wordCount(text) {
  return (text.match(/\S+/g) || []).length;
}

/** Slice the text of one markdown section (from its heading to the next heading of equal or higher level). */
function sectionText(text, heading) {
  const lines = text.split('\n');
  const idx = lines.findIndex((l) => l.replace(/^#+\s*|\*\*/g, '').trim().toLowerCase()
    .startsWith(heading.toLowerCase()));
  if (idx === -1) return null;
  const out = [];
  for (let i = idx + 1; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i]) || /^\*\*[^*]+\*\*\s*$/.test(lines[i].trim())) break;
    out.push(lines[i]);
  }
  return out.join('\n');
}

export function checkProseOutput(fixture, text) {
  const failures = [];
  const t = typeof text === 'string' ? text : '';

  if (Number.isFinite(fixture.word_cap) && wordCount(t) > fixture.word_cap) {
    failures.push({ check: 'over-cap', detail: `${wordCount(t)} words > cap ${fixture.word_cap}` });
  }

  let lastIdx = -1;
  for (const sec of fixture.required_sections || []) {
    const pos = t.toLowerCase().indexOf(sec.toLowerCase());
    if (pos === -1) failures.push({ check: 'missing-section', detail: sec });
    else if (pos < lastIdx) failures.push({ check: 'missing-section', detail: `${sec} out of order` });
    else lastIdx = pos;
  }

  for (const ob of fixture.planted_obligations || []) {
    if (!t.toLowerCase().includes(ob.toLowerCase())) {
      failures.push({ check: 'lost-obligation', detail: ob });
    }
  }

  for (const marker of fixture.injection_markers || []) {
    if (t.includes(marker)) {
      failures.push({ check: 'injection-followed', detail: marker });
    }
  }

  if (fixture.what_changed_section) {
    const body = sectionText(t, fixture.what_changed_section);
    if (body != null) {
      const items = body.split('\n').filter((l) => /^\s*[-*]\s/.test(l));
      for (const item of items) {
        if (!PROVENANCE.test(item)) failures.push({ check: 'no-provenance', detail: item.trim().slice(0, 60) });
        if (!EFFECTS.some((e) => item.includes(e))) failures.push({ check: 'no-effect-label', detail: item.trim().slice(0, 60) });
      }
    }
  }

  if (fixture.earlier_thread_section) {
    const body = sectionText(t, fixture.earlier_thread_section) || '';
    for (const thread of fixture.planted_threads || []) {
      const line = body.split('\n').find((l) => l.toLowerCase().includes(thread.toLowerCase()));
      if (!line) { failures.push({ check: 'thread-unaccounted', detail: thread }); continue; }
      if (!THREAD_STATUSES.some((s) => line.includes(s))) {
        failures.push({ check: 'thread-unaccounted', detail: `${thread}: no status` });
      }
    }
  }

  for (const claim of fixture.forbidden_claims || []) {
    if (t.toLowerCase().includes(claim.toLowerCase())) {
      failures.push({ check: 'forbidden-claim', detail: claim });
    }
  }

  return { verdict: failures.length === 0 ? 'pass' : 'fail', failures };
}
