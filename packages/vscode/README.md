# @remotish/vscode

Native VS Code / Code-OSS integration for Remotish.

This package provides:

- editable `remotish://` and immutable `remotish-base://` filesystem providers;
- native Source Control groups, diffs and staging selection;
- commit, revert and refresh commands;
- branch UI and branch commands;
- VS Code-backed workspace persistence;
- a registry for one or more `RemotishWorkspace` instances.

Minimal host setup:

```ts
import { RemotishWorkspace } from '@remotish/core';
import {
  createWorkingUri,
  RemotishVsCodeHost,
  StorageUriWorkspaceStorage,
} from '@remotish/vscode';

const host = new RemotishVsCodeHost();
const storage = new StorageUriWorkspaceStorage(
  context.storageUri ?? context.globalStorageUri,
  'my-extension',
);
const workspace = await RemotishWorkspace.open(adapter, storage);
const registration = host.registry.register('repo', workspace);

context.subscriptions.push(host, registration);
```

SCM history and per-file Timeline integration live separately in `@remotish/vscode-history` because those APIs are proposal/version-sensitive.

See [`docs/vscode-integration.md`](../../docs/vscode-integration.md) for complete composition and manifest guidance.
