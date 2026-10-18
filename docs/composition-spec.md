# Experimental composition contract (schema 1)

This is the executable specification for the next bounded engineering slice. It does not claim completion of PRD M1, DTCG conformance, reliable recommendations, a GUI, target generation or migration. Existing assessment/inference contracts remain unchanged.

## Entry point and authority

`rhubase compose --project project.json --source a=./system-a --source b=./system-b --out ../plan`

Sources are explicitly bound local package directories. No consumer or target package is required. All source IDs in the project must be bound exactly once, including catalog sources excluded from an individual scenario. Source roots must be distinct real directories with package manifests, not symlink roots. Use the existing trusted TypeScript compiler and bounded worker/process supervision for static extraction. The Rust coordinator owns project validation, dependency/selection checks, rendering and exclusive atomic publication. A worker supplies observed source facts, not policy or executable plans. No package scripts, module bodies, registry acquisition or source rendering runs.

Honor `--compiler`, `--node`, `--timeout-ms`, `--max-output-bytes`, `--json`, `--quiet` and `--color`. No custom worker override in this first compose profile. Reject `NODE_OPTIONS`. Existing commands stay compatible. Unknown fields/options and duplicate identifiers are errors, not silently ignored.

## Input project

All fields below are required. Schema is closed. Arrays must be bounded: 2–8 sources, 1–16 scenarios, at most 256 selections and 512 dependencies per scenario, at most 16 declared modes per source. Project JSON input is at most 1 MiB. IDs use `[A-Za-z][A-Za-z0-9_-]{0,63}`; display text is bounded and escaped in output. Text is data, never code or Markdown authority.

```json
{
  "schemaVersion": 1,
  "kind": "rhubase-composition-project",
  "title": "Shared foundation",
  "sources": [
    { "id": "a", "digest": null, "declaredModes": [] },
    { "id": "b", "digest": null, "declaredModes": ["light", "dark"] }
  ],
  "scenarios": [
    {
      "id": "ab",
      "title": "A and B",
      "includedSources": ["a", "b"],
      "target": { "name": "@example/foundation", "mode": "new", "baseSource": null },
      "selections": [
        { "id": "button", "source": "a", "kind": "component", "name": "Button", "targetName": "Button", "disposition": "retain", "rationale": "Keep its public API for review." },
        { "id": "dark", "source": "b", "kind": "mode", "name": "dark", "targetName": "dark", "disposition": "retain", "rationale": "Declared requirement; component support is unverified." }
      ],
      "dependencies": [],
      "architecture": { "layout": "colocated", "topology": "single-package", "delivery": "minimal", "deliverySource": null }
    }
  ]
}
```

A source digest is null for initial inspection or lowercase SHA-256 for a pinned input. A mismatched pin aborts publication with a stale-input error. Exported `project.json` fills pins and can be reopened through the same command with new explicit local bindings. No absolute local paths or complete snapshots are copied into the portable project. Revision is a canonical content digest; source/path-independent semantic content reproduces identically. No imported approval fields are accepted.

Target mode is `new` (baseSource must be null) or `evolve` (baseSource must name an included source). Target name is a supported lowercase npm-style identity: `name` or exactly `@scope/name`, with safe package segments and at most 200 characters. The project title remains separate display text. The source remains immutable; the output never materializes that target.

Each scenario includes at least two catalog sources. Each selection names an included source and a source-qualified component, token or declared mode. Component/token names must be found in the admitted static snapshot. Ambiguous or incomplete extraction cannot establish a supported selection: fail visibly or mark it unresolved without inventing facts. Mode names come only from the project's `declaredModes`; label them human declarations, never extracted/runtime-verified support. Mode values and component theme compatibility remain unmeasured in this profile.

Dispositions supported now: `retain`, `adapt`, `exclude`, `defer`. Adaptation remains manual work. `combine`, `replace`, and new implementation generation are explicit unsupported-profile errors, not approximated. Excluded/deferred selections do not count as retained capabilities. Duplicate target names within a capability kind are a reported conflict; equal source names/values never merge identities.

Dependencies are `{ "from": "selectionId", "to": "selectionId", "rationale": "..." }`. `from` must exist; a missing/excluded/deferred `to` creates an explicit blocker rather than adding a capability. These edges are human-declared requirements. A cycle in this declared planning graph is an unresolved ordering question, not a claim that component recursion is invalid. Report it visibly. Supported simple token aliases of the form `{token.path}` must resolve to selected retained/adapted tokens of the same source; an unresolved/excluded target or alias cycle is a blocker. Do not resolve aliases by matching tokens from another source. Other reference syntaxes and token semantics remain explicit unsupported/unknown coverage; no full DTCG claim.

## Architecture previews

Layout: `colocated` or `by-kind`. Topology: `single-package` or `workspace` (tokens/themes/components). Delivery: `minimal` or `preserve`. Minimal requires deliverySource null; preserve requires an included source ID. Keep all three dimensions independently selectable; cover all eight combinations.

Produce only proposed component slots/trees and obligations for imports, public exports, CSS/assets, test/story discovery and build/type outputs. Workspace package identities use sibling suffixes: `@scope/name-components`, `@scope/name-tokens`, and `@scope/name-themes` (or the unscoped equivalents), never package subpaths presented as distinct packages. No slot claims a file was moved or generated. `minimal` is a proposed recipe with checks not run. `preserve` identifies the source recipe to investigate and remains verification-required; it does not assert an arbitrary source toolchain works. This profile demonstrates truthful previews, not full FR-09 recipe compatibility or validated target builds. Stories/tests/config protections remain untouched.

## Output and states

Write a new external directory, refusing existing outputs, source-contained outputs, project-file overwrite and tool/compiler-contained output. Publish atomically only after all source and tool guards still match. Artifacts: `project.json` (pinned reusable input), `blueprint.json` (validated plan), `review.md` (human report), `workspace.html` (offline manual editor), `manifest.json` (artifact hashes/sizes). Full source bodies are not exported; bounded evidence references are enough. The [workspace extension](composition-workspace-spec.md) defines source intake, capability catalogs and semantic comparisons without changing the schema-1 project format.

Blueprint top-level kind `rhubase-composition-blueprint`, schemaVersion 1, status `draft-review`, executable false, consumerImpact `unmeasured`, and projectRevision SHA-256. Preserve catalog identities, selected source IDs, scenario selections/rationale and declared edges. Include per-scenario findings and coverage limitations, retained counts, unresolved manual work, architecture previews and all checks as not-run. Scenarios with blockers remain useful draft reports; do not claim they are compatible or ready. Bad schema, stale pins, invalid source identities or forged extraction are fatal.

Source-level selected coverage counts unique established capabilities, not repeated selections across scenarios or unresolved requests. Per-scenario retained counts remain separate. Every blocker-severity conflict must reconcile with the blueprint's blockers, CLI summary, human report and unresolved-work state.

Unsupported coverage counts extraction-gap records, not a known number of missing components or tokens. Component-surface gaps include entrypoint, export and prop-surface limitations; token gaps include token-file and individual-token limitations. Selected static capabilities export bounded relative file/hash/line references without full source bodies. Modes instead refer to the human declaration and project revision. Rust validates the compact extraction schema and source evidence; semantic extraction remains the responsibility of the bundled static analyzer, not a second independently implemented TypeScript compiler.

Manual selections are planning inputs only; this profile has no human-approved or policy-selected authority state. No command to generate, apply, run checks, push or publish is introduced. Approved-looking imported data must fail the closed schema.

Rust verifies worker source count/IDs/digests/package identities and bounded component/token structures and source evidence (file, digest, quote/range) against its guarded roots before planning. Reject missing, duplicated, swapped or executable worker data. Reuse existing protocol and guard utilities; do not loosen existing inference/assessment validation.

## Required red–green evidence

Before implementation, tests must demonstrate failures for the missing command/model. Validate positive A+B and A+B+C/new-target/no-consumer cases; evolve-as-base; exclusion isolation; source identity collisions; manual missing dependencies/cycles; simple token alias closure/cycles; declared modes never imply theme compatibility; all eight preview dimensions; stable report content and pinned round trip; stale pins; strict fields and forged approvals; no overwrite/path escape/symlink; malformed worker output; cancellation and no source/script changes. Keep test expectations independent of implementation-derived outputs where practical.

Gate: targeted tests and full `npm run verify`, release CLI suite and independent review. Passing controlled tests admits only an experimental engineering preview. Fresh independent holdouts and maintainer studies are not replaced by these tests. A live repository-connected interface, richer profiles, recommendations, delegation and execution remain gated work under the reconciled plans.
