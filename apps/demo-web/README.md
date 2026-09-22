# Remotish Web Host Extension

Browser-safe Remotish host extension used by the local and packaged Code-OSS Web smoke tests.

The host contains no demo adapter. It discovers independently installed provider extensions from manifest metadata without activating them at startup. Providers consume only `@remotish/adapter-sdk`; provider → host bootstrap operations use the versioned `remotish.ensureRepository` and `remotish.openRepository` commands.

The repository also ships `extensions/fixture-provider` as a separate deterministic demo provider:

```text
Fixture provider extension
  FixtureAdapter + RemotishAdapterProviderV1
                    ↓
             provider discovery
                    ↓
RemotishProviderHost / RemotishVsCodeHost
                    ↓
         filesystem + SCM + history
```

Run from the repository root:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm vscode:web
```

The launcher loads both extensions. Run **Remotish Demo: Open Fixture Repository** to open the fixture through `remotish.openRepository`; the resulting `remotish://.../` authority is the normal stable provider-derived workspace ID, not a demo-only registry key.

See [Provider extensions](../../docs/provider-extensions.md), [Getting started](../../docs/getting-started.md), and [VS Code integration](../../docs/vscode-integration.md).
