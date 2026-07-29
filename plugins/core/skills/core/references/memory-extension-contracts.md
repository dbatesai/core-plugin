# Memory extension contracts

How an overlay (a downstream wrapper like a delivery-specific install) extends CORE's
memory and metrics layers **without a core change**. This is the core-vs-extension separation made
concrete for the additive-memory layers (Phase 4) and the observability layer (Phases 0–3):
CORE owns the source-agnostic schema and the generic readers; the overlay populates the
dimension from its own richer sources and adds its own interpretation in its own layer.

The governing rule, from `references/external-sources/source-registration-framework.md`:

> *Any extractor — regardless of source — produces this shape. Any downstream consumer reads
> this shape. The extractor is source-shaped (knows its source); the schema is source-agnostic.*

So extension is **produce-into-a-shared-schema**, never method-override. There is no CORE class
to subclass — CORE is files + scripts (plugin-shipped, Node-only). The "interface" is the frontmatter shape
plus documented semantics; "implementing" it is the overlay's extractor writing the field, which
CORE's generic readers then consume.

CORE itself runs every one of these layers on its *own* simpler sources (conversation + local
files) and collects usable metrics from them — CORE is a working instance, not just a rig for
overlays. An overlay runs the same contract on richer sources. Same dimension, same readers,
same metrics; only source richness differs.

## The extension boundary — what's open, what's closed

Extension means **producing into shapes CORE already reads**. These seams are built and open
today, with no core change:

- **Field values on the shared unit schema** — an extractor populates `t_valid`,
  `confidence-level`, `topics`, `sources`, body subsections; CORE's readers consume them as-is.
- **The `world-time-policy` registration hook** (§2) and the other per-source registration
  fields (`body-construction-policy`, `stability-defaults`, `confidence-default`).
- **Inbox Mode B/C blocks** — any extractor that writes the block shape in
  `external-sources/source-registration-framework.md §4` gets graduated by `/process-memory`,
  and can pre-flight its output mechanically with `scripts/check-inbox.mjs`.
- **Metrics capture passthrough** — extra event fields and new `query_shape` values ride
  through `log-event.mjs` untouched (§3).
- **Additive detectors** — new Layer-2 passes over the captured record, alongside
  `metrics-detectors.mjs`.
- **Saved agent compositions** under `~/.core/agents/`.

These sets are **closed** — extending them is a core change shipped through this repo, not
something a wrapper can register locally:

- **Unit types and edge types.** `VALID_TYPES` / `VALID_EDGE_TYPES` in `scripts/check-units.mjs`
  are hardcoded sets; a wrapper's novel type WARNs at validation and there is no project-local
  override. New types get blessed into core on cross-corpus evidence.
  Propose them upstream; don't carry unblessed types.
- **Harness adapters.** `KNOWN_HARNESSES` in `scripts/contract-format.mjs` is
  `['claude-code', 'codex']`. A new harness needs a `harnesses/<name>.md` adapter plus
  generator support in core.
- **Retrieval tiers.** The four-tier ladder is protocol prose with no registration point. A
  wrapper cannot insert a tier; it can shape what enters the store, not how the ladder walks it.
- **The priority function's signals.** `priority.mjs` weighs its R/F/S signals as shipped; no
  hook.

**Reopen condition.** This boundary is honest-docs-over-speculative-hooks by design. A local
extension mechanism (e.g. a project-level allowed-types file `check-units.mjs` folds into its
sets) gets revisited when a second wrapper demonstrates a concrete novel-type need that the
upstream blessing path can't serve — not before.

---

## 1. Bi-temporal validity

The world-time validity axis, alongside CORE's record-time (`created`/`updated`).

| | |
|---|---|
| **Fields** | `t_valid` (ISO date — when the fact became true in the world), `t_invalid` (ISO date — when it stopped). Both optional. |
| **Semantics** | `t_valid` defaults to `created`, computed at read-time, written explicitly only when world-time diverges from record-time. `t_invalid` is empty while the fact holds. Invariant: `t_valid <= t_invalid`. |
| **Who populates (CORE-native)** | The supersession writer (`bitemporal.mjs --stamp`) stamps `t_invalid` when a unit's status is terminal and a supersedes-edge retired it. `t_valid` rides the `created`-default. |
| **Who populates (overlay)** | An extractor sets `t_valid` from its source's own world-time — see the `world-time-policy` registration field (§2). This is the divergent case CORE can't infer: only the source knows when its underlying fact became true. |
| **CORE readers** | `bitemporal.mjs --as-of <date>` (point-in-time reconstruction), `--metrics` (storage-health rollup), the stale-context detector (`metrics-detectors.mjs` — superseded-but-still-read = HIGH), `impact-trace.mjs --superseded-impact`. All operate on whatever validity intervals are present, regardless of who wrote them. |
| **Suppression invariant** | A unit whose `t_invalid` is in the past is invalidated — excluded from the currently-valid set the way retired units are. Cold history stays reachable by `--as-of` or a supersedes-edge walk. |

## 2. Source population hook — the `world-time-policy` registration field

Where an overlay declares **how a given source's extractor derives `t_valid`** — the same way
`body-construction-policy`, `stability-defaults`, and `confidence-default` already tell the
extractor how to populate the shared schema. See `source-registration-framework.md`.

```yaml
# in <project>/_sources/<source-name>.yaml
world-time-policy: <prose: how this source's world-time maps to t_valid>
  # e.g. "use the message send-time"; "use the doc's effective-date field, fall back to created"
```

CORE reads no source-specific world-time logic; the extractor writes `t_valid`, CORE's readers
honor it.

---

## 3. Metrics layer extension — capture passthrough + additive detectors

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
- **The capture gate is the deployment switch.** Metrics are default-on; the whole
  substrate (classifier, detectors, rollups, bi-temporal storage metrics) runs for every workspace
  unless it opts out via `CORE_METRICS_ENABLED=0` or `workspace.json` `metrics_enabled: false`.
  Capture stays local. An overlay that wants a workspace dark sets the opt-out; everyone else
  contributes to the corpus by default.

What CORE owns: the six-state recognition taxonomy, the rollup, the startup readiness signal, the gold
detectors, the calibration harness (`calibrate-classifier.mjs`) and its precision gate. What the
overlay owns: its own event fields, its own `query_shape` vocabulary, its own detectors, and its
own calibration labels. The classifier is PROVISIONAL until calibration clears 0.7 precision —
an overlay running on it inherits an uncalibrated instrument AND is the second corpus that helps
calibrate it.

---

## Stability contract for wrappers

What CORE keeps stable across releases. Breaking changes to any of these are versioned per the
blast-radius policy (MAJOR/MINOR on the plugin version) and called out in `CHANGELOG.md`:

- **Unit frontmatter shape** — the required fields and committed `status` values exported by
  `scripts/check-units.mjs` (`REQUIRED_FIELDS`, `VALID_STATUSES`).
- **The committed edge-type set** — additive growth only; existing types are never
  re-semanticized or removed without a supersession note.
- **The inbox Mode B/C block shape** (`external-sources/source-registration-framework.md §4`)
  and the strip-on-graduation rule for `mode` / `judgment-needed`.
- **Metrics event passthrough** — unknown event fields and `query_shape` values are never
  rejected by capture.
- **`~/.core/workspaces/<id>/` layout** for the files named in `protocols/data-storage.md`.
- **Unknown-frontmatter preservation** — CORE tooling never strips fields it doesn't know.

What is internal and may change without notice: script internals and exports not named above,
analyzer output formats, `state-cache.json` shape, the OTel trace span fields while the trace
layer is a collection stub.

Co-installation rule: a wrapper writes only under its own `~/.core/<wrapper>/` sub-namespace
and never the shared registry files — see `protocols/data-storage.md §Single-writer assumption`.

---

## The one-line version

CORE ships the dimension and the generic readers; the overlay populates from its richer sources
and adds its own detectors. Same schema, same readers, same metrics — CORE on conversation +
local files, the overlay on its delivery channels. A field ships in CORE only when a CORE reader
consumes it; unknown frontmatter fields an overlay writes are preserved, never stripped. The closed sets (unit/edge types, harnesses, retrieval tiers) extend through core, not
locally — see §The extension boundary.
