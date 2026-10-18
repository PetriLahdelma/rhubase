# RhuBase

RhuBase is a free, open-source project for design-system maintainers and application developers. Its long-term purpose is to help teams understand existing systems, compose a shared foundation, and prepare applications to move onto it. Today it offers bounded, read-only local assessment and package comparison plus an experimental manual-composition preview, with explicit unknowns and draft review reports.

The project is distributed through GitHub and installed locally. Core use requires no account, hosted service, API key, model provider or sign-in. Initial dependency installation needs network access; the supported runtime performs no registry acquisition or model calls. There is no monetization, billing or cloud-function product scope.

The initial audience maintains React/TypeScript applications and shared component libraries. The first useful results are inspectable reports: one identifies supported consumer usages and unresolved migration decisions; another compares manually selected foundation scenarios before a consumer or target package exists. Composition preserves source identity, rationale, blockers, and proposed architecture obligations without generating files or claiming compatibility. Customer-facing claims must follow [validation status](docs/validation.md).

The manual composer includes source-only intake, an offline editing workspace, and semantic scenario comparisons. It keeps edits distinct from CLI-validated findings and lets users export pinned projects for another review run.

Consumer assessments also organize supported static wrapper relationships into investigation packets. These retain every unresolved call site and bind the packet revision to its definition and import evidence. They help locate review work without claiming to understand wrapper behavior.

The product direction is staged. Manual composition must first prove that teams can record and compare decisions reliably. Assisted recommendations, delegated planning, target generation, and consumer migration each require separate evidence and authority controls before they become product capabilities. These gates limit claims and automation; they do not prohibit building and testing useful manual planning tools.

The community goal is to earn peer recommendations through useful examples, reproducible behavior, responsive documentation and contributor-friendly workflows. Daily activity is not a goal: migrations are often episodic.

The current identity is RhuBase with a rhubarb mark whose red and green strokes retain a visible gap. The tagline is **Many systems. One foundation.**
