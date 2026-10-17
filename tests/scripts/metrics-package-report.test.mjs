// The package report says why deltas are missing: a first package starts the trend line, any other
// reason is shown as unavailable with that reason, in both REPORT.md and report.html.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReportMd, buildReportHtml } from '../../plugins/core/skills/core/scripts/metrics-package-report.mjs';

const pkg = (deltas) => ({
  manifest: { generated_at: '2026-10-09T00:00:00Z', mode: 'single' },
  projects: [{ pseudonym: 'proj-abc', headline: {}, blocks: {}, flags: [], deltas }],
});

test('a first package starts the trend line in both reports', () => {
  for (const deltas of [undefined, { available: false, reason: 'first package for this project' }]) {
    assert.match(buildReportMd(pkg(deltas)), /\*\*Deltas:\*\* first package for this project — trend lines start here\./);
    assert.match(buildReportHtml(pkg(deltas)), /first package for this project — trend lines start here\./);
  }
});

test('any other missing-delta reason is shown as unavailable with that reason, escaped in HTML', () => {
  const deltas = { available: false, reason: 'history rows belong to an earlier key <k1>' };
  const md = buildReportMd(pkg(deltas));
  assert.match(md, /\*\*Deltas:\*\* unavailable — history rows belong to an earlier key <k1>\./);
  assert.doesNotMatch(md, /trend lines start here/);
  const html = buildReportHtml(pkg(deltas));
  assert.match(html, /Deltas unavailable — history rows belong to an earlier key &lt;k1&gt;\./);
  assert.doesNotMatch(html, /trend lines start here/);
});
