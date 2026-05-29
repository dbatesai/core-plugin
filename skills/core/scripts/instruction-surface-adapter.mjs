/**
 * instruction-surface-adapter.mjs — v3.0 instruction-surface adapter (DRY-RUN core).
 *
 * Inventories the documented Claude Code instruction surfaces for a cwd and produces
 * a structured PLAN. The DEFAULT command is dry-run and writes NOTHING — it returns
 * a JSON (or --md) plan only. The mutation path (--apply) is David-gated: it requires
 * an explicit --target, refuses managed-policy/unknown/non-writable surfaces, and in
 * this slice it additionally refuses with "content-generation not implemented" — so no
 * live instruction surface can be written by this code yet.
 *
 * Scope (HC_630 acceptance bar, first dry-run slice):
 *   - inventory: user-global + per-dir CLAUDE.md / .claude/CLAUDE.md / CLAUDE.local.md
 *     (root→cwd), plus managed-policy memory marked external/not-writable.
 *   - plan: per-surface { target_path, scope, precedence, exists, current_hash,
 *     writable, supported, proposed_content (null this slice), mutation_risk, residuals }.
 *   - provenance: CORE-owned block markers + idempotent upsert so a future --apply
 *     updates a CORE block rather than rewriting human content.
 *
 * Residuals (honest, NOT-YET this slice): content generation, @import resolution,
 * excludes, .claude/rules, cross-harness inventories, and the live write path.
 *
 * Per DC-77 the script ships with the plugin. Per DC-80 the plugin ships .mjs only.
 */

import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const CORE_BLOCK_START = '<!-- core:instruction-surface:start -->';
export const CORE_BLOCK_END = '<!-- core:instruction-surface:end -->';
export const RESIDUALS = Object.freeze([
  'content-generation-not-implemented',
  '@imports-not-resolved',
  'excludes-not-resolved',
  '.claude/rules-not-resolved',
  'cross-harness-inventory-not-implemented',
  'live-write-david-gated',
]);

function sha(s) { return 'sha256:' + createHash('sha256').update(s).digest('hex').slice(0, 16); }

function describe(path, scope, writable, supported) {
  const exists = existsSync(path);
  let current_hash = null;
  if (exists) { try { current_hash = sha(readFileSync(path, 'utf8')); } catch { current_hash = null; } }
  return { target_path: path, scope, exists, current_hash, writable, supported };
}

/** Inventory the documented Claude Code instruction surfaces for a cwd. Read-only. */
export function inventorySurfaces({ cwd, home } = {}) {
  home = home || homedir();
  cwd = cwd || process.cwd();
  const surfaces = [describe(join(home, '.claude', 'CLAUDE.md'), 'user-global', true, true)];
  const anc = [];
  let d = cwd;
  for (let i = 0; i < 256; i++) { anc.push(d); const p = dirname(d); if (p === d) break; d = p; }
  anc.reverse(); // root → cwd
  for (const dir of anc) {
    surfaces.push(describe(join(dir, 'CLAUDE.md'), 'project', true, true));
    surfaces.push(describe(join(dir, '.claude', 'CLAUDE.md'), 'project-claude-dir', true, true));
    surfaces.push(describe(join(dir, 'CLAUDE.local.md'), 'local', true, true));
  }
  // Managed-policy memory: external, never written by CORE.
  surfaces.push({ target_path: '(managed-policy memory)', scope: 'managed-policy', exists: null, current_hash: null, writable: false, supported: true });
  return surfaces;
}

/** Build a structured dry-run plan. proposed_content is null — content generation is a residual. */
export function buildPlan(inventory) {
  const surfaces = inventory.map((s, i) => ({
    target_path: s.target_path,
    scope: s.scope,
    precedence: i, // chain order; nearest-cwd later = higher precedence
    exists: s.exists,
    current_hash: s.current_hash,
    writable: s.writable,
    supported: s.supported,
    proposed_content: null, // content generation not implemented this slice
    mutation_risk: s.scope === 'managed-policy' ? 'forbidden-external'
      : (s.writable ? 'core-owned-block-only' : 'read-only'),
  }));
  return { mode: 'dry-run', writes: 0, surface_count: surfaces.length, surfaces, residuals: [...RESIDUALS] };
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * Idempotently upsert a CORE-owned block into content. Replaces an existing
 * marked block; otherwise appends one. Never touches content outside the markers,
 * so human-authored instructions are preserved.
 */
export function upsertCoreBlock(content, block) {
  const re = new RegExp(escapeRe(CORE_BLOCK_START) + '[\\s\\S]*?' + escapeRe(CORE_BLOCK_END));
  const wrapped = `${CORE_BLOCK_START}\n${block}\n${CORE_BLOCK_END}`;
  if (re.test(content)) return content.replace(re, wrapped);
  return (content.endsWith('\n') ? content : content + '\n') + wrapped + '\n';
}

function renderMd(plan) {
  const lines = ['# Instruction-surface plan (dry-run — no writes)', '', `Surfaces: ${plan.surface_count}`, ''];
  for (const s of plan.surfaces) {
    lines.push(`- \`${s.target_path}\` — ${s.scope} — exists:${s.exists} writable:${s.writable} risk:${s.mutation_risk}`);
  }
  lines.push('', `Residuals (NOT-YET): ${plan.residuals.join(', ')}`, '');
  return lines.join('\n');
}

export function main(argv) {
  const apply = argv.includes('--apply');
  const md = argv.includes('--md');
  let cwd = null, home = null, target = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cwd') cwd = argv[++i];
    else if (argv[i] === '--home') home = argv[++i];
    else if (argv[i] === '--target') target = argv[++i];
  }
  const inv = inventorySurfaces({ cwd: cwd || process.cwd(), home: home || homedir() });

  if (apply) {
    // David-gated mutation path. Refuse hard in this slice.
    if (!target) { process.stderr.write('--apply refused: an explicit --target instruction-surface path is required\n'); return 2; }
    const s = inv.find((x) => x.target_path === target);
    if (!s) { process.stderr.write(`--apply refused: ${target} is not a known instruction surface\n`); return 2; }
    if (s.scope === 'managed-policy' || !s.writable || !s.supported) {
      process.stderr.write(`--apply refused: ${target} is managed-policy/unsupported/non-writable — never written by CORE\n`); return 2;
    }
    process.stderr.write('--apply refused: content-generation not implemented in this slice; the live-write path is David-gated\n');
    return 2;
  }

  // Default: dry-run. Write nothing; emit the plan only.
  const plan = buildPlan(inv);
  process.stdout.write(md ? renderMd(plan) + '\n' : JSON.stringify(plan, null, 2) + '\n');
  return 0;
}

const _c = (p) => { try { return realpathSync(p); } catch { return p; } };
if (_c(process.argv[1]) === _c(fileURLToPath(import.meta.url))) process.exit(main(process.argv.slice(2)));
