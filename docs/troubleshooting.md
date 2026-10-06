# Troubleshooting

## `rhubase` cannot be found

Run the checkout wrapper explicitly:

```sh
./bin/rhubase --help
```

If the release binary is missing, run `cargo build --release --locked --bin ctrl-shift`.

## Node or Rust version errors

RhuBase requires Node.js 22 or newer and Rust 1.93.0. Check with `node --version` and `rustc --version`. The first dependency installation needs network access; runtime assessment and inference do not.

## TypeScript compiler errors

Install dependencies without lifecycle scripts:

```sh
npm ci --ignore-scripts
```

RhuBase expects the pinned TypeScript 5.9.3 identity. A compiler found inside an assessed repository is not trusted automatically. If necessary, select the checkout compiler explicitly:

```sh
./bin/rhubase assess ./app \
  --source @old/ui --target @new/ui \
  --compiler ./node_modules/typescript/lib/typescript.js \
  --out ../assessment
```

## Package cannot be resolved

Selectors must identify a named package in supported workspaces, a bounded installed package, or an explicit local package path. Version selectors such as `@company/ui@5`, registry tags, URLs, and registry acquisition are unsupported.

Conflicting workspace and installed identities, unexpected symlink targets, and unsupported dependency layouts fail closed or remain visible as gaps.

## Output already exists or is inside an input

RhuBase never overwrites output. Choose a new directory whose parent exists and that sits outside the consumer, selected packages, compiler/tool roots, and RhuBase checkout.

## The report found fewer usages than expected

Read **Gaps and unknowns** and the repository coverage section. Static discovery does not currently resolve every wrapper, factory, dynamic import, computed member, style/token reference, generated source, or runtime registry.

Treat the recognized count as the supported numerator, not proof of the total migration denominator. A small synthetic missed-usage fixture is a valuable bug report.

## A documented mapping was not extracted

Candidate extraction uses a bounded documentation grammar. “No candidate extracted” means the parser did not establish a mapping; it does not mean the documentation or migration path is absent. Review the migration guide directly and report a minimal example if the wording should be supported safely.

## An owner is missing

Owners are candidates derived from a bounded CODEOWNERS subset. Unsupported valid globs introduce uncertainty until a later supported match resolves it. Invalid patterns remain gaps. If one group spans files with different final candidates, the group stays unassigned.

## A check is listed as `declared-not-run`

RhuBase read the script name or CI file identity as metadata. It did not run the check and does not claim the check is required or sufficient. Lifecycle and other scripts are separated from verification recommendations.

## The command timed out or was interrupted

RhuBase terminates the worker process group and does not publish a successful report. Use a fresh output path for the next run. Increase `--timeout-ms` only for inputs you trust and understand.

## Getting help

Search existing issues, then use the repository issue chooser with a minimal fixture and sanitized output. See [SUPPORT.md](../SUPPORT.md).
