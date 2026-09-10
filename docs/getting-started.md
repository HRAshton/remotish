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

The demo uses the deterministic `FixtureAdapter`. It opens the fixture as a `remotish://` workspace and exercises the real Remotish virtual filesystem, Source Control integration, branch UX, history and persistence layers.

Useful actions to try in VS Code:

1. Edit or create a file in the fixture workspace.
2. Open **Source Control** and inspect **Changes**.
3. Open a change to view a diff against the pinned base revision.
4. Stage one or more paths and enter a commit message.
5. Run **Commit & Push**.
6. Switch branches or create a branch from the branch control.
7. Open file Timeline / SCM history when running the controlled host with the required API proposals.

## The minimum composition

A real integration has three parts:

```text
adapter                  framework core                 VS Code host
   │                           │                            │
   ├─ remote reads/writes ───► RemotishWorkspace ───────► VFS + SCM
   │                           │                            │
   └─ repository semantics     └─ overlay + persistence    └─ editor UX
```

The demo composition is intentionally small:

```ts
import { FixtureAdapter } from '@remotish/adapter-fixture';
import { RemotishWorkspace } from '@remotish/core';
import {
  createWorkingUri,
  RemotishVsCodeHost,
  StorageUriWorkspaceStorage,
} from '@remotish/vscode';
import { RemotishHistoryHost } from '@remotish/vscode-history';
import * as vscode from 'vscode';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const host = new RemotishVsCodeHost();
  const history = new RemotishHistoryHost(host);

  const storage = new StorageUriWorkspaceStorage(
    context.storageUri ?? context.globalStorageUri,
    'my-extension',
  );

  const workspace = await RemotishWorkspace.open(new FixtureAdapter(), storage);
  const unregister = host.registry.register('demo', workspace);

  context.subscriptions.push(host, history, unregister);

  await vscode.commands.executeCommand(
    'vscode.openFolder',
    createWorkingUri('demo'),
    false,
  );
}
```

`RemotishHistoryHost` is optional. It is isolated because SCM history and Timeline use proposal-sensitive Code-OSS APIs. The base VFS/SCM host is `RemotishVsCodeHost`.

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
