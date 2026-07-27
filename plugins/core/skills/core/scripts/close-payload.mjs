/**
 * close-payload.mjs — the deterministic half of session close.
 *
 * The automatic close makes ZERO model calls. It builds a structured record
 * from the already-normalized transcript events `read-transcript.mjs` emits,
 * and renders a fixed-shape summary from it. Nothing here infers, judges, or
 * generates prose.
 *
 * Why no model: a generated prose capsule had no proven reader. `startup.md`
 * instructs the agent to SKIP `_summaries/` at bootstrap precisely because
 * narrative re-anchors it on framing rather than fact. Paying a model to write
 * something nothing reads is cost without a consumer, so the automatic path
 * emits only what can be counted.
 *
 * What that leaves is the question the artifact actually has to answer — "if
 * this session vanished, what happened?" — answered with identity, a time
 * range, counts, tool names, and files touched. Judgment about what any of it
 * MEANT belongs to the manual close, which has the active context to say so
 * honestly rather than reconstructing it from a transcript.
 *
 * Every retained excerpt is byte-bounded: a close record's size must not track
 * transcript size, or a long session reintroduces the cost this removes.
 */

/** Tool names that mutate state. A session that ran one did real work. */
const MUTATING_TOOLS = new Set([
  'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'str_replace_editor', 'apply_patch',
]);

/** Hard ceilings. The record is a receipt, not an archive. */
const MAX_TOOLS_LISTED = 24;
const MAX_FILES_LISTED = 24;
const MAX_PATH_BYTES = 200;
const MAX_HEADLINE_BYTES = 300;

/**
 * Clip a string to at most `maxBytes` UTF-8 bytes without splitting a character.
 *
 * A code-unit slice is wrong here: one emoji is a single code point but four
 * UTF-8 bytes, so slicing by length can both overshoot a byte budget and sever
 * a character into replacement junk.
 */
export function clipUtf8(str, maxBytes) {
  if (typeof str !== 'string' || str.length === 0) return '';
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return '';

  const buf = Buffer.from(str, 'utf8');
  if (buf.length <= maxBytes) return str;

  // Walk back to a lead byte so the slice ends on a character boundary.
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

/** Pull a file path out of a tool call's stringified input, if it carries one. */
function extractPath(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  try {
    const parsed = JSON.parse(text);
    const p = parsed?.file_path || parsed?.path || parsed?.notebook_path;
    return typeof p === 'string' && p ? clipUtf8(p, MAX_PATH_BYTES) : null;
  } catch {
    return null;
  }
}

/**
 * Classify a session by what it actually did. Counting only — no judgment about
 * whether the work was good, finished, or worth preserving.
 */
export function classifySession(events = []) {
  const list = Array.isArray(events) ? events : [];
  let toolCount = 0;
  let mutatingToolCount = 0;
  let userTurns = 0;

  for (const e of list) {
    if (e?.kind === 'tool') {
      toolCount++;
      if (MUTATING_TOOLS.has(e.name)) mutatingToolCount++;
    } else if (e?.kind === 'text' && e.role === 'user') {
      userTurns++;
    }
  }

  // Substantive = something changed, or the exchange was long enough that
  // losing it would cost the user real context.
  const substantive = mutatingToolCount > 0 || toolCount >= 5 || userTurns >= 4;

  return { substantive, toolCount, mutatingToolCount, userTurns };
}

/**
 * Build the deterministic close record. Pure: same input, byte-identical output,
 * no clock read, no filesystem access, no model call.
 */
export function buildCloseRecord({
  sessionId,
  harness,
  startedAt = null,
  endedAt = null,
  events = [],
  coverage = 'full',
  gitHead = null,
} = {}) {
  const list = Array.isArray(events) ? events : [];
  const cls = classifySession(list);

  const tools = [];
  const files = [];
  for (const e of list) {
    if (e?.kind !== 'tool') continue;
    if (typeof e.name === 'string' && e.name && !tools.includes(e.name)) tools.push(e.name);
    const p = extractPath(e.text);
    if (p && !files.includes(p)) files.push(p);
  }

  // The first user turn is the closest thing to an objective that can be read
  // off a transcript without inferring one. Bounded, and quoted as-is.
  const firstUser = list.find((e) => e?.kind === 'text' && e.role === 'user');
  const opening = firstUser ? clipUtf8(firstUser.text, MAX_HEADLINE_BYTES) : '';

  // Partial coverage can never certify a closed status — the record says what it
  // observed, and observing part of a session is not evidence the whole closed.
  const status = coverage === 'full' ? 'recorded' : 'partial';

  return {
    schema: 'core.close-record/1',
    session_id: typeof sessionId === 'string' ? sessionId : null,
    harness: typeof harness === 'string' ? harness : null,
    started_at: startedAt,
    ended_at: endedAt,
    coverage,
    status,
    substantive: cls.substantive,
    model_calls: 0,
    counts: {
      events: list.length,
      tools: cls.toolCount,
      mutating_tools: cls.mutatingToolCount,
      user_turns: cls.userTurns,
    },
    tools_used: tools.slice(0, MAX_TOOLS_LISTED),
    files_touched: files.slice(0, MAX_FILES_LISTED),
    opening_request: opening,
    git_head: typeof gitHead === 'string' ? gitHead : null,
  };
}

/**
 * Render the record as a fixed-shape Markdown artifact. Deterministic and
 * hedge-free by construction: every line is a fact from the record or a
 * literal, so there is nothing for a reader to mistake for interpretation.
 */
export function renderCloseSummary(record) {
  if (!record || typeof record !== 'object') return '';

  const lines = [];
  lines.push(`# Session close record — ${record.session_id ?? 'unknown session'}`);
  lines.push('');
  lines.push(`- Harness: ${record.harness ?? 'unknown'}`);
  lines.push(`- Started: ${record.started_at ?? 'unknown'}`);
  lines.push(`- Ended: ${record.ended_at ?? 'unknown'}`);
  lines.push(`- Coverage: ${record.coverage}${record.coverage === 'partial' ? ' (partial — this record observed only part of the session)' : ''}`);
  lines.push(`- Substantive: ${record.substantive ? 'yes' : 'no'}`);
  lines.push(`- Model calls made by this close: ${record.model_calls}`);
  lines.push('');

  if (record.opening_request) {
    lines.push('## Opening request (verbatim, clipped)');
    lines.push('');
    lines.push(`> ${record.opening_request.replace(/\n+/g, ' ')}`);
    lines.push('');
  }

  lines.push('## Counts');
  lines.push('');
  lines.push(`- Events: ${record.counts.events}`);
  lines.push(`- Tool calls: ${record.counts.tools} (${record.counts.mutating_tools} mutating)`);
  lines.push(`- User turns: ${record.counts.user_turns}`);
  lines.push('');

  if (record.tools_used.length) {
    lines.push('## Tools used');
    lines.push('');
    for (const t of record.tools_used) lines.push(`- ${t}`);
    lines.push('');
  }

  if (record.files_touched.length) {
    lines.push('## Files touched');
    lines.push('');
    for (const f of record.files_touched) lines.push(`- ${f}`);
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('This record is generated deterministically from transcript events. It reports what');
  lines.push('was counted, not what it meant. Interpretation belongs to a manual close.');

  return lines.join('\n');
}
