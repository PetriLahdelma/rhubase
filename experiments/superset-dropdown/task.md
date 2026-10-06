# Bounded source migration task

This is an exploratory migration of three public Superset source files. It is not a full application upgrade. Only change files under `src/`; reference files are read-only documentation.

Replace the two `DropdownButton` usages imported from `react-bootstrap` with `Dropdown` imported from `src/common/components`. That barrel re-exports Ant Design; use the pinned Ant Design 4.9.4 API in `reference/antd-dropdown.tsx`, not the unrelated similarly named wrapper in `reference/src/common/components/Dropdown.tsx`.

Requirements:

1. Put the existing menu subtree in the target's `overlay` prop. Preserve its contents, keys, conditions and click handlers, including the selected-item styling.
2. Use click triggering and an actual native `button` with `type="button"` as the trigger. Preserve the title content. Add an accessible label where the title contains only an icon. Preserve the existing IDs, test hooks and useful classes on appropriate elements.
3. Remove Bootstrap-only dropdown props. Preserve right alignment using supported target placement where the source requests it.
4. In DisplayQueryButton, preserve controlled visibility and its close-on-menu-click behavior. Use the target's `visible` and `onVisibleChange` API; do not simply delete the existing state or callback.
5. Account for the dashboard focus wrapper's containment-based outside-click handling. Prefer a supported `getPopupContainer` that keeps the popup within the trigger's parent so those existing checks remain valid. Explain any remaining browser-level uncertainty rather than claim it tested.
6. Preserve unrelated component behavior, existing callbacks, data fetching, cleanup/listener logic, and license headers. Do not modify dependency manifests, tests, configuration or references.

You may inspect and edit the provided public files using file tools. No application packages are installed here; no shell, browser or full application tests are available to either source-only treatment. Do not claim compilation, browser behavior, accessibility, merge readiness or time savings. In the final response, summarize changes and remaining checks. If a requirement cannot be satisfied from the evidence, leave it explicit.

The historical merged output and the evaluation program are withheld from the agent workspace. This task states the intended semantics, not the desired exact patch.
