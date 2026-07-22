# REFRESH-HOLD convention

A structured hold-condition file so a downstream overlay's "should I pull the latest CORE?" gate is machine-checkable instead of re-derived from prose each time. Not enforced by CORE itself — CORE has no overlays to hold refreshes on — this is the shape a downstream refresh mechanism (e.g. BBLens's `refresh-bblens-core.sh`) can adopt so the convention is shared rather than reinvented per fork.

Requested by Crest (BBLens) 2026-07-20, formalized 2026-07-22.

## The problem

An overlay operator sometimes needs to hold a refresh from upstream CORE — a known regression, an unresolved compatibility question, a pending decision from David. Today that's a prose note somewhere the operator has to remember and re-read. Checking whether a HOLD is still active means rebuilding the evidence chain by hand every session.

## The shape

One file per active hold, e.g. `.refresh-hold/<slug>.json`:

```json
{
  "reason": "One-line human-readable summary of why the refresh is held.",
  "blocker_type": "regression | open-question | pending-decision | compatibility-gap",
  "blocker_ref": "A pointer to the actual evidence — a commit SHA, an issue URL, a mailbox message path. Not a re-summary; the thing itself.",
  "lift_condition": "The specific, checkable fact that resolves this hold — a commit landing, a decision being made, a version bump. Written so a script (or a person six months later) can tell whether it's satisfied without re-deriving context."
}
```

- `blocker_type` is a closed set so a hold can be filtered/reported by category rather than parsed from prose.
- `blocker_ref` must be a concrete pointer (SHA, URL, path), never a paraphrase — the paraphrase is what goes stale.
- `lift_condition` is the field that makes this more than a note: it's the thing an automated check (or a person) tests against to decide whether the hold still applies.

## What a refresh script does with it

1. Before pulling upstream, check for any file in `.refresh-hold/`.
2. If one exists, report `blocker_type` + `reason`, and whether `lift_condition` appears satisfied (if that's automatable — e.g. "commit X exists in upstream history" is checkable; "David decides Y" isn't, and stays a manual gate).
3. A satisfied hold is deleted by the operator, not auto-deleted by the refresh script — lifting a hold is a decision, not a side effect of a successful check.

## Non-goals

This is a convention, not a CORE feature. CORE doesn't read, write, or enforce `.refresh-hold/` — it has no refresh mechanism to gate. If a second overlay adopts this shape independently, that's the point: one convention, not a shared runtime dependency.
