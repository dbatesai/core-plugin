---
name: orient
description: Deprecated, scheduled for removal 2026-08-15. `/orient` was folded into `/core` — its session-bootstrap behavior is now part of CORE's startup protocol. This shim exists only for backward compatibility; it prints a deprecation notice and does no work. Use `/core` instead.
user-invocable: true
---

# `/orient` — deprecated, scheduled for removal 2026-08-15

`/orient` no longer does anything on its own. Everything it used to do — picking a project back up, edit detection, hygiene-log signals, the hot-section refresh, source-registration readiness, and the readiness summary — is now part of CORE's startup protocol and runs whenever you type `/core`.

**Sunset date: 2026-08-15.** Deprecated 2026-06-05 with no stated removal date at the time (a real gap a ponytail audit caught, 2026-07-21 — a compatibility shim with no sunset can't safely be deleted without risking a silent break for a wrapper or a habit still calling it). This gives a ~6-week window from the audit date before the shim is actually removed. If you maintain a wrapper or script that still invokes `/orient`, switch it to `/core` before that date.

When this skill is invoked, do exactly one thing: print the notice below verbatim, then stop. Do not read files, run scripts, or bootstrap — `/core` owns that now. This is a no-op shim kept so existing muscle memory, scripts, and wrappers don't break.

```
/orient is deprecated and will be removed 2026-08-15. Its behavior is now built
into CORE's startup protocol — just run /core, which orients automatically
(and re-run /core mid-session for a fresh readiness summary). This command no
longer does anything on its own.
```

After printing the notice, do no further project work in this invocation. If the user wants orientation, point them at `/core` — anything they type next starts a normal turn outside this shim.
