# RhuBase documentation

RhuBase is an alpha, local-first design-system assessment tool. These public guides describe the supported read-only product boundary.

| Guide | Purpose |
| --- | --- |
| [Getting started](getting-started.md) | Install from GitHub, run the synthetic example, and assess a local consumer. |
| [Use cases](use-cases.md) | Understand where the current tool helps and where it does not. |
| [How it works](how-it-works.md) | Follow package resolution, static discovery, inference, validation, and publication. |
| [Troubleshooting](troubleshooting.md) | Resolve setup, selector, compiler, output, and coverage problems. |
| [Validation](validation.md) | Read the failed holdout results, current verified boundary, and remaining evidence gaps. |
| [Roadmap](roadmap.md) | See what is implemented, what evidence comes next, and what remains speculative. |
| [Contributing](../CONTRIBUTING.md) | Set up development, write useful fixtures, and submit reviewable changes. |

Earlier numbered research documents and machine-specific validation archives remain part of the local project history but are not bundled into the public repository. Public documentation does not imply that complete historical logs or archives are available online.

The released synthetic inference corpora used by current regression tests are retained at:

- `validation/inference-blind/corpus.json`
- `validation/inference-followup-v2/corpus.json`

Those known corpora support regression testing. They are not fresh holdouts and do not establish generalization.
