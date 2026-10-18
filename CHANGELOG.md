# Changelog

All notable changes to RhuBase will be documented here. The project has not published a stable release.

## [Unreleased]

## [0.1.0-alpha.1]

Experimental read-only release. Build from source on macOS; no registry package or hosted account is required.

### Added

- Source-only composition with `compose --init`, pinned project export and semantic scenario comparisons.
- Offline manual composition workspace with editing, branching, undo/redo and project import/export.
- Source-qualified wrapper investigation packets retaining unresolved call sites and definition evidence revisions.

- Illustrated assessment overview, with a full process chart and editable PDF.
- README status badges and optional community funding links.
- RhuBase identity and local checkout wrapper.
- Read-only `assess` workflow for explicitly selected many-source-to-one design-system analysis.
- Static consumer usage inventory with representative evidence and visible unsupported paths.
- Draft JSON and Markdown assessment artifacts, pairwise contracts, and hash manifest.
- Read-only `infer` workflow for local package-snapshot comparison.
- Rust coordinator with bounded worker protocol, validation, cancellation, drift checks, and exclusive output.
- Public getting-started, use-case, architecture, troubleshooting, roadmap, security, support, and community documentation.
- GitHub community health files and continuous verification workflow for the public repository.

### Changed

- Dynamic and spread usages retain documented candidates without selecting an unverified target or rejecting the entire assessment.
- Package and CLI version metadata explicitly identify this prerelease.

- Human assessment reports now distinguish usage conditions, source systems, parser limitations, verification candidates, other lifecycle scripts, and coverage gaps.

### Known limitations

- Browser smoke verification is a separate release gate; its result and tested scope belong in the GitHub release notes. Automated DOM binding tests do not establish browser behavior or accessibility conformance.
- Composition and wrapper investigation support bounded static profiles. They do not prove runtime, theme, provider or accessibility compatibility.

- Assessment publication is currently supported on macOS.
- Consumer discovery is a bounded static JavaScript/TypeScript analysis and does not cover every wrapper, runtime, styling, token, or generated-code pattern.
- Both independent inference holdouts failed their frozen thresholds. Known failures are regression-tested, but migration reliability remains unproven.
- Application migration, verification execution, pull requests, rollout coordination, and retirement proof are not supported product workflows.
