/**
 * metrics-package-report.mjs — REPORT.md + self-contained report.html for the
 * anonymized metrics package (companion to metrics-package.mjs; same whitelist
 * rule: all interpolated values are numbers, dates, fixed CORE vocabulary, or
 * pseudonyms — every template string here is fixed prose).
 *
 * The HTML follows the dataviz method (form → color-by-job → validated palette →
 * mark specs → dark mode): stat tiles for headlines, an ordinal blue ramp for the
 * ordered retrieval tiers, single-hue bars for warning categories, status colors
 * (icon + label, never color alone) for flags, table views under every chart.
 * Palette values are the validated reference instance from the dataviz skill.
 */

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (x) => x == null ? '—' : `${(x * 100).toFixed(0)}%`;
const numOr = (x, d = '—') => (x == null ? d : String(x));

// ---------- REPORT.md ----------

export function buildReportMd({ manifest, projects }) {
  const lines = [];
  lines.push('# CORE memory-efficacy package');
  lines.push('');
  lines.push(`Generated ${manifest.generated_at} · mode: ${manifest.mode} · generator ${manifest.generator ? manifest.generator.ran_from + (manifest.generator.source_sha ? ' @ ' + manifest.generator.source_sha : '') : 'unknown'} (manifest claims ${manifest.plugin ? 'v' + manifest.plugin.manifest_version : 'unknown'}) · schema ${manifest.schema_version}`);
  lines.push('');
  lines.push('This package exists for one purpose: feedback for refining CORE. Every value is a number, date, fixed CORE vocabulary, or a salted pseudonym — free text is dropped at generation, never copied. Residual risk is minimized, not zero: stable pseudonyms link the same anonymous project across packages from one install (delete `~/.core/metrics-package-salt` to sever); small cells are suppressed at k=3; per-unit rankings gate on store population. Trust labels use the committed vocabulary — `proven-live` / `direct` / `proxy` / `provisional` — with a basis note per block: retrieval stats are `proxy` until the corpus is fully product-emitted; recognition stays `provisional` until the classifier clears calibration (read trends, not levels).');
  lines.push('');
  for (const proj of projects) {
    lines.push(`## ${proj.pseudonym}`);
    lines.push('');
    const h = proj.headline;
    lines.push(`- **Store:** ${numOr(h.units_total)} units, ${numOr(h.edges_total)} edges · ${numOr(h.edges_per_active_unit)} edges/active unit · orphan rate ${pct(h.orphan_rate)} *(direct)*`);
    lines.push(`- **Retrieval:** ${numOr(h.retrieval_events_total)} logged events · escalation past lexical ${pct(h.escalation_rate)} · dip-back rate ${pct(h.dip_back_rate)} · ${numOr(h.miss_total, '0')} misses *(proxy — corpus not yet fully product-emitted)*`);
    lines.push(`- **Validator:** ${numOr(h.warn_total)} warnings, ${numOr(h.fail_total, '0')} failures *(direct)*`);
    lines.push(`- **Recognition:** latest rec-fail rate ${h.recfail_latest_rate != null ? pct(h.recfail_latest_rate) : `withheld (sample ${numOr(h.recfail_latest_sample, '0')} turns < 20 floor)`} *(provisional — uncalibrated classifier)*`);
    lines.push(`- **PROJECT.md:** ${h.project_md_bytes != null ? `${Math.round(h.project_md_bytes / 1024)}KB` : '—'}`);
    lines.push('');
    if (proj.deltas?.available) {
      const changes = Object.entries(proj.deltas.changes || {}).filter(([, v]) => v !== 0);
      lines.push(`**Since ${proj.deltas.since}:** ${changes.length ? changes.map(([k, v]) => `${k} ${v > 0 ? '+' : ''}${v}`).join(' · ') : 'no headline movement'}`);
    } else {
      lines.push('**Deltas:** first package from this install for this project — trend lines start here.');
    }
    lines.push('');
    if (proj.flags.length) {
      lines.push('**Flags:**');
      for (const f of proj.flags) lines.push(`- [${f.level.toUpperCase()}] ${f.text}`);
    } else {
      lines.push('**Flags:** none raised at current thresholds.');
    }
    lines.push('');
    const unavailable = Object.entries(proj.blocks).filter(([, b]) => b && b.available === false);
    if (unavailable.length) {
      lines.push('**Not covered (no silent narrowing):**');
      for (const [name, b] of unavailable) lines.push(`- ${name}: ${b.reason}`);
      lines.push('');
    }
  }
  lines.push('---');
  lines.push('`report.html` in this package renders the same data visually. Machine-readable blocks live under `projects/<pseudonym>/`.');
  lines.push('');
  return lines.join('\n');
}

// ---------- report.html ----------

// Validated reference palette (dataviz skill references/palette.md).
const CSS = `
:root { color-scheme: light; }
body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: #f9f9f7; color: #0b0b0b; }
.viz-root {
  --surface-1: #fcfcfb; --page: #f9f9f7; --ink-1: #0b0b0b; --ink-2: #52514e; --muted: #898781;
  --grid: #e1e0d9; --axis: #c3c2b7; --border: rgba(11,11,11,0.10);
  --ord-1: #86b6ef; --ord-2: #3987e5; --ord-3: #1c5cab; --ord-4: #0d366b;
  --seq: #2a78d6;
  --status-good: #0ca30c; --status-warning: #fab219; --status-serious: #ec835a; --status-critical: #d03b3b;
  max-width: 960px; margin: 0 auto; padding: 24px 16px 64px;
}
@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) body { background: #0d0d0d; color: #ffffff; }
  :root:where(:not([data-theme="light"])) .viz-root {
    color-scheme: dark;
    --surface-1: #1a1a19; --page: #0d0d0d; --ink-1: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
    --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,0.10);
    --ord-1: #86b6ef; --ord-2: #5598e7; --ord-3: #256abf; --ord-4: #184f95;
    --seq: #3987e5;
  }
}
h1 { font-size: 20px; margin: 8px 0 2px; }
h2 { font-size: 16px; margin: 28px 0 8px; }
.sub { color: var(--ink-2); font-size: 13px; margin-bottom: 20px; }
.tiles { display: flex; flex-wrap: wrap; gap: 12px; margin: 12px 0; }
.tile { background: var(--surface-1); border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; min-width: 128px; flex: 1; }
.tile .v { font-size: 26px; font-weight: 650; }
.tile .l { font-size: 12px; color: var(--ink-2); margin-top: 2px; }
.tile .t { font-size: 10px; color: var(--muted); margin-top: 4px; text-transform: uppercase; letter-spacing: 0.04em; }
.chart { background: var(--surface-1); border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; margin: 12px 0; overflow-x: auto; }
.chart h3 { font-size: 13px; margin: 0 0 10px; color: var(--ink-1); }
.flag { display: flex; gap: 8px; align-items: baseline; font-size: 13px; margin: 6px 0; }
.flag .chip { font-size: 11px; font-weight: 650; padding: 1px 8px; border-radius: 10px; color: #fff; }
table { border-collapse: collapse; font-size: 12px; margin-top: 10px; width: 100%; }
th, td { text-align: left; padding: 4px 10px 4px 0; border-bottom: 1px solid var(--grid); color: var(--ink-2); font-variant-numeric: tabular-nums; }
th { color: var(--muted); font-weight: 600; }
.bar-label { font-size: 11px; fill: var(--ink-2); }
.note { color: var(--muted); font-size: 12px; margin-top: 16px; }
`;

const FLAG_COLORS = { good: 'var(--status-good)', warning: 'var(--status-warning)', serious: 'var(--status-serious)', critical: 'var(--status-critical)' };
const FLAG_ICONS = { good: '✓', warning: '⚠', serious: '▲', critical: '✕' };

function tile(value, label, trust) {
  return `<div class="tile"><div class="v">${esc(value)}</div><div class="l">${esc(label)}</div>${trust ? `<div class="t">${esc(trust)}</div>` : ''}</div>`;
}

// Horizontal bar chart: ordered categories, one ordinal/sequential hue per spec.
// Native <title> carries the per-mark hover value; a table view follows for access.
function barChart(title, rows, { ordinal = false } = {}) {
  if (!rows.length) return '';
  const max = Math.max(...rows.map(r => r.value), 1);
  const bw = 480; const rh = 22; const gap = 6; const labelW = 150;
  const ordColors = ['var(--ord-1)', 'var(--ord-2)', 'var(--ord-3)', 'var(--ord-4)'];
  const bars = rows.map((r, i) => {
    const w = Math.max(2, Math.round((r.value / max) * bw));
    const y = i * (rh + gap);
    const fill = ordinal ? ordColors[Math.min(i, ordColors.length - 1)] : 'var(--seq)';
    return `<g transform="translate(0,${y})">
      <text class="bar-label" x="${labelW - 8}" y="${rh / 2 + 4}" text-anchor="end">${esc(r.label)}</text>
      <rect x="${labelW}" y="2" width="${w}" height="${rh - 4}" rx="4" fill="${fill}"><title>${esc(r.label)}: ${esc(r.value)}</title></rect>
      <text class="bar-label" x="${labelW + w + 6}" y="${rh / 2 + 4}">${esc(r.value)}</text>
    </g>`;
  }).join('');
  const height = rows.length * (rh + gap);
  const table = `<table><tr><th>Category</th><th>Count</th></tr>${rows.map(r => `<tr><td>${esc(r.label)}</td><td>${esc(r.value)}</td></tr>`).join('')}</table>`;
  return `<div class="chart"><h3>${esc(title)}</h3><svg width="${labelW + bw + 60}" height="${height}" role="img" aria-label="${esc(title)}">${bars}</svg>${table}</div>`;
}

// Daily events line: single series (no legend needed — the title names it).
function lineChart(title, points) {
  if (points.length < 2) return '';
  const w = 640; const h = 160; const padL = 36; const padB = 22;
  const max = Math.max(...points.map(p => p.value), 1);
  const x = (i) => padL + (i / (points.length - 1)) * (w - padL - 12);
  const y = (v) => 8 + (1 - v / max) * (h - padB - 8);
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const dots = points.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="4" fill="var(--seq)"><title>${esc(p.label)}: ${esc(p.value)}</title></circle>`).join('');
  const gridY = [0.5, 1].map(f => `<line x1="${padL}" x2="${w - 12}" y1="${y(max * f)}" y2="${y(max * f)}" stroke="var(--grid)" stroke-width="1"/>`).join('');
  const firstLabel = points[0].label; const lastLabel = points[points.length - 1].label;
  const table = `<table><tr><th>Day</th><th>Value</th></tr>${points.map(p => `<tr><td>${esc(p.label)}</td><td>${esc(p.value)}</td></tr>`).join('')}</table>`;
  return `<div class="chart"><h3>${esc(title)}</h3><svg width="${w}" height="${h}" role="img" aria-label="${esc(title)}">
    ${gridY}
    <line x1="${padL}" x2="${w - 12}" y1="${h - padB}" y2="${h - padB}" stroke="var(--axis)" stroke-width="1"/>
    <path d="${path}" fill="none" stroke="var(--seq)" stroke-width="2"/>
    ${dots}
    <text class="bar-label" x="${padL}" y="${h - 6}">${esc(firstLabel)}</text>
    <text class="bar-label" x="${w - 12}" y="${h - 6}" text-anchor="end">${esc(lastLabel)}</text>
  </svg>${table}</div>`;
}

export function buildReportHtml({ manifest, projects }) {
  const sections = projects.map((proj) => {
    const h = proj.headline;
    const tiles = [
      tile(numOr(h.units_total), 'units in store', 'direct'),
      tile(numOr(h.edges_per_active_unit), 'edges / active unit', 'direct'),
      tile(pct(h.orphan_rate), 'orphan rate', 'direct'),
      tile(pct(h.escalation_rate), 'retrieval escalation', 'proxy'),
      tile(h.recfail_latest_rate != null ? pct(h.recfail_latest_rate) : 'n<20', 'latest rec-fail', 'provisional'),
      tile(numOr(h.warn_total), 'validator warnings', 'direct'),
    ].join('');

    const flags = proj.flags.map(f =>
      `<div class="flag"><span class="chip" style="background:${FLAG_COLORS[f.level] || 'var(--muted)'}">${FLAG_ICONS[f.level] || '•'} ${esc(f.level)}</span><span>${esc(f.text)}</span></div>`
    ).join('') || '<div class="flag"><span>No flags raised at current thresholds.</span></div>';

    const r = proj.blocks['retrieval-stats'];
    let tierChart = '';
    let eventsLine = '';
    if (r?.available) {
      const tierTotals = {};
      for (const d of Object.values(r.days)) {
        for (const [t, n] of Object.entries(d.tiers || {})) tierTotals[t] = (tierTotals[t] || 0) + n;
      }
      tierChart = barChart('Retrieval tier distribution (all logged events)',
        Object.keys(tierTotals).sort().map(t => ({ label: `Tier ${t}`, value: tierTotals[t] })), { ordinal: true });
      const dayKeys = Object.keys(r.days).sort();
      eventsLine = lineChart('Retrieval events per day',
        dayKeys.map(d => ({ label: d, value: r.days[d].events })));
    }

    const v = proj.blocks['validator'];
    const warnChart = v?.available && Object.keys(v.warns_by_check || {}).length
      ? barChart('Validator warnings by check',
          Object.entries(v.warns_by_check).sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ label: k, value: n })))
      : '';

    const w = proj.blocks['workspace-metrics'];
    let recLine = '';
    if (w?.available && w.recognition?.available) {
      const dayKeys = Object.keys(w.recognition.days).sort();
      recLine = lineChart('rec-fail-tier-0 turns per day (PROVISIONAL — uncalibrated)',
        dayKeys.map(d => ({ label: d, value: (w.recognition.days[d].states['rec-fail-tier-0'] || 0) })));
    }

    const deltas = proj.deltas?.available
      ? `<div class="note">Since ${esc(proj.deltas.since)}: ${Object.entries(proj.deltas.changes || {}).filter(([, x]) => x !== 0).map(([k, x]) => `${esc(k)} ${x > 0 ? '+' : ''}${esc(x)}`).join(' · ') || 'no headline movement'}</div>`
      : '<div class="note">First package from this install for this project — trend lines start here.</div>';

    return `<h2>${esc(proj.pseudonym)}</h2><div class="tiles">${tiles}</div>${flags}${deltas}${tierChart}${eventsLine}${warnChart}${recLine}`;
  }).join('');

  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CORE memory-efficacy package</title>
<style>${CSS}</style>
<body><div class="viz-root">
<h1>CORE memory-efficacy package</h1>
<div class="sub">Generated ${esc(manifest.generated_at)} · ${esc(manifest.mode)} · generator ${manifest.generator ? esc(manifest.generator.ran_from) : 'unknown'} (manifest v${manifest.plugin ? esc(manifest.plugin.manifest_version) : '?'}) · anonymized: pseudonyms + aggregates only</div>
${sections}
<div class="note">Every value is a number, date, fixed CORE vocabulary, or salted pseudonym; free text is dropped at generation. Residual risk minimized, not zero — see manifest.json. Trust labels (committed vocabulary): direct = event log / store walk; proxy = behavior-dependent corpus; provisional = classifier not yet calibrated (read trends, not levels). Machine-readable blocks: projects/&lt;pseudonym&gt;/*.json.</div>
</div></body>`;
}
