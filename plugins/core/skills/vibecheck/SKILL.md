---
name: vibecheck
description: Lightweight session vibe capture — emotional truth of the session rendered as ASCII art and logged to ~/.core/vibes/vibe-log.md. 100% terminal, no browser required. Use whenever the user says "vibecheck", asks to capture the feel/mood of the current session, or runs /vibecheck. Bundled with CORE as a sub-skill.
user-invocable: true
---

# `/vibecheck` — Session Vibe Capture

Capture the emotional truth of this session. Not a status report. Not a summary. The actual vibe — the thing that doesn't fit in a session summary but would be the first thing you'd tell a friend.

---

## Step 1: Read the Room

Look back at the session. Ask honestly:

- What was the energy like?
- Was there momentum, or were we grinding?
- Did something click, or are we still in fog?
- Was it satisfying? Frustrating? Strangely good? A slog that paid off?
- Any moment where something unexpected happened — good or bad?

Don't optimize for positivity. Capture what was actually true. A bleak session rendered honestly is more valuable than a cheerful one rendered fake.

## Step 2: Land on a Vibe

Express it in 1–2 sentences. Be specific. "Productive" is not a vibe. "Untangled something we'd been avoiding for three sessions" is a vibe. "Started slow, ended sharper than expected" is a vibe.

Examples of real vibes:
- "Methodical. Moved a lot of pieces that needed to move. Not exciting, but the right work."
- "Kept hitting walls on the path references. Frustrating, but we finally have them clean."
- "Surprisingly fun. The swarm got heated on the architecture question and the right answer came out of the friction."
- "Context window stress throughout. Racing to get things durable before the ceiling. Made it."
- "Quiet session. Just writing. Good kind of quiet."

## Step 3: Draw the Vibe in ASCII

Render the vibe as a small ASCII scene — roughly 5–15 lines, up to ~60 columns wide. No fixed template or aesthetic: it could be a scene, a figure, a weather pattern, a creature, a mood object, an abstract texture. Whatever matches.

The ASCII is not decorative. It's the vibe made visible in a terminal — what you'd paste into Slack to say "this is how it went" without words.

**Guidance, not rules:**
- Match the shape to the feeling. Bleak session → bleak drawing. Euphoric → euphoric. Avoid chipper defaults — a session of attrition doesn't want a smiling character, it wants something worn, flat, or rhythmic.
- Pure ASCII is safest, but light Unicode box-drawing or weather glyphs (░ ▒ ▓ ~ * · ° ·) are fine in modern terminals.
- Avoid emoji — they render inconsistently in terminals.
- Short inline captions beside the art are welcome when they add feeling.

**Examples of the kind of thing:**

A "methodical, kept at it" vibe:
```
       _____
      /     \     clip ... clip ... clip
     |       |
     |  o o  |    (the bonsai takes its time)
     |   >   |
      \_____/
       |||||
     ~~~~~~~~~
```

A "heated but productive swarm" vibe:
```
     \\  ||  //
      \\ || //
     ===(^)===    sparks flying, steel sharpening
      // || \\
     //  ||  \\
         ^^
```

A "quiet writing session" vibe:
```
        ___
       |   |              ~ ~ ~
       |___|             steam curling
      /     \
     |  ( )  |        keys clicking in the next room
      \_____/
```

A "stuck in fog" vibe:
```
     ░ ░ ░ ░ ░ ░ ░ ░
    ░                ░    somewhere in here
     ░    ? ? ?     ░    is the thing we're after
    ░                ░
     ░ ░ ░ ░ ░ ░ ░ ░
```

Find the shape that fits *this* session. Don't reach for a template.

## Step 4: Log It

Append the entry to the top of `~/.core/vibes/vibe-log.md` using the Write tool. Create the file and the `~/.core/vibes/` directory if they don't exist. (Per DC-66/DC-67, v2 CORE runs on Claude Code Desktop with local filesystem; no MCP routing layer.)

The vibe log lives outside the indexed CORE store on purpose — vibes are never read back at bootstrap, so it carries no index entry and no other process needs to find it. Don't let it grow without bound, though: when the log passes about 50 entries, move the older ones to `~/.core/vibes/archive/vibe-log-<year>.md` before appending the new one.

**Log format:**

```markdown
## <YYYY-MM-DD> — <workspace name or "general">

**Vibe:** <1–2 sentence honest assessment>

**ASCII:**
​```
<the ASCII art>
​```

**One thing that mattered:** <the single most meaningful thing from this session — not the biggest, but the one that would stay with you>
```

After appending, print the ASCII and the one-sentence vibe to the terminal so the user sees it immediately. The log is for history; the print is for the moment.

---

## Notes

- Vibecheck is not a quality gate. It doesn't block anything.
- It's not therapy. It's a signal — the emotional data from a session that doesn't fit in a session summary.
- Over time, the vibe log becomes a record of how the work actually felt, not just what got done. Patterns emerge: which workspaces drain, which ones spark, when the grind is earning something vs. when it isn't.
- That's worth keeping.
