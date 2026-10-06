# Changelog

All notable changes to RhuBase will be documented here. The project has not published a stable release.

## [Unreleased]

### Added

- RhuBase identity and local checkout wrapper.
- Read-only `assess` workflow for explicitly selected many-source-to-one design-system analysis.
- Static consumer usage inventory with representative evidence and visible unsupported paths.
- Draft JSON and Markdown assessment artifacts, pairwise contracts, and hash manifest.
- Read-only `infer` workflow for local package-snapshot comparison.
- Rust coordinator with bounded worker protocol, validation, cancellation, drift checks, and exclusive output.
- Public getting-started, use-case, architecture, troubleshooting, roadmap, security, support, and community documentation.
- GitHub community health files and continuous verification workflow for the public repository.

### Changed

- Human assessment reports now distinguish usage conditions, source systems, parser limitations, verification candidates, other lifecycle scripts, and coverage gaps.

### Known limitations

- Assessment publication is currently supported on macOS.
- Consumer discovery is a bounded static JavaScript/TypeScript analysis and does not cover every wrapper, runtime, styling, token, or generated-code pattern.
- Both independent inference holdouts failed their frozen thresholds. Known failures are regression-tested, but migration reliability remains unproven.
- Application migration, verification execution, pull requests, rollout coordination, and retirement proof are not supported product workflows.
