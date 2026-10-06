# Roadmap

RhuBase’s roadmap is evidence-driven. Items under “next” are validation goals, not promised releases or dates.

## Implemented alpha boundary

- Local Rust CLI with `assess` and `infer`.
- Explicit local, workspace, and bounded installed package selection.
- Read-only React/TypeScript consumer inventory within the documented static boundary.
- Many-source-to-one usage grouping and draft decision reports.
- Bounded TypeScript/token/documentation comparison.
- Strict Rust validation, process cleanup, exclusive output, and portable artifacts.
- Controlled macOS verification for the read-only assessment slice.

## Next evidence gates

1. **Fresh inference holdout.** Freeze the engine before seeing a new corpus and test documentation mapping, abstention, evidence, and supported facts independently. Known-case regression replay does not satisfy this gate.
2. **Representative repository discovery.** Compare RhuBase inventory against independently enumerated usages in real, permissioned repositories. Measure false positives, missed usages, setup time, and interpretation effort.
3. **Maintainer review study.** Ask design-system and application maintainers to use the read-only report, identify seeded blockers, correct draft decisions, and judge whether it saves total effort against their normal workflow and a capable general coding agent.
4. **Linux CI support.** Validate publication, cancellation, package resolution, and common package-manager layouts before claiming general team readiness.

## Candidate product work after evidence

- Maintainer-authored, versioned decision bundles with explicit preconditions and provenance.
- Better supported discovery for wrapper and styling patterns observed in pilots.
- Release-impact review that reuses consumer inventory without claiming daily demand.
- Selected verification execution under an explicit policy, with results distinguished from equivalence claims.
- Small, reviewable migration pilots only after read-only planning and inference gates pass.
- Merged-head rescans, adapters, exceptions, dependencies, and retirement tracking after pilot proof.

## Deliberately deferred

- automatic application migration;
- pull-request campaigns and remote Git hosting integration;
- autonomous AI editing;
- dashboards, hosted accounts, and organization connections;
- registry package acquisition;
- broad framework support;
- Figma synchronization or design-system management; and

## Stop conditions

RhuBase should narrow or stop a direction when independent evaluation shows that it misses important scope, creates excessive correction work, or fails to reduce total human effort versus a strong general-purpose baseline. Passing internal tests alone is not a reason to expand automation.

See [validation status](validation.md).
