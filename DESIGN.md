# RhuBase design

## Current surfaces

The current product surfaces are a local CLI, generated Markdown/JSON assessment reports, and GitHub documentation. The supported workflow is read-only and remains an alpha; see [validation status](docs/validation.md).

## Brand

Use **RhuBase** and **Many systems. One foundation.** The supplied [gap variation 1](assets/brand/rhubase/gap-variants/rhubase-gap-1.svg) is the basis for the repository header. Preserve the separation between the two rhubarb strokes. The header uses outlined logo and tagline paths for predictable GitHub rendering without font downloads.

- Crimson: `#E31238`.
- Leaf green: `#74B61B`.
- Light-theme ink: `#111618`.
- Dark-theme ink: `#F4F5F1`.
- Header background: transparent in both themes.

Use [header-light.svg](assets/brand/rhubase/header-light.svg) and [header-dark.svg](assets/brand/rhubase/header-dark.svg) through a GitHub-compatible picture element. Brand colors identify the project; checks must retain textual statuses so color never implies approval.

## Documentation

The README serves readers deciding whether the tool is useful and how to try it. Keep the first command reproducible from a clean checkout. Explain what works, show realistic use cases, and distinguish plans from implemented behavior. Prefer GitHub's own headings, code blocks, tables and links; no animation, decorative dashboards or promotional metrics.

The main text should be welcoming, concise and candid. Synthetic examples are teaching materials, not migration-accuracy benchmarks. Avoid claims of safe automatic migration, verified accessibility, or arbitrary-repository completeness.

## CLI and reports

The public local entry point is `bin/rhubase`; the underlying Rust coordinator and compatibility JSON identifiers retain their historical names. Preserve terminal color controls, plain output, quiet mode, bounded diagnostics and machine-readable output.

Group usages by source and relevant conditions. Show representative source evidence, candidate owners and unresolved questions. Keep missing, unsupported, not-run and failed states distinct from passed checks. Never equate a generated report with approved execution.

## Community experience

Core use stays local and account-free. Reports are portable files. Contributions should have a clear problem, a small reproducible example and appropriate tests. The project does not require a cloud account, CLA workflow, donation or subscription to participate.

## Accessibility and review

Provide alternative text for the header, readable contrast on GitHub light and dark themes, meaningful link text and linear document structure. Use the symbol alone for eventual tiny icons; the full lockup is not a favicon. Rendering at actual small sizes remains a separate validation task.

Earlier design notes are preserved locally with historical research and are not the current product contract.
