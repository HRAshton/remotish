# Remotish

[![CI](https://github.com/HRAshton/remotish/actions/workflows/ci.yml/badge.svg)](https://github.com/HRAshton/remotish/actions/workflows/ci.yml)
[![Codecov](https://codecov.io/gh/HRAshton/remotish/graph/badge.svg)](https://app.codecov.io/gh/HRAshton/remotish)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/HRAshton/remotish/badge)](https://scorecard.dev/viewer/?uri=github.com/HRAshton/remotish)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/14965/badge)](https://www.bestpractices.dev/projects/14965)
[![REUSE status](https://api.reuse.software/badge/github.com/HRAshton/remotish)](https://api.reuse.software/info/github.com/HRAshton/remotish)
[![License: 0BSD](https://img.shields.io/badge/license-0BSD-blue.svg)](LICENSE)

**Turn a remote repository-like backend into a native editable VS Code / Code-OSS workspace.**

Implement a small repository adapter for your API, service, database, or object store. Remotish supplies the working tree, virtual filesystem, Source Control UI, diffs, staging selection, branch UX, history, persistence, and concurrency-safe commit/push flow.

No clone. No `.git`. No Git executable at runtime.

```text
Your API / service / storage
            │
            ▼
     RemotishAdapter
            │
            ▼
         Remotish
            │
            ▼
 VS Code / Code-OSS workspace
```

## Why Remotish

| You implement | Remotish provides |
| --- | --- |
| Repository metadata | Editable virtual filesystem |
| Immutable file and tree reads | Working-tree overlay |
| Branch heads | Branch switching and branch actions |
| Commit history | SCM history and file Timeline integration |
| Atomic remote publication | Changes, staged selection, diff and revert |
| Authentication and transport | Persistence and remote-change safety |

The central model is deliberately small:

```text
immutable remote revision + working overlay = visible workspace
```

A successful commit is already published remotely. Remotish does not create local commits, local refs, a Git index, or a push queue.

## Start here

- [Getting started](docs/getting-started.md) - run the browser demo and understand the composition.
- [Core concepts](docs/concepts.md) - the state model, refresh behavior, branches, staging and publication semantics.
- [Build an adapter](docs/adapter-authoring.md) - implement your own backend step by step.
- [Adapter contract](docs/adapter-contract.md) - precise SDK behavior, capabilities, errors and concurrency rules.
- [VS Code integration](docs/vscode-integration.md) - wire a workspace into an extension or controlled Code-OSS build.
- [Documentation index](docs/README.md) - all user, integrator and maintainer documentation.

## Packages

```text
@remotish/adapter-sdk       public adapter contract
@remotish/core              repository workspace and working-tree semantics
@remotish/adapter-fixture   deterministic reference/test adapter
@remotish/vscode            virtual filesystem + native SCM + branch UX
@remotish/vscode-history    native SCM history + file Timeline integration
@remotish/adapter-http      small HTTP protocol example
@remotish/adapter-github    production-style GitHub reference adapter
@remotish/adapter-rpc       transport-neutral, versioned RPC adapter
@remotish/adapter-git-http  Git smart HTTP adapter
extensions/fixture-provider  deterministic demo/reference provider extension
extensions/browser-rpc-provider  authenticated browser-wide RPC provider extension
extensions/github-provider  anonymous public GitHub provider extension
extensions/git-http-provider  HTTPS Git provider for Web and desktop
apps/demo-web               controlled Code OSS Remotish host/demo extension
examples/browser-rpc-bitbucket  Bitbucket Cloud read/write userscript example
examples/browser-rpc-bitbucket-datacenter  Bitbucket Data Center 9.4 userscript example
```

Adapters depend on `@remotish/adapter-sdk`, not on VS Code or core internals.


## Install from Open VSX

For Code OSS clients backed by Open VSX, install **Remotish** (`hrashton.remotish`) and
**Remotish GitHub Provider** (`hrashton.remotish-github-provider`). The GitHub provider declares
the host as an extension dependency. The registry build of Remotish uses only stable VS Code APIs;
SCM History and file Timeline integration stay opt-in for controlled hosts through
`@remotish/vscode-history`.

Open a public repository with the provider URI:

```text
remotish-github://open/v1/octocat/Hello-World
```

## Try the demo

Requirements: Node.js 22 or 24, Corepack, and a Chromium-compatible environment.

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm vscode:web
```

The launcher loads the Remotish host and fixture provider as separate extensions. Run **Remotish Demo: Open Fixture Repository** to open the deterministic fixture through the same provider discovery, canonical workspace, filesystem, SCM, branch and history paths used by real providers.

For a zero-setup public GitHub repository, see the [GitHub provider](extensions/github-provider/README.md). For one authenticated HTTPS Git repository, see the [Git HTTP provider](extensions/git-http-provider/README.md).

## Suitable backends

Remotish fits systems that can expose immutable revisions, repository-relative files, branches and history: source hosting APIs, content repositories, database-backed configuration stores, generated workspaces, internal developer platforms, or custom versioned services.

It is **not** a Git implementation or a compatibility layer for arbitrary local Git workflows. If users need local commits, rebases, merges, tags, Git hooks, or normal Git CLI behavior, use Git instead.

## Project status

Remotish is prepared for a public beta release. The repository is currently pre-1.0. The adapter SDK is intentionally narrow, is published as `@remotish/adapter-sdk`, and is designed to become the long-term compatibility boundary. See [Adapter contract: compatibility](docs/adapter-contract.md#compatibility) before publishing third-party adapters.

## Development, security and supply chain

See [CONTRIBUTING.md](CONTRIBUTING.md) for development commands and [SECURITY.md](SECURITY.md) for vulnerability reporting.

CI covers the supported Node.js 22 and 24 lines, browser execution, packaged VSIX smoke tests, public GitHub integration, and coverage reporting.

Release artifacts are built with pinned dependencies, checksums, CycloneDX SBOM generation and provenance attestations. Details are in [Release security](docs/release-security.md).

Copyright and licensing metadata follows the [REUSE specification](https://api.reuse.software/info/github.com/HRAshton/remotish) and is machine-verifiable.

## Get involved

- [Releases](https://github.com/HRAshton/remotish/releases) - download published releases.
- [Issues](https://github.com/HRAshton/remotish/issues) - report bugs or propose enhancements.
- [Contributing](CONTRIBUTING.md) - development setup and contribution requirements.
- [Security](SECURITY.md) - report suspected vulnerabilities privately.

## License

Remotish is licensed under the [Zero-Clause BSD (`0BSD`) license](LICENSE).
