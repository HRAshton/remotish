# Security policy

## Reporting a vulnerability

Please do **not** disclose a suspected vulnerability in a public issue, discussion, pull request, or other public channel.

Use GitHub's private vulnerability reporting / security-advisory flow for this repository when it is available (**Security → Report a vulnerability**). If that UI is not enabled, contact the repository maintainers through a private channel listed on the maintainer's GitHub profile and include the repository name in the subject/context.

Include enough information to reproduce and assess the issue:

- affected version/commit;
- affected package or extension component;
- prerequisites and environment;
- reproduction steps or a minimal proof of concept;
- expected vs actual security boundary;
- impact you believe is possible;
- any suggested mitigation, if known.

Do not include real credentials, tokens, private repositories, or unrelated user data in a report.

## Scope

Security-relevant areas include adapter authentication/transport boundaries, workspace persistence, path handling, remote publication/concurrency controls, VS Code trust behavior, release artifacts, dependency supply chain, and secret leakage.

The example/demo adapters are reference implementations, but vulnerabilities that demonstrate a framework-level boundary failure are still in scope.

## Supported versions

Until the project reaches a stable 1.x support policy, security fixes are made on the actively maintained main line and the latest released pre-1.0 version where practical. Older snapshots may require upgrading to receive a fix.

## Disclosure

Please allow maintainers time to reproduce, assess and prepare a fix before public disclosure. Maintainers should coordinate status and disclosure timing through the private report and credit reporters who want attribution.

Release integrity controls are described in [docs/release-security.md](docs/release-security.md).
Build and release tooling is declared as exact-version root development dependencies. Release-contract tests reject ephemeral package executors, and CI/release use `pnpm install --frozen-lockfile` so the regenerated lockfile is authoritative.
