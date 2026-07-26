# @remotish/adapter-sdk

Public contract for implementing Remotish repository adapters. This is the intentionally small npm-published compatibility boundary for third-party adapter authors.

Adapters expose repository metadata, immutable file/tree reads, remote branches, history and optional commit/branch mutation. The SDK deliberately contains no VS Code dependency and no transport abstraction.

```ts
import type { RemotishAdapter, RemotishCapabilities } from '@remotish/adapter-sdk';

class MyAdapter implements RemotishAdapter {
  readonly capabilities: RemotishCapabilities = { commits: false };
  // ...repository operations
}
```

Import only from the package root. The complete semantic contract is documented in [`docs/adapter-contract.md`](../../docs/adapter-contract.md); the implementation tutorial is [`docs/adapter-authoring.md`](../../docs/adapter-authoring.md).


## Install

```sh
npm install @remotish/adapter-sdk
```

The package contains the SDK runtime helpers and TypeScript declarations only. It does not install Remotish, VS Code integration, or a backend adapter.

## Public beta compatibility

The SDK is pre-1.0 during the public beta. Pin or deliberately range the version you test against, import only from the package root, and review release notes before upgrading. The package root is the only supported public API surface.
