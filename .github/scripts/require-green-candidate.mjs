/**
 * require-green-candidate.mjs — refuse a release identity to a commit whose
 * required workflow did not pass.
 *
 * Reads a GitHub workflow-runs payload
 * (/repos/{owner}/{repo}/actions/workflows/{file}/runs) from --runs-file or
 * stdin and keeps only runs for the exact candidate SHA and the named workflow.
 *
 * One commit can carry several runs of the same workflow: a re-run repeats a
 * run_number at a higher run_attempt, while a second trigger (the same SHA
 * pushed to another branch) opens a new run_number entirely. Those are
 * different questions. Within a run_number the newest attempt is the current
 * answer, in both directions — a green re-run clears a candidate, a red one
 * revokes it. Across run_numbers the gate reads every run's current answer and
 * fails closed: any completed non-success refuses, and only then does a
 * completed success clear the candidate. A run still going is not a verdict, so
 * it neither clears nor blocks a commit another run already finished on.
 *
 * Exit codes:
 *   0 — the required workflow concluded success for this exact commit
 *   1 — a run exists and did not conclude success (failed, cancelled, unfinished)
 *   2 — no run for this commit, or the payload is unreadable
 *
 * Dependency-free; the API call itself belongs to the workflow, which pipes the
 * response in. CI infrastructure — not part of the shipped plugin tree.
 *
 * CLI:
 *   gh api "..." | node require-green-candidate.mjs --sha <sha> --workflow ci.yml
 *   node require-green-candidate.mjs --sha <sha> --workflow ci.yml --runs-file runs.json
 */

import { readFileSync } from 'node:fs';

const GREEN = 0;
const NOT_GREEN = 1;
const NO_RUN = 2;

function flag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** True when a run belongs to the named workflow file. */
function isWorkflow(run, workflow) {
  const path = typeof run.path === 'string' ? run.path : '';
  return path === workflow || path.endsWith(`/${workflow}`);
}

function newest(a, b) {
  const an = Number(a.run_number) || 0;
  const bn = Number(b.run_number) || 0;
  if (an !== bn) return an > bn ? a : b;
  const aa = Number(a.run_attempt) || 0;
  const ba = Number(b.run_attempt) || 0;
  return aa >= ba ? a : b;
}

function main(argv) {
  const out = (line) => process.stdout.write(`${line}\n`);
  const sha = flag(argv, '--sha');
  const workflow = flag(argv, '--workflow');
  const runsFile = flag(argv, '--runs-file');

  if (!sha || !workflow) {
    process.stderr.write('usage: require-green-candidate.mjs --sha <sha> --workflow <file.yml> [--runs-file <path>]\n');
    return NO_RUN;
  }

  let raw;
  try {
    raw = readFileSync(runsFile ?? 0, 'utf8');
  } catch (e) {
    out(`no verdict: cannot read the workflow-runs payload (${e.message})`);
    return NO_RUN;
  }

  let payload;
  try { payload = JSON.parse(raw); } catch {
    out('no verdict: the workflow-runs payload is not JSON');
    return NO_RUN;
  }

  const runs = Array.isArray(payload?.workflow_runs) ? payload.workflow_runs : null;
  if (!runs) {
    out('no verdict: the payload carries no workflow_runs array');
    return NO_RUN;
  }

  const candidates = runs.filter((r) => r && r.head_sha === sha && isWorkflow(r, workflow));
  if (candidates.length === 0) {
    out(`refusing: no ${workflow} run for candidate ${sha}`);
    return NO_RUN;
  }

  // One current answer per run_number — the newest attempt of each.
  const current = new Map();
  for (const run of candidates) {
    const key = Number(run.run_number) || 0;
    const held = current.get(key);
    current.set(key, held ? newest(held, run) : run);
  }
  const answers = [...current.values()];

  const red = answers.find((r) => r.status === 'completed' && r.conclusion !== 'success');
  if (red) {
    out(`refusing: ${workflow} run ${red.run_number}.${red.run_attempt} for ${sha} concluded ${red.conclusion}`);
    return NOT_GREEN;
  }

  const green = answers.find((r) => r.status === 'completed' && r.conclusion === 'success');
  if (!green) {
    const pending = answers.reduce(newest);
    out(`refusing: ${workflow} run ${pending.run_number}.${pending.run_attempt} for ${sha} is ${pending.status}, not completed`);
    return NOT_GREEN;
  }

  out(`green: ${workflow} run ${green.run_number}.${green.run_attempt} succeeded for candidate ${sha}`);
  return GREEN;
}

process.exit(main(process.argv.slice(2)));
