/**
 * frontmatter-flat.mjs — the FLAT frontmatter parser shared by the hygiene + index scripts.
 *
 * Distinct from priority.mjs's canonical parseFrontmatter ON PURPOSE. The canonical one
 * coerces values (numbers, booleans, flow-style arrays) and parses nested lists/dicts —
 * exactly what the retrieval/validation layer needs. This one is deliberately flat and
 * string-only: it reads top-level `key: value` pairs, strips surrounding quotes, drops empty
 * values, skips indented/comment lines, and tolerates CRLF. The decision/risk index
 * generators, compact-project, and the two demoters need that flat string view and would
 * MISBEHAVE under value coercion (a status or date silently becoming a number/boolean).
 *
 * This is the single shared flat parser. Returns [fm, body]; callers that only
 * need the map use `const [fm] = parseFlatFrontmatter(text)`.
 *
 * WHAT THIS PARSER DROPS — read before substituting it for priority.mjs's
 * parseFrontmatter:
 *   - ALL indented lines: `edges:` blocks, multi-line `topics:`/`sources:`
 *     lists, nested maps. A caller that needs edge or list data MUST use
 *     parseFrontmatter from priority.mjs — substituting this parser loses
 *     that data silently (no error, no warning).
 *   - empty-valued keys (`type: ` yields no key at all).
 *   - type coercion: every value stays a string ('5', 'true').
 * The conformance test in tests/scripts/frontmatter-flat.test.mjs pins the
 * two parsers to agreement on top-level scalars.
 *
 * The script ships with the plugin by design. The plugin ships .mjs only, zero dependencies.
 */

export function parseFlatFrontmatter(text) {
  const t = String(text == null ? '' : text).replace(/\r\n?/g, '\n'); // CRLF tolerance (review M1)
  if (!t.startsWith('---\n')) return [{}, t];
  const end = t.indexOf('\n---', 4);
  if (end === -1) return [{}, t];
  const raw = t.slice(4, end);
  const body = t.slice(end + 4).replace(/^\n+/, '');
  const fm = {};
  for (const line of raw.split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (line.startsWith(' ') || line.startsWith('\t')) continue; // flat: skip nested lines
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const k = line.slice(0, colonIdx).trim();
    const v = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (v !== '') fm[k] = v;
  }
  return [fm, body];
}
