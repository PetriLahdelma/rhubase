<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/rhubase/header-dark.svg">
    <img src="assets/brand/rhubase/header-light.svg" alt="RhuBase — Many systems. One foundation." width="720">
  </picture>
</p>

[![Local checks](https://github.com/PetriLahdelma/rhubase/actions/workflows/ci.yml/badge.svg)](https://github.com/PetriLahdelma/rhubase/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-2D734D)](LICENSE)
[![Status: alpha](https://img.shields.io/badge/status-alpha-B65C22)](docs/validation.md)
[![Platform: macOS](https://img.shields.io/badge/platform-macOS-555555?logo=apple&logoColor=white)](docs/getting-started.md)

[Get started](docs/getting-started.md) · [Use cases](docs/use-cases.md) · [Contribute](CONTRIBUTING.md) · [Discussions](https://github.com/PetriLahdelma/rhubase/discussions)

RhuBase is an open-source, local-first tool for understanding design-system consolidations and migrations. It can inventory supported component usage against a selected target, and its experimental composition preview can compare manual options for a new shared foundation before a consumer or target exists.

RhuBase is an alpha. Its supported workflows are read-only: it does not edit applications, run repository scripts, call an AI service, fetch packages from a registry, or open pull requests. Migration execution is not ready. Two independent inference holdouts missed their frozen thresholds; the known failures are regression-tested, but reliability on new systems remains unproven.

## What works today

- **Consumer assessment:** inspect one local React/TypeScript consumer, one or more explicitly selected source packages, and one target package.
- **Experimental composition preview:** bind two to eight local source packages and compare manual shared-foundation scenarios without creating a target or changing a source.
- **Offline composition workspace:** start from source packages, browse their capabilities, edit and branch manual scenarios, and download projects for CLI validation.
- **Many-to-one consolidation view:** group supported usages by migration-relevant conditions while preserving source-system identity.
- **Wrapper investigation packets:** link supported wrapper definitions to unresolved call sites with evidence and a revision that changes when their inputs change. Original warnings remain visible.
- **Draft contract inference:** compare two immutable local package snapshots, including supported TypeScript exports, props, tokens, and selected migration documentation.
- **Review artifacts:** write portable JSON, human-readable Markdown, pairwise contracts, evidence, coverage gaps, and an artifact manifest.
- **Fail-visible analysis:** keep wrappers, dynamic access, spreads, style side effects, unsupported CODEOWNERS patterns, and other blind spots in the report.

Every assessment is `draft-review`, every assessment decision remains `needs-review`, and planning exports cannot authorize source changes. The offline workspace runs only RhuBase's bundled editor code.

## From many systems to a shared review

[![RhuBase assessment: choose systems, inventory supported usages, compare documented options, group decisions, surface open questions, and prepare a draft for human review.](docs/assets/rhubase-process-overview.svg)](docs/assets/rhubase-process.svg)

Read each column from top to bottom. Select your app, its source systems, and a target reference; RhuBase gathers evidence and prepares a draft. Your team decides which changes to pursue.

[Full process chart](docs/assets/rhubase-process.svg) · [Editable PDF](docs/assets/rhubase-process.pdf) · [How it works](docs/how-it-works.md)

## Install from GitHub

RhuBase is not published to npm or crates.io. Build it from this repository:

```sh
git clone https://github.com/PetriLahdelma/rhubase.git
cd rhubase
npm ci --ignore-scripts
cargo build --release --locked --bin ctrl-shift
./bin/rhubase --help
```

Requirements:

- macOS for the currently supported assessment publication path;
- Node.js 22 or newer;
- Rust 1.93.0; and
- network access during the initial dependency download.

After dependencies are present and the binary is built, assessment, inference, and the composition preview run locally without an AI service, API key, account, or network connection.

## Try the controlled examples

```sh
npm run example:assess
npm run example:compose
```

Each command uses a controlled local fixture, creates a fresh output in scratch space, and prints the report path. The examples are safe to inspect and useful for learning the report formats. They are not evidence that RhuBase is reliable on real repositories.

## Compare composition options

Start without writing a project file:

```sh
./bin/rhubase compose --init --target @example/foundation \
  --source a=examples/composition/a \
  --source b=examples/composition/b \
  --source c=examples/composition/c \
  --out ../rhubase-workspace
```

Open the output's `workspace.html` locally to select contributions and explore alternatives. Download your edited project, then run the CLI again for current findings. No server or account is needed.

Or inspect the prepared comparison:

```sh
./bin/rhubase compose \
  --project examples/composition/project.json \
  --source a=examples/composition/a \
  --source b=examples/composition/b \
  --source c=examples/composition/c \
  --out ../rhubase-composition
```

The project records manual selections, rationale, dependencies, and architecture choices. RhuBase returns a non-executable draft with blockers and checks that remain unrun. It does not recommend or generate a target, and it does not claim component, theme, consumer, or migration compatibility. See [composition preview](docs/composition.md).

## Assess a local consumer

```sh
./bin/rhubase assess ./consumer-app \
  --source @company/legacy-web \
  --source @company/legacy-admin \
  --target @company/foundation \
  --out ../consumer-assessment
```

Sources and target may be workspace package names, installed package names, or explicit local package paths. Registry downloads and version selectors are intentionally unsupported. The output directory must be new and outside protected inputs.

The report separates observations from decisions. It shows supported usage patterns, representative source excerpts, candidate owners, documentation-backed target candidates, declared-but-unrun checks, and gaps that still need investigation. A missing candidate means the bounded parser did not establish one; it does not mean guidance or a valid migration path is absent.

## Compare two package snapshots

```sh
./bin/rhubase infer \
  --from ./design-system-v4 \
  --to ./design-system-v5 \
  --out ../migration-contract.json
```

Inference produces a draft, non-executable contract. Documentation proposals require review. The original blind evaluation and independent follow-up both failed, primarily because documentation mapping did not generalize sufficiently. See [validation status](docs/validation.md) before relying on inferred mappings.

## Verify a checkout

```sh
npm run verify
```

On macOS, the longer CLI and process-lifecycle suite is available separately:

```sh
npm run test:cli
```

See [validation status](docs/validation.md) for the failed holdouts, the passing controlled assessment boundary, and the remaining evidence gaps. Passing development tests establishes the tested boundary; it does not establish migration correctness or customer readiness.

## Documentation

- [Getting started](docs/getting-started.md)
- [Use cases](docs/use-cases.md)
- [How it works](docs/how-it-works.md)
- [Composition preview](docs/composition.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Roadmap](docs/roadmap.md)
- [Documentation index and historical research](docs/README.md)

## Community

RhuBase is early, and thoughtful issue reports are more valuable than hype. Bring a small reproducible fixture, explain the expected result, and include the report’s visible gaps. Please read [CONTRIBUTING.md](CONTRIBUTING.md), [SUPPORT.md](SUPPORT.md), and the [Code of Conduct](CODE_OF_CONDUCT.md).

Security reports should follow [SECURITY.md](SECURITY.md).

## Support RhuBase

RhuBase is free and open source. If you find it useful, optional donations help support its development. Bug reports, useful fixtures, documentation, and sharing the project are welcome contributions too.

[![Buy Me a Coffee](https://img.shields.io/badge/Buy_Me_a_Coffee-FFDD00?logo=buymeacoffee&logoColor=000000)](https://buymeacoffee.com/petrilahdey)

## License

Original RhuBase code is available under the [MIT License](LICENSE). Third-party fixtures, references, and generated artifacts retain their own notices and terms where stated.
