# Remotish Web Host Extension

Installable browser-safe Remotish host extension with a fixture-powered demo workspace.

The packaged extension ID is `hrashton.remotish`. Activation returns the versioned provider API documented in [`docs/provider-extensions.md`](../../docs/provider-extensions.md), while the built-in fixture command keeps the browser/VSIX smoke-test composition available.

```text
external provider wrapper ──registerProvider()──┐
                                                ↓
FixtureAdapter ────────────────────────→ Remotish host API
                                                ↓
                                       RemotishWorkspace
                                                ↓
                                       RemotishVsCodeHost
                                                ↓
                                       RemotishHistoryHost
```

Run it from the repository root:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm vscode:web
```

The demo workspace root remains `remotish://fixture-demo/`.

`package.json` is the reference extension manifest for command/menu contributions, `resourceLabelFormatters`, virtual-workspace support and the proposal flags required by the controlled Code-OSS host.

The production bundle is browser/WebWorker-oriented. CI tests both the source extension and the unpacked exact VSIX artifact through `@vscode/test-web`.

See [Getting started](https://github.com/HRAshton/remotish/blob/main/docs/getting-started.md), [Provider extensions](../../docs/provider-extensions.md), and [VS Code integration](https://github.com/HRAshton/remotish/blob/main/docs/vscode-integration.md).
