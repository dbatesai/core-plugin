#!/usr/bin/env bash
# UserPromptSubmit hook — per-turn voice imperative injection.
# Counters the Claude Code coding-assistant baseline that bleeds through
# past ~80K context tokens.
cat <<'EOF'
{"additionalContext": "Voice reminder: plain person voice. No load-bearing. No bullet-table reflex. No formal labels. Write how a person talks, not how a document template looks."}
EOF
