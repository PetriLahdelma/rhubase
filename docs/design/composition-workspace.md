# Composition workspace surface brief

## Purpose

The generated workspace helps design-system maintainers record and compare manual foundation choices against a CLI-inspected, pinned source catalog. Success means a reviewer can trace every contribution to its source, revise a scenario without losing uncertainty, and download a closed-schema project for authoritative CLI validation.

## Mode and scene

This is an **Operate** surface for sustained desktop review in ordinary office light. It uses a warm paper field, compact editorial hierarchy and familiar form controls. RhuBase crimson marks primary actions and identity; leaf green is reserved for neutral brand detail and never signals approval.

## Interaction contract

- Source identity remains visible beside every capability and selection.
- Evidence and prior findings remain separate from editable planning choices.
- Any edit changes the status to **Needs CLI validation** and hides stale counts and checks.
- Source exclusion shows consequences and refuses to silently rewrite target or delivery choices.
- Import validates the closed schema, source IDs, source digests and declared-mode evidence before mutation.
- Download saves a draft project; it never approves, executes or claims compatibility.
- Undo and redo cover planning mutations. Essential actions use labeled native controls and visible keyboard focus.

## Visual direction

The surface extends the existing RhuBase identity rather than introducing a new visual world. It preserves gap-logo variation 1, `#E31238`, `#74B61B`, `#111618` and a warm off-white background. The memorable moment is the shift from a CLI-validated snapshot to a visibly stale draft after the first edit: the interface removes old assurance instead of carrying it forward.

## Constraints and open validation

The workspace is a self-contained generated HTML file with no network, server, external font, source execution or filesystem browsing. It targets desktop review and collapses structurally on narrower screens. Browser workflow, responsive rendering, keyboard behavior and usability still require live evaluation; source inspection and a Node DOM-contract harness are engineering evidence only.
