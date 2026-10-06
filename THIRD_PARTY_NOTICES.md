# Third party notices

The root MIT license covers original RhuBase code and documentation. It does not replace the licenses of third-party material or dependencies.

## Historical source fixtures

`experiments/superset-dropdown/input/` and `experiments/superset-dropdown/reference/src/` contain selected Apache Superset source at commit `f85497e69bb37ea6847cd6640062fdc1e145037a`. Superset is licensed under Apache-2.0. Its [license](experiments/superset-dropdown/reference/LICENSE.txt), [NOTICE](experiments/superset-dropdown/reference/NOTICE), and per-file notices are retained. The [fixture manifest](experiments/superset-dropdown/manifest.json) records upstream locations and hashes.

`experiments/superset-dropdown/reference/antd-dropdown.tsx` is from Ant Design 4.9.4 under the [MIT license](experiments/superset-dropdown/reference/antd-LICENSE). These sources are test references; their inclusion is not an endorsement by their projects.

## Dependencies

TypeScript 5.9.3 is installed from npm under Apache-2.0, with its license and third-party notices in the installed package. Node.js and Rust are external prerequisites. Rust dependencies are pinned in `Cargo.lock` and retain their own licenses; inspect `cargo metadata --locked --format-version 1` for dependency license metadata. No compiled binaries, vendored dependencies or node_modules are distributed by this repository. Downstream binary or bundled distributions must include the notices required by their included dependencies.

## Brand assets

The supplied RhuBase vectors retain their Arrow / QuiverAI creator comments. Derived header artwork reuses those supplied paths and records its sources. The project name and logo identify RhuBase; the code license does not imply endorsement of a fork or grant rights to other parties' trademarks.
