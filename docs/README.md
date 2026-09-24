# Remotish documentation

Remotish is a framework for presenting a versioned remote repository as an editable VS Code / Code-OSS workspace. The documentation is organized by the job a reader is trying to do.

## Adapter authors

Read these in order:

1. [Getting started](getting-started.md) - run the demo and see the minimum composition.
2. [Core concepts](concepts.md) - understand the revision + overlay model and publication rules.
3. [Build an adapter](adapter-authoring.md) - implement a custom backend.
4. [Adapter contract](adapter-contract.md) - use the precise semantic reference while implementing.
5. [Provider extensions](provider-extensions.md) - expose an independently installable provider with automatic discovery.
6. [Testing adapters](testing-adapters.md) - verify contract behavior and edge cases.

If your backend is conventional HTTP, also inspect [`@remotish/adapter-http`](../adapters/http-example/README.md). For a production-style public API integration, inspect [`@remotish/adapter-github`](../adapters/github/README.md).

For a transport-neutral, versioned repository protocol, inspect [`@remotish/adapter-rpc`](../adapters/rpc/README.md).

## VS Code / Code-OSS integrators

- [VS Code integration](vscode-integration.md) - compose `RemotishWorkspace`, `RemotishVsCodeHost`, persistence and optional history.
- [Code-OSS integration](code-oss-integration.md) - stable vs proposed APIs, host-version constraints and Workspace Trust.
- [Architecture](architecture.md) - package boundaries and runtime ownership.
- [Troubleshooting](troubleshooting.md) - common integration and adapter failures.

## Maintainers

- [Development](maintainers/development.md) - local setup, checks and repository conventions.
- [Documentation maintenance](maintainers/documentation.md) - canonical-source and link rules.
- [Release security](release-security.md) - release gates, checksums, SBOM and attestations.

## Reference implementations

| Component | Purpose |
| --- | --- |
| [`@remotish/adapter-fixture`](../packages/adapter-fixture/README.md) | Deterministic behavioral reference used by tests and the demo |
| [`@remotish/adapter-http`](../adapters/http-example/README.md) | Minimal browser-first HTTP mapping |
| [`@remotish/adapter-github`](../adapters/github/README.md) | Authenticated/public GitHub reference adapter |
| [`@remotish/adapter-rpc`](../adapters/rpc/README.md) | Transport-neutral, versioned repository RPC adapter |
| [Bitbucket Browser RPC example](../examples/browser-rpc-bitbucket/README.md) | Read-only Tampermonkey endpoint for Bitbucket Cloud |
| [`apps/demo-web`](../apps/demo-web/README.md) | Complete VS Code Web composition |
