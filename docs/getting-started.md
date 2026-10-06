# Getting started

RhuBase currently runs from a local source checkout. It has no hosted service, sign-in flow, registry, or API key requirement.

## Prerequisites

- macOS for the supported assessment publication path;
- Git;
- Node.js 22 or newer;
- Rust 1.93.0; and
- network access while npm and Cargo download dependencies for the first build.

The runtime is local and can be offline after dependencies and the release binary are present.

## Build

```sh
git clone https://github.com/PetriLahdelma/rhubase.git
cd rhubase
npm ci --ignore-scripts
cargo build --release --locked --bin ctrl-shift
./bin/rhubase --help
```

`npm ci --ignore-scripts` installs the pinned TypeScript compiler without executing package lifecycle scripts. Cargo uses the committed lockfile.

## Run the synthetic example

```sh
npm run example:assess
```

The example creates scratch inputs and an external report, then prints its path. Open `assessment.md` first. It demonstrates the report shape with two source systems and one target. It is a controlled fixture, not a benchmark or migration-success claim.

## Assess a repository

Run RhuBase from the checkout and provide explicit package selectors:

```sh
./bin/rhubase assess ../my-app \
  --source @company/legacy-ui \
  --source @company/acquired-ui \
  --target @company/foundation \
  --out ../my-app-assessment
```

Supported selectors are installed package names, workspace package names, and explicit local package paths. The consumer needs a root `package.json`. The output parent must exist, and the selected output directory must not already exist.

RhuBase writes:

- `assessment.md` for human review;
- `assessment.json` for portable structured data;
- `contracts/` with one draft source-to-target contract per source system; and
- `manifest.json` with artifact hashes and sizes.

No application files are changed. RhuBase does not execute package scripts, CI configuration, imported source modules, or inferred migrations.

## Read the report

Review the sections in this order:

1. Confirm the selected package identities and versions.
2. Review coverage gaps and unsupported references before trusting counts.
3. Inspect grouped conditions and representative source excerpts.
4. Treat candidate targets and CODEOWNERS as review prompts, not approvals.
5. Decide which checks are actually required; discovered checks were not run.
6. Keep unresolved retirement, adapter, styling, runtime, visual, and accessibility work visible.

## Compare package snapshots

Use `infer` when you only need a read-only old/new package comparison:

```sh
./bin/rhubase infer \
  --from ../design-system-v4 \
  --to ../design-system-v5 \
  --out ../design-system-contract.json
```

The result is a draft contract. Both independent inference studies failed their frozen acceptance thresholds, so documentation-backed mappings require careful review.

## Verify your checkout

```sh
npm run verify
```

Run the macOS release and process-lifecycle suite separately when changing the CLI boundary:

```sh
npm run test:cli
```
