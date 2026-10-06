# Security policy

RhuBase is an unreleased alpha. No tagged version currently receives long-term security support; reports are evaluated against the current default branch.

## Report a vulnerability privately

Use the repository’s **Security** tab and choose **Report a vulnerability** to open a private GitHub Security Advisory:

<https://github.com/PetriLahdelma/rhubase/security/advisories/new>

Private vulnerability reporting is enabled. If the link is unavailable, do not publish exploit details or customer data in an issue.

Include the affected command and platform, a synthetic reproduction, expected and observed behavior, potential impact, and whether secrets, path escapes, source execution, output overwrite, or process cleanup are involved.

Do not include credentials, proprietary source, production tokens, or personal data.

## Security boundary

The supported product is read-only. It should not execute consumer modules, package lifecycle scripts, declared CI commands, or inferred migrations. It should not require a model, API key, hosted account, telemetry endpoint, or runtime network access. Output must be new, external to protected inputs, and validated before publication.

An explicitly supplied worker is a trusted operator override and is not an untrusted-code sandbox.

## Disclosure

Please allow maintainers to investigate and prepare a fix before public disclosure. Timing will be coordinated case by case; the project does not promise a response or remediation SLA.
