# Remotish

Remotish is the stable-API host extension for remote repository providers. It supplies the virtual
filesystem, Source Control UI, diffs, staging selection, branch UX, persistence, and provider
discovery used by independently installed Remotish provider extensions.

The public extension intentionally uses only stable VS Code APIs. Native SCM History and file
Timeline integration remain available to controlled Code OSS / VS Code hosts through the separate
`@remotish/vscode-history` integration package, but are not required by the Open VSX build.

## Open VSX

Install **Remotish** (`hrashton.remotish`) from Open VSX. To open public GitHub repositories,
install **Remotish GitHub Provider** (`hrashton.remotish-github-provider`); the provider declares
Remotish as an extension dependency, so compatible clients can install the host automatically.

A public repository can then be opened with a folder URI such as:

```text
remotish-github://open/v1/octocat/Hello-World
```

For a browser-hosted Code OSS instance, URL-encode that URI as the outer `folder` value:

```text
https://code-oss.example/?folder=remotish-github%3A%2F%2Fopen%2Fv1%2Foctocat%2FHello-World
```

The provider opens a temporary bootstrap root, registers the anonymous public GitHub repository,
and then switches to the canonical `remotish://<stable-workspace-id>/` workspace.

## Development

Run the repository-controlled demo from the repository root with:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm vscode:web
```

See [Provider extensions](../../docs/provider-extensions.md),
[Getting started](../../docs/getting-started.md), and
[VS Code integration](../../docs/vscode-integration.md).
