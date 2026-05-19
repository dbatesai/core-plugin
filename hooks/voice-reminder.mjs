/**
 * UserPromptSubmit hook — per-turn voice imperative injection.
 * Counters the Claude Code coding-assistant baseline that bleeds through
 * past ~80K context tokens.
 *
 * Per DC-80 the plugin ships Node.js (.mjs) only.
 */

process.stdout.write(JSON.stringify({
  additionalContext: "Voice reminder: plain person voice. No 'load-bearing' as a rhetorical intensifier in prose (the structural-rule label in agents/roles.md is the exception). No bullet-table reflex. No formal labels. Write how a person talks, not how a document template looks.",
}));
