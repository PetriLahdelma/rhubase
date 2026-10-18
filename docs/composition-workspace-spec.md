# Manual composition workspace — executable contract

This increment implements source intake, manual editing and semantic scenario comparison from FR-01/02/03/10/13. It extends the existing experimental composer; it does not claim full M1, independently validated recommendations, theme compatibility or execution authority.

## Intake and catalog

`rhubase compose --init --target @example/foundation --source a=DIR --source b=DIR --out NEW_EXTERNAL_DIR` starts without hand-written JSON. `--init` and `--project` are mutually exclusive; `--target` is required only with `--init`. Intake uses the same strict source guards, extraction and publication as normal compose. It creates one `baseline` scenario with all admitted sources, no selected capabilities, new target, colocated/single-package/minimal proposed architecture. Defaults are editable starting values, never recommendations. Pins are populated by the normal coordinator. Malformed IDs, duplicate bindings and invalid package names fail before publication.

Each blueprint source gains `capabilities`: entries `{kind,name,status,evidenceRefs}` for established static components/tokens and human-declared modes. Status is `observed`, `human-declared`, or `unsupported`; incomplete or ambiguous facts cannot look established. Gaps remain visible in source coverage. Names from different sources never imply equivalence. No full source bodies, absolute paths or quality ranking are exported.

## Scenario comparisons

Blueprint `comparisons` compares the first scenario to each subsequent scenario deterministically. Each record contains `baselineScenario`, `scenario`, `sourceChanges:{added,removed}`, `targetChanged`, `architectureChanges` (field names), `selectionChanges` (kind, source, name, targetName, disposition, rationale before/after), and `dependencyChanges:{added,removed}`. Match selections by stable selection ID; a source/package change must be visible even when export names match. Added/removed/changed entries have `id`, `change`, `before`, `after` (nullable). Display-only scenario title and collection ordering do not constitute capability changes. Include `blockerCounts:{before,after}` without interpreting a lower count as superior. Comparisons are reviewed planning differences, never runtime compatibility or measured effort. Markdown includes an equivalent linear comparison.

## Offline workspace

Every compose output gains `workspace.html`, included in the artifact manifest. It is a self-contained local browser editor with embedded pinned project, blueprint/catalog and trusted static UI assets; no network requests, server, external fonts, source execution or local filesystem browsing. Untrusted text is inserted as text, embedded JSON escapes HTML delimiters, and a restrictive CSP disallows remote access and forms. Existing gap-logo proportions and colors are preserved.

Users can inspect/filter the source catalog, manually add/edit/remove contributions, change target/dispositions/rationale/architecture, branch and switch scenarios, declare/edit dependencies, exclude a source with explicit consequences, undo/redo edits, and download a project in the existing closed schema. Exclusion removes selections from that source but retains dependent edges as unresolved prerequisites. At least two sources remain included. All edits are unsaved until explicit download; provide an unload warning. Opening/importing a saved project requires matching catalog source IDs and pinned digests; mismatches must be rejected instead of attaching old evidence to new decisions. Reject unknown/approval fields and malformed shapes before mutation. Preserve the loaded state on failed import.

Edited plans are visibly `Needs CLI validation`; do not retain stale blocker counts or show original architecture checks as updated results. The browser offers convenience checks; the Rust coordinator remains authoritative. Original inspected evidence stays separate from edited planning choices. Download never approves or executes. Re-run compose with the downloaded file and original source bindings into a new output to get current findings. Essential controls have labels and keyboard access; status uses text. No WCAG conformance or user-effort claim without evaluation.

## Acceptance and verification

Before implementing, record failing tests for init, catalog/comparison outputs and editor model behavior. Cover A+B+C/subset removal, same-name/different-source changes, rationale/architecture/dependency changes, reordering, missing dependency preservation, branching/undo/redo, stale import, hostile names, output hashes and no input writes. Exercise a browser workflow and export/reopen through the real CLI. Run repository syntax/tests, Rust formatting/clippy/tests and the release CLI suite. Record controlled engineering evidence separately from outstanding independent holdouts and maintainer studies.
