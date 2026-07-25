# Windows path-and-encoding contract

Seven rules for any new script, hook, index generator, enrichment writer, or packaging path. They all guard against one disease: a Mac or source-repo shape assumption leaking into install-time or runtime logic. Treat these as requirements when scaffolding new code, not as review catches after the fact.

1. **Path-to-slug: use the canonical `mapProjectPathToSlug()` (`scripts/project-slug.mjs`). Never hand-roll a cwd-to-slug encoder.** Claude Code maps the drive colon, backslashes, and forward slashes all to `-` (`C:\Users\...` becomes `C--Users-...`, double dash from the colon). A local `replace(/\//g,'-')` or `replace(/[/\\]/g,'-')` is wrong on Windows because it misses the colon or the backslash — a hand-rolled encoder can falsely report memory not visible on Windows while the mechanism actually works.

2. **Resolve every path relative to the resolved plugin root** (`resolve-plugin-root.mjs`), and build paths with `path.join`, never string concatenation with `/`. **Never assume a `plugins/core/` segment survives install.** The marketplace installs `source: "./plugins/core"` by flattening that directory's contents into the cache version root, so the installed tree is `<root>/skills/...`, not `<root>/plugins/core/skills/...`. A path built from the source-repo shape misses on every real Claude Code install.

3. **Never make a zip with `tar -a -c -f *.zip`.** Zip support behind `-a` is non-portable: Windows bsdtar has it, GNU tar (Git Bash / MSYS2, and what Node's `spawnSync('tar')` often resolves to) does not, and silently emits an uncompressed tar wearing a `.zip` name with exit 0. Verifying via `tar -t` does not catch it, because GNU tar reads its own tar output successfully. Verify the output's first bytes are the zip magic `50 4b 03 04` and treat anything else as failure — or better, build the zip in-process with a Node zip library, which removes the external-binary dependency entirely.

4. **Read and write files as explicit UTF-8.** Node defaults to UTF-8, so pure-Node code is fine, but never shell out to a tool that uses the platform default: Windows' console code page is cp1252 and it crashes on UTF-8 content. If a config walk sniffs `.ini` files, note that OneDrive writes them UTF-16LE.

5. **No inline `node -e` with backslashes or regex in hooks or startup.** The Windows Bash tool shell-mangles inline node payloads that carry `\` or a regex literal into invalid JS. Keep all logic in `.mjs` files invoked by path.

6. **On a synced store (OneDrive, Dropbox, iCloud), do not assume POSIX write-then-read ordering.** A unit written by an enrichment pass may still be mid-flush when the index build or retrieval reads it, and reparse-point desync can silently break a path. Either keep the hot store off the synced path, or verify-after-write instead of assuming the write landed. This is a hard design constraint on any write-then-read pipeline (enrichment, index generation, PPR precompute), not an afterthought.

7. **For byte-stable reruns, account for line endings.** Windows checkouts and editors introduce CRLF, and `.gitattributes`/`autocrlf` can rewrite files under you. If a hash, a tokenization, or a determinism gate depends on exact bytes, normalize line endings explicitly rather than trusting the platform to leave them alone.

**One-line version for a brief header:** resolve relative to the plugin root, encode paths through the canonical slug function, read/write explicit UTF-8, never trust an external archive/shell tool's platform behavior, and never assume a synced filesystem flushed in order.
