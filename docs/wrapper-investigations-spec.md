# Wrapper investigation packets

This increment implements RHU-003 using evidence from the 2026-10-18 scenario. It groups supported static relationships for investigation. It does not infer wrapper behavior, propagate effective props or approve migrations.

## Supported relationships

The assessment retains every existing usage, unsupported record and coverage denominator. A new required top-level `wrapperInvestigations` array adds packets without moving call sites into recognized usages or mapping groups.

Initial support: a top-level named exported `const` arrow function whose body directly returns one JSX element from a named import at the root entrypoint of a selected source package. A parenthesized JSX body is allowed. The inner JSX must already be a recognized source usage. Calls can use the wrapper in the same file or a named relative import, optionally through one named relative re-export barrel. Link symbols through the TypeScript binding model. Reject ambiguous module paths, duplicate exports, star exports, cycles, mutable bindings, shadowed identifiers, factories, conditionals, additional statements and multiple selected-source elements. Unsupported cases retain their original warnings. No package or consumer module executes.

Names never establish identity across files or packages. A source-qualified wrapper has one definition and one inner usage in this profile. At most 256 packets, 4096 links and one barrel are admitted. Exceeding a linking bound leaves affected warnings ungrouped. Existing worker response limits still apply.

## Packet contract

Each packet has exactly these fields:

```json
{
  "id": "wrapper:<20 lowercase hex>",
  "revision": "<64 lowercase hex>",
  "sourceId": "<existing selected source ID>",
  "sourceExport": "Button",
  "definition": {"file": "src/Button.tsx", "name": "Button", "evidence": []},
  "innerUsageIds": ["<one recognized usage ID>"],
  "unknownIds": ["<existing unresolved wrapper call-site ID>"],
  "bindingEvidence": [],
  "status": "needs-review",
  "executable": false
}
```

Evidence uses the existing nonempty consumer evidence shape: `scope`, `file`, `sha256`, `startLine`, `endLine`, `quote`. Definition evidence has exactly one item covering the exported declaration. Binding evidence is nonempty and includes the direct selected-source import and the named imports/re-exports linking each call site to the definition. Call-site evidence remains in the referenced unsupported records. Only `wrapper-usage`, `local-reexport-resolution` and `factory-or-alias` warnings may be referenced. The last kind covers calls occurring before a wrapper declaration; it is admitted only when the checker resolves that call to the exact supported wrapper. Actual factories remain ungrouped. Source subpaths, default imports and namespaces remain outside this initial packet profile even where ordinary usage discovery recognizes them. Each unknown ID occurs in at most one packet. IDs and evidence are deduplicated and sorted deterministically. No candidate target or approval is added to a packet. Ownership candidates remain available through the inner usage's existing mapping group.

Packet ID is `wrapper:` plus the first 20 hex characters of SHA-256 over UTF-8 JSON encoding of `[sourceId, sourceExport, definition.file, definition.name]`.

An evidence tuple is `[file, sha256, startLine, endLine, quote]`. Sort tuples by their compact JSON representation using UTF-8 byte ordering. Revision is SHA-256 over compact JSON of `[sourceDigest, definitionEvidenceTuple, sortedBindingEvidenceTuples, sortedUnknownIds, sortedCallSiteEvidenceTuples]`. No whole-repository digest enters the revision: changing only one wrapper definition must change its packet revision while leaving an unrelated packet revision unchanged. Hash changes trigger reinspection, never approval reuse.

## Coordinator and report

Rust validates exact fields, ID/revision recomputation, source and inner-usage coordinates, definition evidence containing the inner usage, allowed unknown references, cross-packet uniqueness and all evidence hashes/ranges/quotes against guarded inputs. Unknown records and coverage remain authoritative and unchanged. Static relationship extraction remains the bundled analyzer's responsibility; the coordinator does not claim a second independent TypeScript implementation.

The normal Markdown assessment adds a linear wrapper-investigation section: definition identity, revision, source package/export, inner usage, all unresolved call-site locations and candidate owners via existing groups. Count definitions separately from call sites. State that effective props, accessibility, providers and behavior require review. Unsupported warnings are still listed in full. No new command, server, dependency or executable handoff is introduced.

## Acceptance

Write failing tests before implementation. The two-source fixture with two wrappers named Button must produce two packets and retain all twelve unresolved call sites. Direct application sites and inner implementation sites remain four recognized usages in total. Definition-only drift changes one revision, with all call-site warning IDs unchanged. Cover aliases, direct and one-barrel imports plus shadowing, ambiguity, reassignment, cycles, star exports and factories. Forged packet evidence, coordinates, revision, unknown IDs, executable flags and duplicate assignment must fail closed. Run the repository verification and release CLI suites. These are controlled engineering tests, not an independent holdout or proof of reduced reviewer effort.
