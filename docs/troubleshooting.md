# Troubleshooting

## The workspace opens read-only

Check `adapter.capabilities.commits`. When it is `false`, Remotish deliberately blocks working-tree mutations. If it is `true`, the adapter must implement `commit()` or `RemotishWorkspace.open()` will reject the adapter contract.

## `Invalid adapter contract`

The adapter advertised a capability without satisfying its dependency or method requirement. Common causes:

- `commits: true` without `commit()`;
- `forceWithLease: true` while `commits` is false;
- `amend: true` without `forceWithLease`;
- branch mutation capability without the corresponding method.

See [Adapter contract: capabilities](adapter-contract.md#capabilities).

## Diffs show unexpected content after refresh

Revision resources are expected to be immutable. Confirm your adapter is not using branch names, mutable aliases, or a "latest" identifier as `RevisionId`.

## Refresh says the workspace is pinned

This is expected when the remote branch moved while local working changes exist. Remotish preserves the old base and overlay rather than silently rebasing or discarding local work. Commit/reconcile the changes deliberately before rebinding to the newer remote head.

## A normal commit is rejected with `REMOTE_CHANGED`

The remote branch moved after the workspace pinned its base. Refresh a clean workspace, or explicitly choose a force-with-lease workflow if the adapter supports it and replacing remote history is intentional.

Do not work around this by implementing an unconditional force update in the adapter.

## Binary files are corrupted

Check for an implicit UTF-8 conversion in the adapter or transport. `readFile()` and add/modify `Change.content` are bytes (`Uint8Array`). JSON protocols need an explicit binary encoding such as base64.

## History or Timeline does not appear

`@remotish/vscode-history` depends on proposed Code-OSS APIs. Confirm the controlled host/extension manifest enables `scmHistoryProvider` and `timeline`, and that the proposal declarations match the exact target VS Code/Code-OSS version. See [Code-OSS integration](code-oss-integration.md).

## Workspace state does not survive restart

Confirm you supplied a persistent `WorkspaceStorage` to `RemotishWorkspace.open()`. The default is `MemoryWorkspaceStorage`, which is intentionally ephemeral.

For VS Code, prefer `StorageUriWorkspaceStorage(context.storageUri ?? context.globalStorageUri, namespace)`.

## The extension works from source but not from the VSIX

Run the packaged artifact gate:

```bash
corepack pnpm test:vscode-web:vsix
```

It packages the VSIX, inspects its contents, unpacks that exact artifact and runs the Code-OSS Web smoke path against it.

## Requests continue after cancellation

Pass `RemoteRequestOptions.signal` through every adapter/client layer. With `fetch`, forward it as `RequestInit.signal`. For SDKs that do not accept an `AbortSignal`, stop downstream work as early as the SDK permits and classify explicit cancellation as `CANCELLED`.
