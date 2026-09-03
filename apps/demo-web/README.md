# Remotish Demo Web Extension

Complete browser-host composition example for Remotish.

The demo deliberately contains no repository-specific VS Code UI code. It wires:

```text
FixtureAdapter
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

The opened workspace root is `remotish://fixture-demo/`.

`package.json` is the reference extension manifest for command/menu contributions, `resourceLabelFormatters`, virtual-workspace support and the proposal flags required by the controlled Code-OSS host.

The production bundle is browser/WebWorker-oriented. CI tests both the source extension and the unpacked exact VSIX artifact through `@vscode/test-web`.

See [Getting started](https://github.com/HRAshton/remotish/blob/main/docs/getting-started.md) for the walkthrough and [VS Code integration](https://github.com/HRAshton/remotish/blob/main/docs/vscode-integration.md) before adapting this composition to a production extension.
