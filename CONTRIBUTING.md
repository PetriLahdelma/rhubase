# Contributing to RhuBase

Thank you for helping make design-system change safer and easier to review. RhuBase is an early project, so small, well-evidenced contributions are especially useful.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Before opening a change

Search existing issues and use the repository issue templates when available. For a bug, provide the smallest synthetic fixture that demonstrates the behavior. Remove customer code, secrets, tokens, internal URLs, and personal data.

Security vulnerabilities belong in the private process described in [SECURITY.md](SECURITY.md), not a public issue.

## Development setup

```sh
git clone https://github.com/PetriLahdelma/rhubase.git
cd rhubase
npm ci --ignore-scripts
cargo build --release --locked --bin ctrl-shift
npm run verify
```

On macOS, use `npm run test:cli` for the longer release and process-lifecycle suite when your change affects CLI behavior, workers, paths, cancellation, or publication.

## Contribution principles

- Keep assessment and inference read-only unless a separately reviewed proposal changes that boundary.
- Preserve uncertainty. Unsupported analysis must remain visible and must not inflate automatic coverage.
- Treat inferred mappings as draft, non-executable review candidates.
- Do not add network, model, account, telemetry, or registry behavior implicitly.
- Prefer minimal fixtures with exact expected facts and abstentions.
- Keep public documentation honest about failed evaluations and platform limits.
- Avoid new dependencies unless the change clearly needs one and the tradeoff is documented.

## Pull requests

Explain the concrete problem and resulting behavior, supported and unsupported boundaries, validation performed, any new data or execution surface, and remaining risks.

Update documentation and the changelog when user-visible behavior changes. Do not rewrite historical validation results. New evaluation attempts should be preregistered and preserved, including failures.

## Testing

Use the smallest focused test while developing, then run `npm run verify`. Tests must not execute fixture lifecycle scripts, expose secrets, depend on customer repositories, or claim a migration succeeded when only static checks passed.

## Licensing

Contributions are submitted under the project’s [MIT License](LICENSE). Only contribute material you have the right to license. Preserve third-party notices and provenance for fixtures, references, and generated assets.
