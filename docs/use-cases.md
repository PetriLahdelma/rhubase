# Use cases

RhuBase is most useful before anyone authorizes application edits. It turns local package and consumer evidence into a shared review artifact while keeping uncertainty visible.

## Consolidating several systems into one

```sh
./bin/rhubase assess ./product \
  --source @legacy/web \
  --source @acquired/ui \
  --source @internal/admin \
  --target @company/foundation \
  --out ../foundation-assessment
```

RhuBase preserves source identity, so two components called `Button` do not become one unsupported assumption. It groups usages by relevant static conditions, shows representative excerpts, and keeps target splits, missing capabilities, styling side effects, wrappers, and dynamic behavior as review work.

Desired outcome: a team can discuss which patterns converge, which need different targets, and which need adapters or deferral without pretending a package diff is a migration plan.

## Preparing a design-system upgrade

Use `assess` when an application already contains the old system and the target version or replacement package is locally available. The report connects package changes with supported consumer usages and highlights declared checks that still need a human to select and run.

Desired outcome: application and design-system maintainers agree on scope and decisions before producing patches.

## Reviewing a breaking package change

```sh
./bin/rhubase infer --from ./old-package --to ./new-package --out ../contract.json
```

Desired outcome: maintainers inspect API facts, documentation-backed candidate mappings, and unresolved surfaces in one non-executable contract.

Inference is narrow and fallible. The two independent holdouts failed; a mapping appearing in a contract is not proof of semantic equivalence.

## Creating a cross-functional review packet

`assessment.md` is meant to be readable by engineering, design, accessibility, and product partners. It includes source locations and excerpts, conditions that distinguish similar-looking usages, candidate owners, and visible coverage gaps.

Desired outcome: reviewers can make or defer decisions with the same evidence instead of passing raw compiler errors or a large JSON file around.

## What RhuBase does not support yet

- editing or migrating application code;
- generating or opening pull requests;
- automatically approving mappings or assigning owners;
- running repository tests, builds, Storybook, visual regression, or accessibility checks;
- tracking rollout waves or proving legacy retirement;
- fetching packages or versions from a registry;
- hosted dashboards, accounts, organization connections, or cloud execution;
- broad framework support beyond the documented static JavaScript/TypeScript boundary; or
- claims of reliable migration coverage on real repositories.

The historical research workflow contains experimental patch generation. It is retained for study and is not the supported RhuBase product path.
