# Provider extensions

Remotish can discover independently installed repository providers without requiring the provider extension to import `@remotish/core` or `@remotish/vscode`.

The supported public dependency for provider authors is `@remotish/adapter-sdk`.

```text
provider adapter ────────┐
                         ▼
                 @remotish/adapter-sdk
                         ▲
                         │
provider extension ──────┘
        │
        │ discovered and lazily activated by
        ▼
   Remotish host
        │
        ├── @remotish/core
        └── @remotish/vscode
```

A provider extension may use VS Code APIs internally for authentication, configuration, bootstrap URI handling, or repository selection. Those implementation details do not enter the SDK contract.

## Provider contract

`@remotish/adapter-sdk` exports `RemotishAdapterProviderV1` alongside `RemotishAdapter`:

```ts
import type {
  RemotishAdapterProviderV1,
  RemotishRepositoryRequest,
} from '@remotish/adapter-sdk';

export async function activate(
  context: vscode.ExtensionContext,
): Promise<RemotishAdapterProviderV1> {
  const auth = createProviderAuthentication(context);

  return {
    apiVersion: 1,
    id: 'bitbucket-cloud',
    displayName: 'Bitbucket Cloud',

    validateRepository(repository) {
      const keys = Object.keys(repository).sort();
      if (keys.join(',') !== 'repository,workspace') {
        throw new Error('Expected workspace and repository only.');
      }
    },

    createAdapter(repository) {
      return new BitbucketAdapter({
        workspace: repository.workspace,
        repository: repository.repository,
        authProvider: auth,
      });
    },

    async restoreWorkspace(workspaceId): Promise<RemotishRepositoryRequest | undefined> {
      return loadProviderOwnedRecord(context, workspaceId);
    },
  };
}
```

The provider interface contains repository semantics only. It does not mention `vscode`, `ExtensionContext`, `RemotishWorkspace`, Remotish filesystem URIs, SCM, commands, or UI.

Provider IDs are normalized to lower case and must remain stable across releases. The provider ID describes repository semantics; the VS Code extension ID identifies the installed implementation. Remotish keeps these identities separate and persists both when it needs routing information for restoration.

## Declarative discovery marker

A provider declares a small marker in its extension manifest:

```json
{
  "remotish": {
    "provider": true,
    "apiVersion": 1,
    "id": "bitbucket-cloud",
    "displayName": "Bitbucket Cloud"
  }
}
```

Remotish reads this marker through `vscode.extensions.all`. Discovery does not call `activate()` and therefore does not trigger authentication.

The marker is routing metadata, not a trust boundary. Adapter construction still requires validation of the extension activation result and provider-specific repository validation. Do not place credentials, network origins, executable paths, Git remotes, or other privileged configuration in discovery metadata.

Two installed extensions may not claim the same provider ID. Remotish rejects the ambiguity instead of choosing based on extension enumeration or installation order.

## Lazy activation

Providers are activated only when they are needed, for example when:

- a bootstrap request opens a repository for that provider;
- a canonical workspace is restored after reload;
- a future provider-specific picker needs runtime provider capabilities.

After activation, Remotish validates:

- `apiVersion`;
- provider `id`;
- `displayName`;
- `validateRepository()`;
- `createAdapter()`;
- optional `restoreWorkspace()`.

The activation result must use the same provider ID as the discovery marker. Unsupported API versions and malformed exports fail before repository access.

## Extension-host placement

The current Remotish → provider boundary consumes the object returned from `extension.activate()`. The provider extension therefore must execute in the same VS Code extension host as the Remotish host extension. This matters for desktop and remote deployments where VS Code may have local, remote, and web extension hosts available.

A browser-only provider with a `browser` entry point and no Node-only entry point already runs in the web extension host and should not add `extensionKind` solely for Remotish. Providers that support multiple runtimes or remote extension hosts must choose compatible placement, using the appropriate manifest/runtime configuration when necessary. If a deployment cannot colocate the provider and Remotish, it needs a cross-host command or messaging boundary rather than relying on the activation return value.

Static Code-OSS Web deployments naturally satisfy this constraint when both Remotish and the provider are browser extensions.

## Provider-to-host commands

Provider extensions do not need a Remotish TypeScript host API. Provider-to-Remotish operations use stable, versioned VS Code commands from the SDK:

```ts
import {
  REMOTISH_ENSURE_REPOSITORY_COMMAND,
  REMOTISH_OPEN_REPOSITORY_COMMAND,
  REMOTISH_REPOSITORY_COMMAND_VERSION,
} from '@remotish/adapter-sdk';

const request = {
  version: REMOTISH_REPOSITORY_COMMAND_VERSION,
  provider: 'bitbucket-cloud',
  repository: {
    workspace: 'acme',
    repository: 'backend',
  },
  branch: 'feature/payments',
};

const prepared = await vscode.commands.executeCommand(
  REMOTISH_ENSURE_REPOSITORY_COMMAND,
  request,
);
```

`remotish.ensureRepository` creates or restores the canonical workspace and returns its URI without navigating. Session-local integrations may use it without restoration support. A provider that intends to navigate to the canonical URI and survive an extension-host restart should implement `restoreWorkspace()` and persist its reconstruction record before `vscode.openFolder` tears down the current workbench context.

`remotish.openRepository` performs the same preparation and then opens the canonical repository root. It requires `restoreWorkspace()` before navigation. The command always opens the root; a request `path` is returned separately as `resourceUri`.

The V1 result shape is:

```ts
{
  version: 1,
  workspaceId: string,
  repositoryId: string,
  branch: string,
  uri: string,
  resourceUri?: string,
}
```

Unknown command versions and unknown fields are rejected.

## Provider-owned restoration data

The provider owns non-secret information needed to reconstruct one repository. A provider might persist:

```ts
{
  version: 1,
  workspaceId: 'bitbucket-cloud-...',
  provider: 'bitbucket-cloud',
  repository: {
    workspace: 'acme',
    repository: 'backend',
  },
}
```

Remotish does not persist that descriptor. The host persists only generic routing metadata needed to locate the responsible provider extension after restart. Mutable workspace state such as the selected branch belongs to the core workspace snapshot and should not be duplicated in provider reconstruction data.

Authentication also remains provider-owned. Provider discovery must not open login UI. Authentication is acquired when repository access or restoration actually requires it.

## Canonical restoration

A canonical reload is provider-driven rather than relying on activation side effects:

```text
filesystem requests remotish://<workspace-id>/...
        ↓
Remotish has no active workspace with that id
        ↓
load generic workspace → provider routing metadata
        ↓
find marked provider extension
        ↓
lazily activate provider extension
        ↓
provider.restoreWorkspace(workspaceId)
        ↓
provider-owned repository descriptor
        ↓
provider.createAdapter(descriptor)
        ↓
RemotishWorkspace.open()
        ↓
recompute and verify stable workspace identity
        ↓
register workspace
        ↓
original filesystem request continues
```

If authentication fails or is cancelled, the restoration attempt fails but persisted Remotish overlay state is not deleted. A later filesystem request can retry restoration.

If the provider extension is missing, Remotish reports that the provider is not installed or enabled. Installing the provider and retrying can restore the same workspace because local overlay state is retained independently.

## Stable workspace identity

Workspace identity remains branch-independent:

```text
lowercase(provider id) + NUL + stable adapter RepositoryInfo.id
        ↓
SHA-256
        ↓
<provider>-<first 32 lowercase hex characters>
```

Restoration always recomputes this value from the recreated adapter. If it differs from the requested canonical workspace authority, restoration fails before registration.

Branch selection follows:

```text
new preparation: explicit branch → persisted selected branch → repository default
canonical restoration: persisted selected branch → repository default
```

A `branch` returned from `restoreWorkspace()` is ignored during canonical restoration so stale provider-owned data cannot overwrite newer core-persisted state. Each branch retains its own overlay state.

## Static web bootstrap

A provider may own a temporary bootstrap URI such as:

```text
remotish-bitbucket://open/?version=1&workspace=acme&repository=backend&branch=main
```

Its bootstrap extension parses and validates that provider-specific URI, authenticates when necessary, then invokes `remotish.ensureRepository`. After it persists its reconstruction record, it opens the canonical `uri` returned by that call directly.

`remotish.openRepository` is the one-step alternative when no provider work is required between preparation and navigation. Do not invoke it after a successful `remotish.ensureRepository` for the same repository, because `openRepository` performs repository preparation itself.

The browser then operates on:

```text
remotish://<stable-workspace-id>/
```

Provider bootstrap data, credentials, and branch names are not embedded in the canonical authority.

A browser/static provider must use a `browser` extension entry point and support virtual workspaces. Repository-semantic code should remain browser-safe and must not depend on Node filesystem/process APIs, native modules, or the Git CLI.

## Refresh and dynamic installation

`remotish.refreshProviders` forces a manifest rescan. Canonical restoration also rescans once when its persisted provider is not currently known, allowing a provider installed during the session to be used on retry.

Discovery caches only extension-host-lifetime metadata and activated provider instances. Provider objects are never serialized.

## Programmatic registration

`@remotish/vscode` retains an internal `RemotishProviderHost.registerProvider()` path for tests, embedded products, and custom Code-OSS distributions. It is not the standard contract for independently installed provider extensions and `@remotish/vscode` is not a public provider-author dependency.

## Provider descriptor security

Every provider validates its own descriptor before adapter creation. For a Bitbucket provider, a typical allowlist would be only:

```text
workspace
repository
```

Unknown provider-specific fields should be rejected. The generic host additionally rejects common secret-looking descriptor keys such as `token`, `password`, `authorization`, `client_secret`, and `private_key`, including equivalent camelCase spellings. This generic check is defense in depth; the provider-specific descriptor allowlist remains the security boundary.

Descriptors are routed strictly by provider ID. One provider is never asked to interpret another provider's reconstruction record.

## Standard provider workflow

For an independently installable provider:

1. Depend on `@remotish/adapter-sdk`.
2. Implement `RemotishAdapter`.
3. Return `RemotishAdapterProviderV1` from the VS Code extension's `activate()`.
4. Add the versioned Remotish discovery marker to the VSIX manifest.
5. Keep repository reconstruction and authentication provider-owned.
6. Use the versioned Remotish commands for bootstrap provider → host operations.
7. Let Remotish own workspace construction, canonical identity, navigation, filesystem, SCM, branches, and history.

The adapter package remains separately reusable without VS Code.
