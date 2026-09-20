# Provider extensions

The installable Remotish host extension is `hrashton.remotish`. Its activation result exposes a small, versioned provider API so independently distributed VS Code extensions can register adapters without importing Remotish internals.

Provider-specific adapter libraries should continue to depend only on `@remotish/adapter-sdk`. A VS Code wrapper may depend on the adapter package and use `@remotish/vscode/provider-api` for the host contract.

```text
provider adapter package
        ↓
@remotish/adapter-sdk

provider VS Code wrapper
        ↓
installed hrashton.remotish host API
```

## Register a provider

Declare the host as an extension dependency in the provider wrapper manifest:

```json
{
  "extensionDependencies": ["hrashton.remotish"]
}
```

Activate the host and register the provider:

```ts
import type { RemotishExtensionApiV1 } from '@remotish/vscode/provider-api';
import * as vscode from 'vscode';
import { MyAdapter } from '@example/remotish-adapter';

export async function activate(): Promise<vscode.Disposable> {
  const extension = vscode.extensions.getExtension<RemotishExtensionApiV1>('hrashton.remotish');
  if (!extension) {
    throw new Error('Remotish host extension is not installed.');
  }

  const api = await extension.activate();
  if (api.version !== 1) {
    throw new Error(`Unsupported Remotish host API version: ${api.version}`);
  }

  return api.registerProvider({
    id: 'example',
    displayName: 'Example Repository',
    createAdapter(repository) {
      return new MyAdapter({
        organization: repository.organization,
        repository: repository.repository,
      });
    },
  });
}
```

Authentication remains the provider wrapper's responsibility. Capture credentials or an authenticated transport in the wrapper when constructing the adapter; do not put tokens, session identifiers, passwords, private keys, or other credentials in the repository descriptor.

## Open a repository

The host accepts a provider-neutral request:

```ts
await api.openRepository({
  provider: 'example',
  repository: {
    organization: 'acme',
    repository: 'backend',
  },
  branch: 'feature/payments',
});
```

The host creates the adapter, opens the Remotish workspace, switches to the requested branch before registering the workspace, derives a branch-independent workspace authority from the provider ID plus the adapter's stable repository ID, and then opens the `remotish://` workspace.

A nonexistent requested branch is reported as a structured `NOT_FOUND` error by the normal Remotish branch service rather than silently falling back to the default branch.

The API deliberately does not own provider authentication, OAuth callbacks, publisher services, or secrets. Static-web bootstrap restoration and provider auto-activation require additional deployment integration beyond this provider-registration boundary.
