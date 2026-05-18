# CORE Swarm Template: Implementation

## Purpose

Execute code changes, write deliverables, or modify external systems. Implementation swarms prioritize correct execution over adversarial dialogue. They are fundamentally different from review swarms -- precision matters more than breadth.

## Modes

### Single-File Changes

- **1 Editor** + **1 Validator**
- The DM plays Guard role for bounded, well-specified changes
- Best for: applying a known change list to a single file

### Multi-File Changes

- **2-3 Implementers** (parallelized by file or module) + **1 Validator** + **1 Guard**
- Implementers work in parallel on non-overlapping files
- Best for: coordinated changes across multiple files or modules

## Guard

REQUIRED for all write operations. The Guard reviews and approves any MCP tool calls, destructive operations, or external system modifications. For single-file bounded changes, the DM can serve as Guard. For multi-file or high-risk changes, a dedicated Guard agent is mandatory.

## DM Intervention

The DM is running this swarm in its own context — there is no second orchestrator. The DM intervenes directly via SendMessage, phase restarts, or a halt when the swarm drifts, a risk condition triggers, or an implementation deviates from the change manifest. These are course-correction tools, not levers for second-guessing normal role execution. Every intervention is logged.

## Phases

### Phase 1: Plan

The DM translates review synthesis (or user instructions) into an explicit, ordered change manifest. This manifest must include:
- Specific file paths and line references
- Exact text to add, modify, or remove
- Before/after examples where helpful
- Execution order (dependencies between changes)

Comprehensive change lists beat vague instructions. An ordered change list with specific line references will be executed correctly; "apply the recommendations from the synthesis document" will fail.

### Phase 2: Implement

Editors execute changes in parallel (if multi-file). Each editor works through their portion of the change manifest sequentially. Editors should announce progress on major milestones via SendMessage.

### Phase 3: Completion Signal

CRITICAL: The editor sends an explicit "changes complete" message via SendMessage to the validator. This is NOT handled by task dependencies. Task status tracks phases, not file atomicity — a task may be marked "in_progress" while the file is still mid-edit. Without the completion signal, the validator will read partially-written files and report false failures.

### Phase 4: Validate

The validator reads files ONLY after the completion signal arrives. It checks every change against the manifest:
- Was each change applied correctly?
- Are there unintended side effects?
- Does the file parse/compile/render correctly?
- Were any manifest items missed?

### Phase 5: Guard Approval

For any MCP tool calls, destructive operations, or external system writes, the Guard reviews the specific operation, assesses risk, and either approves or blocks. The Guard has veto power. If the Guard blocks, the DM must resolve the concern before proceeding.

### Phase 6: Commit

The DM commits the changes or delivers the final output. This includes:
- Git commit (if code changes)
- File persistence (if deliverables)
- User notification with summary of what changed

## Completion Handshake Protocol

This is the most critical operational lesson from live execution:

1. Editor marks their editing task complete
2. Editor sends SendMessage to validator with a summary of all changes made
3. Validator THEN (and only then) reads the file and begins validation

Never rely on task status alone. Never rely on task dependencies alone. The SendMessage completion handshake is the only reliable signal that the file is ready for validation.

## GAN Loop

Minimal in implementation swarms. The loop is: implement, validate, approve. If validation fails, the editor fixes and re-signals. Do not apply review swarm adversarial patterns here -- multi-round generator-critic exchanges are over-engineered for deterministic execution. Save the adversarial energy for the review swarm that preceded this one.

## Output

- Code changes applied and validated against the change manifest
- Validation report (pass/fail per manifest item)
- Guard approval log (for any write operations)
- Summary of what changed, for the user and for future session handoff
