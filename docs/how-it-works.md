# How RhuBase works

RhuBase uses a Rust coordinator around local Node/TypeScript analysis. The current product surface has two read-only commands: `assess` and `infer`.

## Assessment flow

1. **Inventory the consumer.** RhuBase admits bounded JavaScript, TypeScript, style, manifest, lockfile, CI identity, and CODEOWNERS metadata. Sensitive and generated paths are excluded. Repository scripts and source modules are never executed.
2. **Resolve explicit packages.** Every source and target comes from a user-provided selector. RhuBase supports local, workspace, and bounded installed packages. It does not choose a design system by similarity or fetch one from a registry.
3. **Bind the resolution.** The first worker phase returns package identities and a repository digest. The second phase repeats resolution and refuses drift.
4. **Compare each source with the target.** The TypeScript extractor reads supported declarations, tokens, and selected documentation. Each pair produces a draft migration contract.
5. **Discover consumer usage.** Static analysis follows supported direct imports, aliases, namespaces, immutable aliases, and bounded local re-exports. Unsupported paths remain gaps.
6. **Group decisions.** Usage groups retain source package, public export, present props, selected discriminator literals, dynamic prop names, and spread state. Arbitrary button labels do not create separate decisions.
7. **Validate independently.** Rust checks repository and package identity, evidence hashes and ranges, group/usage reconciliation, routes, target candidates, decision states, and verification metadata.
8. **Publish atomically.** The validated JSON, locally rendered Markdown, pairwise contracts, and manifest are written to a new external directory. Existing outputs are never overwritten.

## Inference flow

`infer` compares two immutable local package snapshots. It separates observed API/token changes from mapping proposals extracted through a bounded documentation grammar. Similar names or shapes do not establish a rename.

Every proposal is non-executable and needs review. Unsupported extraction suppresses unsafe absence claims. Inputs are hashed and checked again before output publication.

## Trust boundary

RhuBase does not need an AI model or API key. It does not import consumer modules, execute package lifecycle scripts, run CI, or send code to a service. Worker input and output are bounded; deadlines and cancellation clean the worker process group. The Rust coordinator validates data returned by Node before it becomes a durable artifact.

An explicitly supplied worker is a trusted operator override, not a sandbox for untrusted JavaScript.

## Coverage boundary

Supported discovery is deliberately partial. Wrappers, factories, runtime registries, computed access, dynamic/CommonJS bindings, opaque spreads, selected-package side-effect imports, CSS/token consumption, generated code, and unsupported dependency layouts may require manual investigation.

The report counts the scanned boundary and lists exclusions. A green report is not proof of behavioral, visual, accessibility, or retirement completeness.

## Why the report stays a draft

The difficult part of consolidation is deciding whether two usages with similar syntax have the same intent. RhuBase can collect evidence and reuse only bounded documented candidates; it cannot supply product authority. That is why assessments remain `draft-review`, decisions remain `needs-review`, and `requiredChecks` remain empty until an accountable person defines them.

The controlled assessment verification passes its intended read-only boundary. Migration execution remains blocked by failed independent inference holdouts and the absence of real consumer-level edit and behavior validation.
