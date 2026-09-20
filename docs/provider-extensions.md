# Provider extensions

The installable host extension is `hrashton.remotish`. Provider wrappers consume only the supported `@remotish/vscode/provider-api` surface; adapter libraries continue to depend only on `@remotish/adapter-sdk`.

## Host API compatibility

Provider API V1 is compatible only with host API version `1`. Adding optional members with unchanged semantics may remain V1; removing members, changing required arguments, or changing existing semantics requires a new API version.

Provider wrappers must check the activation result before registration:

```ts
const extension = vscode.extensions.getExtension<RemotishExtensionApiV1>('hrashton.remotish');
if (!extension) throw new Error('Remotish host extension is not installed.');
const api = await extension.activate();
if (api.version !== 1) throw new Error(`Unsupported Remotish host API version: ${api.version}`);
```

## Registration

A restoration-capable provider declares both the host dependency and activation for its own bootstrap scheme plus canonical Remotish reloads:

```json
{
  "extensionDependencies": ["hrashton.remotish"],
  "browser": "./dist/extension.js",
  "activationEvents": [
    "onFileSystem:remotish-example",
    "onFileSystem:remotish"
  ],
  "capabilities": {
    "virtualWorkspaces": true
  }
}
```

Registration supplies the provider extension id, provider-specific descriptor validation, and adapter construction:

```ts
const registration = api.registerProvider({
  id: 'example',
  displayName: 'Example Repository',
  extensionId: 'example.remotish-provider',
  validateRepository(repository) {
    const keys = Object.keys(repository).sort();
    if (keys.join(',') !== 'organization,repository') {
      throw new Error('Expected organization and repository only.');
    }
  },
  createAdapter(repository) {
    return new MyAdapter({
      organization: repository.organization,
      repository: repository.repository,
    });
  },
});
```

Disposing this registration prevents new preparation/restoration through that provider. Existing registered workspaces remain alive for the current host session.

## Prepare before navigating

`ensureRepository()` prepares a workspace without calling `vscode.openFolder`. This separation is required so the provider can persist non-secret reconstruction data before navigation tears down the current workbench/extension-host context.

```ts
const result = await api.ensureRepository({
  provider: 'example',
  repository: {
    organization: 'acme',
    repository: 'backend',
  },
  branch: 'feature/payments',
});

await context.globalState.update(`workspace.${result.workspaceId}`, {
  version: 1,
  workspaceId: result.workspaceId,
  provider: 'example',
  repository: {
    organization: 'acme',
    repository: 'backend',
  },
  lastBranch: result.branch,
});

await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.parse(result.uri), false);
```

`openRepository()` is a convenience operation implemented on top of `ensureRepository()`. Provider bootstrap flows should prefer the explicit sequence above when they need to persist reconstruction state.

Repeated or concurrent preparation of the same provider descriptor and branch is safe. Existing registrations are reused. An explicit branch overrides the selected branch; when no branch is supplied, an already selected or persisted branch is preserved.

## Canonical URI and path semantics

`result.uri` is always the canonical repository root:

```text
remotish://<stable-workspace-id>/
```

Provider, repository, branch, credentials, and bootstrap data never remain in that URI. Branch is workspace state and is not part of the authority.

`request.path` is a non-secret resource hint only. It is returned as `result.resourceUri`; it is never passed as the workspace-folder root. Providers may persist/reveal that resource after navigation.

The workspace-ID algorithm is persisted format v1:

```text
lowercase(provider) + NUL + stable repository ID
→ SHA-256
→ <provider>-<first 32 lowercase hex characters>
```

Compatible releases must preserve this format. Restoration supplies the persisted `workspaceId` as `expectedWorkspaceId`; if the recreated adapter reports a repository ID that hashes to a different authority, preparation fails before registration.

## Static bootstrap and reload

A provider owns a temporary bootstrap scheme such as:

```text
remotish-example://open/?version=1&organization=acme&repository=backend&branch=main
```

Serialized bootstrap requests must carry `version: 1`. Unknown versions fail explicitly. Bootstrap URLs contain repository selection only: no tokens, passwords, cookies, Authorization values, client secrets, publisher credentials, service origins, or arbitrary Git remotes.

The canonical static flow is:

```text
provider bootstrap activation
→ authenticate
→ register provider
→ ensureRepository()
→ persist provider-owned descriptor
→ open returned remotish:// URI
```

On reload of `remotish://<id>/`, both host and provider activate through the filesystem scheme. The host persists only generic `workspaceId → provider extension id` activation metadata; the provider owns the actual repository descriptor. The filesystem waits for restoration for a bounded period rather than immediately failing an unknown authority.

The provider activation path reads its persisted descriptor for the current canonical workspace, authenticates, registers itself, and calls:

```ts
await api.ensureRepository({
  ...persistedRequest,
  expectedWorkspaceId: persisted.workspaceId,
});
```

A delayed registration unblocks only that workspace's pending filesystem requests. Timeouts/cancellation fail visibly, and a failed attempt does not poison later retries. Authentication failure or cancellation must not delete persisted Remotish overlay data.

Authentication is always reacquired normally. Knowledge of a workspace ID is never authorization.

## Provider bootstrap security

Provider validation is responsible for allowed/required descriptor keys, maximum lengths, character constraints, and unknown keys. Untrusted bootstrap data may select repository identity only. API/auth/publisher origins and deployment allowlists belong to trusted extension configuration.

Provider wrappers for static Code-OSS must be browser extensions and must not depend on Node filesystem/process/network modules, native modules, or Git CLI wrappers. Static deployments must support preinstalling the host and provider VSIX files without Marketplace access.
