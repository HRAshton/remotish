# Security policy

## Reporting a vulnerability

Use GitHub's private vulnerability reporting:

https://github.com/HRAshton/remotish/security/advisories/new

Do not disclose a suspected vulnerability in a public issue, discussion, pull request, or other public channel.

We aim to acknowledge vulnerability reports within 3 business days and provide an initial assessment within 7 days. Critical vulnerabilities are
prioritized for expedited remediation.

Disclosure timing is coordinated with the reporter. Unless circumstances require otherwise, coordinated public disclosure should normally occur
within 90 days.

## Scope

Security-relevant areas include adapter authentication/transport boundaries, workspace persistence, path handling, remote publication/concurrency controls, VS Code trust behavior, release artifacts, dependency supply chain, and secret leakage.

The example/demo adapters are reference implementations, but vulnerabilities that demonstrate a framework-level boundary failure are still in scope.

## Supported versions

During the 1.0 release-candidate phase, security fixes are made on the actively maintained main line and the latest 1.0 release candidate where practical. After 1.0.0, security fixes target the actively maintained 1.x line and the latest supported release. Older snapshots may require upgrading to receive a fix. See [Support and compatibility](docs/support.md) for the current support matrix.

## Disclosure

Please allow maintainers time to reproduce, assess and prepare a fix before public disclosure. Maintainers should coordinate status and disclosure timing through the private report and credit reporters who want attribution.

Release integrity controls are described in [docs/release-security.md](docs/release-security.md).
Build and release tooling is declared as exact-version root development dependencies. Release-contract tests reject ephemeral package executors, and CI/release use `pnpm install --frozen-lockfile` so the regenerated lockfile is authoritative.
