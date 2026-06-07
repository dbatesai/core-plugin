---
name: orient
description: Deprecated. `/orient` was folded into `/core` — its session-bootstrap behavior is now part of CORE's startup protocol. This shim exists only for backward compatibility; it prints a deprecation notice and does no work. Use `/core` instead.
user-invocable: true
---

# `/orient` — deprecated

`/orient` no longer does anything on its own. Everything it used to do — picking a project back up, edit detection, hygiene-log signals, the hot-section refresh, source-registration readiness, and the readiness summary — is now part of CORE's startup protocol and runs whenever you type `/core`.

When this skill is invoked, do exactly one thing: print the notice below verbatim, then stop. Do not read files, run scripts, or bootstrap — `/core` owns that now. This is a no-op shim kept so existing muscle memory, scripts, and wrappers don't break.

```
/orient is deprecated. Its behavior is now built into CORE's startup protocol —
just run /core, which orients automatically (and re-run /core mid-session for a
fresh readiness summary). This command no longer does anything on its own.
```

After printing the notice, take no further action unless the user asks for something specific.
