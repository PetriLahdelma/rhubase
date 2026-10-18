# Compose a shared-foundation blueprint

`rhubase compose` is an experimental, read-only engineering preview for comparing manually chosen foundation scenarios. It accepts two to eight local design-system packages. Start a new project from those sources or reopen a project that records selections, rationale, dependencies, and architecture choices. It produces a draft and an offline editing workspace without requiring a consumer application or an existing target package.

This preview validates the bounded manual-composition contract in [composition-spec.md](composition-spec.md). It does not complete PRD M1, generate a target, migrate an application, or establish real compatibility.

## Start without writing JSON

```sh
./bin/rhubase compose --init --target @example/foundation \
  --source a=./system-a --source b=./system-b \
  --out ../foundation-plan
```

Open `workspace.html` in the output directory in a browser. The source catalog shows supported components and tokens with source identities and evidence. No contributions are selected automatically. Layout, topology and delivery start with editable defaults, not recommendations.

In the workspace, choose contributions, record rationale, declare dependencies and branch alternative scenarios. You can edit target names, dispositions and architecture choices, undo/redo, and import or download a pinned project. Excluding a source removes its contributions while preserving dependent edges as unresolved prerequisites. At least two sources must remain included.

The workspace is a self-contained local file. It does not run a server, access your repositories or call a remote service. Changes remain in memory until you download a project. After edits, previous findings are visibly out of date: download the project and rerun `compose --project` with your original source bindings and a new output directory to obtain authoritative checks. Import requires matching pinned source identities; the Rust CLI validates every reopened project again.

## Run the example

Build RhuBase and install its pinned dependencies as described in [Getting started](getting-started.md), then run this command from the repository root. The output path must be new and outside the checkout and all source packages.

```sh
./bin/rhubase compose \
  --project examples/composition/project.json \
  --source a=examples/composition/a \
  --source b=examples/composition/b \
  --source c=examples/composition/c \
  --out ../rhubase-composition
```

Every catalog source has an explicit local binding, including source C, which the AB scenario excludes. RhuBase does not fetch packages or infer source bindings.

For a disposable demonstration that chooses a fresh scratch output directory, run:

```sh
npm run example:compose
```

The example compares two manual scenarios:

- **ABC** retains A's `Dialog`, B's action-token alias and declared dark mode, and C's `Portal`. A human-declared dependency records that Dialog requires Portal.
- **AB** intentionally excludes C. Its dependency points to the missing Portal selection, so the report keeps the scenario as a useful draft with a visible blocker. RhuBase does not add Portal or source C automatically.

The action-token selection also retains its same-source `color.brand` alias target. Simple aliases shaped like `{token.path}` must close within the selected tokens from that source. RhuBase does not resolve an alias by matching a token from another source.

## Review the output

A successful run creates five files:

| File | Purpose |
| --- | --- |
| `workspace.html` | Offline manual editor with a source catalog, scenario controls and project download/import. |
| `review.md` | Human-readable comparison, blockers, limitations, and proposed architecture. |
| `blueprint.json` | Validated machine-readable draft. It is non-executable and reports consumer impact as unmeasured. |
| `project.json` | Portable copy of the input with source digests filled in. Local source paths are not embedded. |
| `manifest.json` | Sizes and SHA-256 hashes for the other artifacts. |

Scenario selections are manual planning inputs. Their rationale explains why a component, token, or mode was retained, adapted, excluded, or deferred. They are not approvals, recommendations, or permission to change a repository.

The blueprint and Markdown review compare the first scenario with each alternative: added/removed sources, changed source-qualified selections and rationale, target and architecture changes, dependencies and blocker counts. A lower blocker count is not a recommendation or proof of compatibility. Changing a contribution from A's Button to B's Button remains an explicit change even when both have the same export name.

Modes come only from `declaredModes` in the project. RhuBase labels them as human declarations. It does not inspect runtime theme behavior or claim that a selected component supports a declared mode.

Each scenario also contains an architecture choice across layout, package topology, and delivery. The output shows proposed slots and obligations for imports, exports, assets, tests, stories, and build/type output. Every check remains `not-run`. A `minimal` delivery choice is a proposal; a `preserve` choice identifies the source recipe to investigate and still requires verification.

Target names use supported lowercase package identities such as `foundation` or `@example/foundation`. Workspace previews propose sibling names such as `@example/foundation-components`, `@example/foundation-tokens`, and `@example/foundation-themes`. These are proposed package identities, not generated packages. Source coverage counts each established capability once even when multiple scenarios select it.

Unsupported counts describe extraction gaps, including malformed token files and unsupported entrypoint or prop shapes. They do not estimate how many components or tokens were missed. Selected static capabilities include bounded relative file, digest and line references; mode provenance points to the human declaration and project revision. Source bodies are not copied into the bundle.

## Reopen a pinned project

Use the exported `project.json` to repeat the same review against explicitly bound local sources:

```sh
./bin/rhubase compose \
  --project ../rhubase-composition/project.json \
  --source a=examples/composition/a \
  --source b=examples/composition/b \
  --source c=examples/composition/c \
  --out ../rhubase-composition-reopened
```

The output directory must be new. If any source content changed after the project was pinned, RhuBase refuses the run as stale and publishes no replacement report. Start a new review from the original unpinned project when you intentionally want to inspect changed sources.

## Author a project

Use the workspace, or start from [the example project](../examples/composition/project.json) and follow the closed schema in [composition-spec.md](composition-spec.md). The workspace behavior is specified in [composition-workspace-spec.md](composition-workspace-spec.md). Unknown fields, forged approval fields, unsupported dispositions, invalid selections, and unsafe paths are errors.

The first profile supports manual `retain`, `adapt`, `exclude`, and `defer` dispositions. Adaptation is unresolved human work. A missing, excluded, or deferred dependency target becomes a blocker; it never causes an automatic selection. Declared dependency cycles remain visible ordering questions.

## Current boundary

The preview reads bounded static TypeScript declarations and supported token JSON from local packages. It preserves source identities and keeps source packages immutable. It does not run package scripts or module bodies.

The following remain unvalidated or outside this profile:

- full PRD M1 composition and architecture coverage;
- full DTCG token semantics or arbitrary reference syntax;
- runtime theme and mode compatibility;
- behavioral, visual, accessibility, or consumer compatibility;
- generated target files, package recipes, or a validated build;
- design-to-code or Figma synchronization;
- recommendations, delegated planning, migration execution, or pull requests.

Passing the controlled tests admits only this experimental preview. It does not replace independent holdouts or maintainer studies; see [validation status](validation.md).
