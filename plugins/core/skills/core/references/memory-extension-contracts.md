# Memory extension contracts

How an overlay (a downstream wrapper like a delivery-specific install) extends CORE's
memory and metrics layers **without a core change**. This is the DC-102 separation made
concrete for the additive-memory layers (Phase 4) and the observability layer (Phases 0–3):
CORE owns the source-agnostic schema and the generic readers; the overlay populates the
dimension from its own richer sources and adds its own interpretation in its own layer.

The governing rule, from `references/external-sources/source-registration-framework.md`:

> *Any extractor — regardless of source — produces this shape. Any downstream consumer reads
> this shape. The extractor is source-shaped (knows its source); the schema is source-agnostic.*

So extension is **produce-into-a-shared-schema**, never method-override. There is no CORE class
to subclass — CORE is files + scripts (DC-77/DC-80). The "interface" is the frontmatter shape
plus documented semantics; "implementing" it is the overlay's extractor writing the field, which
CORE's generic readers then consume.

CORE itself runs every one of these layers on its *own* simpler sources (conversation + local
files) and collects usable metrics from them — CORE is a working instance, not just a rig for
overlays. An overlay runs the same contract on richer sources. Same dimension, same readers,
same metrics; only source richness differs.

---

## Status legend

- **BUILT** — CORE produces and consumes the dimension today; the field is in the schema and a
  CORE reader honors it. Overlay populates from its own sources via the named hook.
- **CONTRACT** — the field shape and semantics are specified here, but CORE ships no field and
  no reader yet, because only an overlay would produce or consume it. CORE adds the field **when
  there is a consumer** — a contract describing a field does not make an empty field a seam
  (that is dormant machinery). The overlay may carry the field in its own layer now; CORE's
  generic readers will honor it the day CORE grows one.
- **CONTRACT / /core-owed** — same, plus the semantics involve a foundational judgment call
  (e.g. a collision with an existing committed field) that is deferred to the parallel-critique
  `/core` pass, not decided solo mid-build.

---

## 1. Bi-temporal validity — **BUILT** (Phase 4 layer 1)

The world-time validity axis, alongside CORE's record-time (`created`/`updated`).

| | |
|---|---|
| **Fields** | `t_valid` (ISO date — when the fact became true in the world), `t_invalid` (ISO date — when it stopped). Both optional. |
| **Semantics** | `t_valid` defaults to `created`, computed at read-time, written explicitly only when world-time diverges from record-time. `t_invalid` is empty while the fact holds. Invariant: `t_valid <= t_invalid`. |
| **Who populates (CORE-native)** | The supersession writer (`bitemporal.mjs --stamp`) stamps `t_invalid` when a unit's status is terminal and a supersedes-edge retired it. `t_valid` rides the `created`-default. |
| **Who populates (overlay)** | An extractor sets `t_valid` from its source's own world-time — see the `world-time-policy` registration field (§5). This is the divergent case CORE can't infer: only the source knows when its underlying fact became true. |
| **CORE readers** | `bitemporal.mjs --as-of <date>` (point-in-time reconstruction), `--metrics` (storage-health rollup), the stale-context detector (`metrics-detectors.mjs` — superseded-but-still-read = HIGH), `impact-trace.mjs --superseded-impact`. All operate on whatever validity intervals are present, regardless of who wrote them. |
| **Suppression invariant** | A unit whose `t_invalid` is in the past is invalidated — excluded from the currently-valid set the way retired units are. Cold history stays reachable by `--as-of` or a supersedes-edge walk. |

## 2. Provenance / deliberateness — **CONTRACT** (Phase 4 layer 2)

Who said a fact, in what medium, and whether it was a human decision or an automation default.

| | |
|---|---|
| **Proposed fields** | `provenance.speaker`, `provenance.medium`, `provenance.deliberateness` (`human-decided` \| `auto-defaulted`), `reconstruction-confidence` (for derived/synthesized facts). |
| **Semantics** | Travels with the fact. `deliberateness` distinguishes "in the record" from "deliberately decided" (BBLens use case 10). `reconstruction-confidence` annotates facts the agent synthesized rather than read verbatim (use cases 9, M2). |
| **Who populates** | Overlay extractors, from source metadata (a Teams message carries speaker + medium; a SharePoint doc carries author). CORE's simple sources rarely diverge from single-author/single-medium, so CORE ships no field until a CORE reader needs one. |
| **CORE reader (when built)** | A render/retrieval surface that attributes a fact to its speaker/medium, and a provenance-attributed slice of retrieval metrics (retrieval quality by source). Until that consumer exists, CORE does not add the fields. |
| **Status note** | The exact attribute set is a judgment call; treat this as the documented target, refined when the first consumer lands. |

## 3. Salience — **CONTRACT / /core-owed** (Phase 4 layer 3)

An explicit salience signal assigned at graduation (the missing third retrieval signal beyond
recency/frequency), plus held success-criteria a latent fact can be matched against.

| | |
|---|---|
| **Proposed field** | `salience` (representation TBD — categorical vs numeric). |
| **The owed decision** | `salience` collides with DC-69's numeric `confidence` and the categorical `confidence-level` — whether salience is a third axis, a re-use, or a reframe of DC-94 Lock 5 is a **foundational call deferred to the parallel-critique `/core` pass**. It is deliberately NOT decided solo. |
| **Who populates** | Overlay (and eventually CORE) at graduation, once the representation is decided. |
| **CORE reader (when built)** | The priority function (DC-69) absorbing salience as a fourth signal — which is itself the foundational change the `/core` pass must rule on. |

## 4. Person-node synthesis — **CONTRACT** (Phase 4 layer 5)

A person modeled as a queryable node whose "current state" is synthesized across the channels
they appear in (BBLens use cases 8, M1).

| | |
|---|---|
| **Shape** | A `person`-type unit per person, with inbound edges from facts that mention them; a synthesis render that answers "what's X's current position / when did they last appear / who's gone quiet." |
| **Who populates** | Overlay — it has the multi-person, multi-channel corpus. CORE's corpus is effectively single-person (the author), so CORE ships the minimal `person` type it already has and defers the multi-channel synthesis render to the overlay that can exercise it. |
| **CORE reader (when built)** | A person-synthesis render over the §People surface. |

## 5. Source population hook — the `world-time-policy` registration field

Where an overlay declares **how a given source's extractor derives `t_valid`** — the same way
`body-construction-policy`, `stability-defaults`, and `confidence-default` already tell the
extractor how to populate the shared schema. See `source-registration-framework.md`.

```yaml
# in <project>/_sources/<source-name>.yaml
world-time-policy: <prose: how this source's world-time maps to t_valid>
  # e.g. "use the message send-time"; "use the doc's effective-date field, fall back to created"
```

CORE reads no source-specific world-time logic; the extractor writes `t_valid`, CORE's readers
honor it. This is the seam for provenance population too (the extractor sets the provenance
fields from the same source metadata) once those fields are built.

---

## 6. Metrics layer extension — capture passthrough + additive detectors

The observability layer (Phases 0–3) extends the same way. An overlay adds its own metrics
**without a core change** along three seams:

- **Capture is passthrough-extensible.** `log-event.mjs` and the retrieval-event producer spread
  arbitrary fields (`{ ts, ...event }` / `{ ...event, ... }`). An overlay emits its own event
  fields and its own `query_shape` values; analyzers bucket unknown `query_shape` values as
  `other` and never choke. Zero core change.
- **Interpretation is additive.** Detectors run as Layer-2 passes over the Layer-1 record; new
  detectors are added without touching capture (`metrics-detectors.mjs` is the pattern). An
  overlay writes its own domain detectors — e.g. a delivery-specific "missed-signal" detector —
  reading the same captured ground truth.
- **The capture gate is the deployment switch.** Metrics are default-on (DC-107); the whole
  substrate (classifier, detectors, rollups, bi-temporal storage metrics) runs for every workspace
  unless it opts out via `CORE_METRICS_ENABLED=0` or `workspace.json` `metrics_enabled: false`.
  Capture stays local. An overlay that wants a workspace dark sets the opt-out; everyone else
  contributes to the corpus by default.

What CORE owns: the six-state recognition taxonomy, the rollup, the `/orient` signal, the gold
detectors, the calibration harness (`calibrate-classifier.mjs`) and its precision gate. What the
overlay owns: its own event fields, its own `query_shape` vocabulary, its own detectors, and its
own calibration labels. The classifier is PROVISIONAL until calibration clears 0.7 precision —
an overlay running on it inherits an uncalibrated instrument AND is the second corpus that helps
calibrate it.

---

## The one-line version

CORE ships the dimension and the generic readers; the overlay populates from its richer sources
and adds its own detectors. Same schema, same readers, same metrics — CORE on conversation +
local files, the overlay on its delivery channels. A field ships in CORE only when a CORE reader
consumes it; everything else is a contract the overlay can build against today.
