# Remotish Web Host Extension

Browser-safe Remotish host extension plus the fixture-powered smoke-test workspace.

The host discovers independently installed provider extensions from manifest metadata without activating them at startup. Providers consume only `@remotish/adapter-sdk`; provider → host bootstrap operations use the versioned `remotish.ensureRepository` and `remotish.openRepository` commands.

The bundled fixture remains available for local and packaged VS Code Web smoke tests:

```text
FixtureAdapter
      ↓
RemotishWorkspace
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

The fixture workspace root is `remotish://fixture-demo/`. Production providers are discovered lazily and are not required to import `@remotish/vscode` or `@remotish/core`.

See [Provider extensions](../../docs/provider-extensions.md), [Getting started](../../docs/getting-started.md), and [VS Code integration](../../docs/vscode-integration.md).
