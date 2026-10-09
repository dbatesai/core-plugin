/**
 * Whether CORE may look outside the project for optional evidence: the harness's own memory,
 * transcripts and connector config, and the optional collab target. In project-only mode it may not,
 * so each such reader asks here first and reports the evidence as not observed, never as absent or
 * clean. Required identity checks and the user's explicit actions keep their own gates.
 */
import { projectOnlyHint } from './project-only.mjs';

// ponytail: project-only is the one restrictive mode today; another one adds its reason here.
export function outsideObservationOff(cwd = process.cwd()) {
  return projectOnlyHint(cwd) ? 'project-only' : null;
}
