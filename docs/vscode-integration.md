# VS Code / Code-OSS integration

This guide is for extension or product integrators who already have a `RemotishAdapter` and want to expose it as a native workspace.

## Components

A normal composition uses:

```text
RemotishAdapter
      │
      ▼
RemotishWorkspace       @remotish/core
      │
      ├──────────────► WorkspaceStorage
      │
      ▼
RemotishVsCodeHost      @remotish/vscode
      │
      ├─ remotish:// filesystem
      ├─ remotish-base:// immutable revision filesystem
      ├─ Source Control
      └─ branch/refresh commands
      │
      └──────────────► RemotishHistoryHost (optional)
                        @remotish/vscode-history
```

## 1. Create the host once

Create one `RemotishVsCodeHost` for the extension lifetime:

```ts
const host = new RemotishVsCodeHost();
context.subscriptions.push(host);
```

The host registers the filesystem providers, SCM integration and framework commands. It can hold multiple registered Remotish workspaces.

## 2. Choose persistence

For normal VS Code integration, prefer `StorageUriWorkspaceStorage`:

```ts
const storage = new StorageUriWorkspaceStorage(
  context.storageUri ?? context.globalStorageUri,
  'my-product',
);
```

It stores overlay bytes as SHA-256-addressed blobs and publishes generation manifests only after their referenced blobs exist. It keeps a previous generation and backup pointer for recovery.

Alternatives:

- `MementoWorkspaceStorage` - suitable for small host-managed snapshots;
- `MemoryWorkspaceStorage` from `@remotish/core` - ephemeral state for tests or disposable sessions.

Do not place credentials or adapter secrets in workspace snapshots. Authentication belongs to adapter/client configuration.

## 3. Open the core workspace

```ts
const workspace = await RemotishWorkspace.open(adapter, storage);
```

Opening validates adapter capabilities, reads repository metadata/branches, and restores persisted branch-local working state when available.

## 4. Register a workspace ID

```ts
const unregister = host.registry.register('customer-config', workspace);
context.subscriptions.push(unregister);
```

The workspace ID becomes the URI authority and must be stable enough for resources opened during the current extension session. IDs are normalized to lowercase and must match `[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?`. Do not put secrets in them.

The editable root is:

```ts
createWorkingUri('customer-config')
// remotish://customer-config/
```

The explicit `/` root is intentional. VS Code joins resource paths against the workspace-folder URI.

## 5. Open the virtual workspace

```ts
await vscode.commands.executeCommand(
  'vscode.openFolder',
  createWorkingUri('customer-config'),
  false,
);
```

You can also register the workspace before activation of an already-open `remotish://` folder, as long as your activation events and adapter construction can resolve the corresponding workspace ID.

## 6. Add history/Timeline only when your host supports it

```ts
const history = new RemotishHistoryHost(host);
context.subscriptions.push(history);
```

`@remotish/vscode-history` uses proposal-sensitive APIs (`scmHistoryProvider` and `timeline`). The demo also uses `scmActionButton`. This is appropriate for a controlled Code-OSS distribution that enables those proposals, not an ordinary Marketplace extension without proposal access.

See [Code-OSS integration](code-oss-integration.md) for versioning and distribution constraints.

## Commands and SCM behavior

`RemotishVsCodeHost` owns framework commands for:

- commit & push;
- commit & push with force-with-lease;
- amend & push with force-with-lease;
- stage / unstage path selection;
- revert path / revert all;
- refresh remote head;
- branch switch/create/delete.

The host uses native Source Control resources rather than a custom WebView. Clicking a change opens a revision-pinned diff; **Open File** opens the editable working resource.

Your extension manifest still needs the command/menu contributions you want to expose. `apps/demo-web/package.json` is the reference manifest.

## URI model

Working resources are stable workspace URIs:

```text
remotish://customer-config/README.md
```

Historical/base resources include an immutable revision:

```text
remotish-base://customer-config/README.md?revision=C42
```

This prevents an already-open diff from changing meaning when the branch is refreshed or a new commit is published.

## Resource labels

Contribute `resourceLabelFormatters` for both schemes so VS Code shows useful repository-oriented labels:

```json
{
  "scheme": "remotish",
  "formatting": {
    "label": "${authority}${path}",
    "separator": "/",
    "workspaceSuffix": "Remotish"
  }
}
```

Do the same for `remotish-base`.

## Workspace Trust

Do not copy the demo's trust declaration blindly. The fixture demo can support untrusted workspaces because workspace-controlled data cannot choose request origins, credentials, executable paths, or local commands.

A production adapter must reassess trust if workspace contents/settings can influence:

- authentication or token selection;
- network destinations;
- executable paths or local processes;
- privileged product operations.

Use restricted/limited behavior when appropriate.

## Multi-repository hosts

One `RemotishVsCodeHost` may register multiple workspaces under different IDs. Each `RemotishWorkspace` owns one repository and its branch-local state. Keep adapter credentials and storage namespaces scoped so one repository cannot accidentally read or overwrite another's state.

## Complete reference

See [`apps/demo-web/src/extension.ts`](../apps/demo-web/src/extension.ts) for the smallest complete composition and [`apps/demo-web/package.json`](../apps/demo-web/package.json) for manifest contributions.
