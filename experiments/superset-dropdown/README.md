# Superset dropdown reference fixture

This directory retains selected public source from a historical Apache Superset dropdown migration. It supports known-case regression tests; it is not a supported application-migration example or a measure of accuracy on unseen applications.

- `input/`: unchanged consumer source from the pinned Superset revision.
- `reference/`: original API references, license texts and notices.
- `manifest.json`: upstream URLs and exact content hashes.
- `task.md` and `registration.json`: historical experiment context.

Check the retained source with `node scripts/verify-source-inputs.mjs`. Local historical run artifacts and after-code are not distributed in this repository. The supported local example is `npm run example:assess`; see the [getting-started guide](../../docs/getting-started.md) and [validation limitations](../../docs/validation.md).

Superset sources retain their Apache-2.0 license and NOTICE; the pinned Ant Design source retains its MIT license. Neither these sources nor a historical upstream PR establish that RhuBase safely migrates applications.
