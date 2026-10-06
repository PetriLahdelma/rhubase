# Validation status

RhuBase has strong regression coverage for its bounded, read-only behavior. It does **not** yet have evidence that inferred mappings generalize reliably to new design systems, that generated migrations are correct, or that the product is ready to modify a real application.

## Independent inference studies

Two preregistered synthetic holdouts evaluated the package-snapshot inference engine. Both remain **NO GO** under the thresholds frozen before execution.

| Study | Cases passing every frozen assertion | Key observed metrics | Decision |
| --- | ---: | --- | --- |
| Original blind study | 5/20 | 70.27% fact precision; 89.66% fact recall; 80% required abstention; 50% documented mapping recall | **NO GO** |
| Post-reveal follow-up holdout | 14/18 | 96.43% fact precision; 96.43% fact recall; 100% required abstention; 20% documented mapping recall | **NO GO** |

The frozen thresholds were:

- at least 99% supported-fact precision;
- at least 95% supported-fact recall;
- 100% evidence and target validity;
- 100% required abstention;
- at least 80% recall for explicit, unambiguous documented mappings;
- 100% of normalization and no-change cases; and
- zero executable proposals.

The original study also exposed defects in its independent evaluator and expectations. Post-reveal adjudication corrected the interpretation without changing the sealed score. Genuine engine failures still missed the frozen thresholds. The follow-up used new cases and a repaired evaluator; it still failed precision and documented-mapping recall.

The released study inputs are available under [`validation/inference-blind/`](../validation/inference-blind/) and [`validation/inference-followup-v2/`](../validation/inference-followup-v2/). They are synthetic package snapshots. They are not customer repositories or application-migration tests.

## What passing tests mean

Development and regression tests establish behavior on known controlled inputs. They cover deterministic snapshot extraction, strict evidence validation, read-only consumer inventory, process cleanup, terminal behavior, and rejection of forged assessment results. Replaying a previously revealed failure can show that a specific defect did not return; it cannot estimate performance on unseen systems.

The current regression suite includes repairs for failures revealed by both holdouts. Those repairs do not rescore either study. A new reliability claim requires a fresh, independently frozen holdout whose answers are unavailable during implementation.

## Consumer assessment boundary

The consumer-assessment workflow is read-only and produces `draft-review` artifacts. Controlled tests show that it preserves supported usage evidence and reports unsupported patterns rather than silently claiming coverage. In the inspectable two-source fixture, only one of nine usage groups received a documentation-backed target candidate. This is evidence for review-oriented inventory and report generation, not migration automation.

RhuBase has not demonstrated:

- safe automatic migration of a real application;
- visual, accessibility, or runtime equivalence after a migration;
- customer acceptance or economic value;
- reliable inference on a fresh independent corpus; or
- an end-to-end pull-request workflow.

## Reproducing current repository gates

From a clean checkout with the documented Node.js and Rust prerequisites:

```sh
npm ci --ignore-scripts
cargo fetch --locked
npm run verify
```

On macOS, the longer CLI and process-lifecycle suite is separate:

```sh
npm run test:cli
```

These commands are software regression gates. Their success must not be reported as a passing inference holdout or as proof of migration correctness.

## Next evidence needed

Before RhuBase makes a reliability claim, run another preregistered holdout over unseen package pairs and retain every failure. Before enabling migration execution, add real application behavior checks, human review outcomes, accessibility and visual evidence, and repository-level safety validation. Until then, keep assessment and inference non-executable and review-required.
