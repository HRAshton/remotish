# Getting started

This guide gets the repository running, shows the smallest complete Remotish composition, and points you to the right next step for a custom backend.

## Prerequisites

- Node.js 22.x or 24.x.
- Corepack enabled (`corepack enable`) or an equivalent way to run the pinned pnpm version.
- Chromium for the VS Code Web demo.

## Run the complete demo

From the repository root:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm vscode:web
```

The launcher loads the generic Remotish host and `extensions/fixture-provider` as separate browser extensions. Run **Remotish Demo: Open Fixture Repository** to prepare and open the deterministic fixture through the public provider discovery/`remotish.openRepository` path. The resulting canonical `remotish://.../` workspace then exercises the real virtual filesystem, Source Control integration, branch UX, history and persistence layers.

Useful actions to try in VS Code:

1. Run **Remotish Demo: Open Fixture Repository**.
2. Edit or create a file in the fixture workspace.
3. Open **Source Control** and inspect **Changes**.
4. Open a change to view a diff against the pinned base revision.
5. Stage one or more paths and enter a commit message.
6. Run **Commit & Push**.
7. Switch branches or create a branch from the branch control.
8. Open file Timeline / SCM history when running the controlled host with the required API proposals.

## The minimum composition

For an independently installed provider, Remotish keeps the generic host and repository-specific adapter in separate extensions:

```text
provider extension                    Remotish host
      │                                   │
      ├─ RemotishAdapterProviderV1 ──────► provider discovery
      │                                   │
      └─ RemotishAdapter ────────────────► RemotishWorkspace + VFS/SCM/history
```

The host only starts generic infrastructure:

```ts
import { RemotishProviderHost } from '@remotish/vscode';
import { RemotishHistoryHost } from '@remotish/vscode-history';
import * as vscode from 'vscode';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const providers = new RemotishProviderHost(context);
  const history = new RemotishHistoryHost(providers.host);
  context.subscriptions.push(providers, history);
}
```

The provider extension returns the public SDK contract and constructs its adapter only when requested:

```ts
import { FixtureAdapter } from '@remotish/adapter-fixture';
import {
  REMOTISH_ADAPTER_PROVIDER_API_VERSION,
  type RemotishAdapterProviderV1,
} from '@remotish/adapter-sdk';

export async function activate(): Promise<RemotishAdapterProviderV1> {
  return {
    apiVersion: REMOTISH_ADAPTER_PROVIDER_API_VERSION,
    id: 'fixture-provider',
    displayName: 'Fixture Provider',
    validateRepository(repository) {
      const keys = Object.keys(repository).sort();
      if (keys.length !== 1 || keys[0] !== 'repository' || repository.repository !== 'demo') {
        throw new Error('Expected repository=demo only.');
      }
    },
    createAdapter() {
      return new FixtureAdapter();
    },
  };
}
```

The complete fixture provider also implements `restoreWorkspace()` and owns the demo-open command. See [Provider extensions](provider-extensions.md) for the discovery marker, restoration, stable workspace identity, and bootstrap rules. Embedded products can still compose `RemotishWorkspace` and `RemotishVsCodeHost` directly; that lower-level path is documented in [VS Code integration](vscode-integration.md).

## Replace the fixture with your backend

The framework does not require a particular transport. Replace `FixtureAdapter` with an adapter that implements `RemotishAdapter`:

```ts
import type { RemotishAdapter, RemotishCapabilities } from '@remotish/adapter-sdk';

export class MyAdapter implements RemotishAdapter {
  readonly capabilities: RemotishCapabilities = {
    commits: false,
  };

  // Implement repository metadata, immutable reads, branches and history.
}
```

Start read-only. Once metadata, immutable reads, branch heads and history are correct, add `commit()` and set `commits: true`. Add force-with-lease, amend, branch creation and branch deletion only when the remote can honor their exact semantics.

Continue with [Build an adapter](adapter-authoring.md).

## If you already have an HTTP service

The example HTTP adapter demonstrates one straightforward wire protocol:

```ts
import { HttpRemotishAdapter } from '@remotish/adapter-http';

const adapter = new HttpRemotishAdapter({
  baseUrl: 'https://repo.example.internal/api',
  capabilities: {
    commits: true,
    forceWithLease: true,
    createBranch: true,
    deleteBranch: true,
  },
  headers: () => ({ Authorization: `Bearer ${getToken()}` }),
});
```

See the [HTTP adapter README](../adapters/http-example/README.md) for its endpoint and payload contract.

## Next steps

- Read [Core concepts](concepts.md) before implementing publication or refresh behavior.
- Follow [Build an adapter](adapter-authoring.md) for the recommended implementation order.
- Keep [Adapter contract](adapter-contract.md) open as the normative semantic reference.
- Use [Testing adapters](testing-adapters.md) before treating an adapter as production-ready.
- If you own the VS Code extension shell, read [VS Code integration](vscode-integration.md).
