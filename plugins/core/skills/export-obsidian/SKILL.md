---
name: export-obsidian
description: Export the current project's memory store as an Obsidian-browsable vault (and OKF v0.1-draft-conformant bundle) so the user can visually explore what CORE knows — graph view, backlinks, note browsing — in a tool they already have. Use whenever the user wants to SEE or BROWSE their memory store visually — "let me see what you know", "open this in Obsidian", "export my memories as a vault", "can I browse the graph", "show me the knowledge graph" — including when they describe the outcome without naming the tool ("I want to click around and see how everything connects"). Do NOT use for the anonymized statistics package (that's /metrics-package), for the live in-terminal health check (/metrics), or for anything that touches BBLens/managed data directly — this is a CORE-project-local, dev-machine-only export.
user-invocable: true
allowed-tools:
  - Read
  - Bash
  - Glob
---

# `/export-obsidian`

Export the current project's `_memories/` store as a read-only projection — a folder of markdown files, generated frontmatter-derived links, and a manifest — that opens directly as an Obsidian vault and is simultaneously OKF v0.1-draft conformant. The point is visual: the user opens the folder in Obsidian and sees graph view, backlinks, and note browsing over what the agent actually knows. Seeing what the agent knows, not just being told, is what builds confidence in it.

**The script is the only writer.** `scripts/render-okf-export.mjs` (in the core skill's `scripts/` directory) computes every byte of the export from one atomic snapshot of the store. Never hand-edit or "clean up" the exported files — the export is disposable and regenerated fresh each run; edits to it are silently lost on the next export and never flow back into the real store.

**Script path resolution.** Resolve `CORE_ROOT` the same way `/metrics-package` and `/process-memory` do: take the absolute path you loaded this `SKILL.md` from and strip the trailing `/skills/export-obsidian/SKILL.md` — that prefix is the plugin root. Reuse the `CORE_ROOT` startup already resolved this session if you have it. If you cannot resolve a concrete root, say so plainly and stop — never run `node` against a guessed path.

## Run

1. **Resolve the project.** Default to the current project directory. If the user names a different registered workspace, resolve it the same way other skills do (via `~/.core/index.json`) rather than guess a path.

2. **Run the script:**

```bash
node "${CORE_ROOT}/skills/core/scripts/render-okf-export.mjs" <project-dir>
```

Add `--out <dir>` only if the user asked for a specific landing spot; the default is `<project-dir>/_okf-export`. The export directory is disposable — regenerating it always replaces the prior one cleanly (the script refuses to touch anything that isn't its own prior output, so a hand-authored directory at the same path is never silently destroyed).

3. **Verify before claiming.** The script prints `exported <N> units → <path>` — confirm that path actually exists before telling the user it's done. Then relay, in plain language: where the export landed, and that opening it as an Obsidian vault (Obsidian → Open folder as vault → pick the exported directory) shows the graph.

4. **Always report the link-density line.** The script prints something like `link density: 42.0% of active units carry ≥1 active edge (N orphans) — threshold unratified, David's call`. This is not noise — a sparse graph (many orphans) is the single biggest thing that makes the visual export disappointing, and the user should know that going in rather than open a mostly-disconnected graph and wonder if something's broken. Name the percentage plainly; don't editorialize about whether it's "good."

## What this does and does not guarantee

- **Export-only — the live store is never touched.** This generates a throwaway projection; it never writes into `_memories/`.
- **No retired facts resurface.** Retired units never appear as documents in the export, and no generated link ever points at a retired or otherwise inactive unit. (Body prose in an active unit may still *mention* a retired fact in passing — that's out of scope; the guarantee is about documents and generated edges, not prose content.)
- **One link syntax serves both targets.** The generated `## Related` block uses plain markdown path links (`[type: title](target.md)`), which Obsidian resolves as real graph edges and OKF accepts as its own document-linking mechanism — no dual-maintenance between the two formats.
- **This is dev-machine-only.** The export and the act of opening it in Obsidian both happen on the user's own machine against their own project. Never run this against BBLens or any other managed/residency-controlled data path — that boundary is the overlay's to manage, not this skill's.

## Self-healing rails

- **No `_memories/` in the target directory:** the script exits with a usage message — say so plainly and confirm the project directory is right rather than retry blindly.
- **The export directory exists but wasn't generated by this script** (a hand-authored folder happens to sit at the default `_okf-export` path): the script refuses to touch it and names why. Tell the user directly and ask where they'd like the export to land instead (`--out`).
- **Zero exported units or 100% orphans:** report the number honestly; this usually means the store is very new or link density hasn't been built up yet — don't apologize for the tool, just state the number.
