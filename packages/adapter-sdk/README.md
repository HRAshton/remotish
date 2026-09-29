# @remotish/adapter-sdk

Public contract for implementing Remotish repository adapters and independently installable adapter-provider extensions. This is the intentionally small npm-published compatibility boundary for third-party authors.

Adapters expose repository metadata, immutable file/tree reads, remote branches, history and optional commit/branch mutation. The SDK deliberately contains no VS Code or Remotish-core dependency and no transport abstraction.

```ts
import type { RemotishAdapter, RemotishCapabilities } from '@remotish/adapter-sdk';

class MyAdapter implements RemotishAdapter {
  readonly capabilities: RemotishCapabilities = { commits: false, localEdits: true };
  // ...repository operations
}
```

Provider extensions can additionally return `RemotishAdapterProviderV1` from activation and use the SDK's versioned repository command constants without importing Remotish implementation packages.

Import only from the package root. The complete adapter semantic contract is documented in [`docs/adapter-contract.md`](../../docs/adapter-contract.md); the implementation tutorial is [`docs/adapter-authoring.md`](../../docs/adapter-authoring.md), and automatic provider discovery is documented in [`docs/provider-extensions.md`](../../docs/provider-extensions.md).


## Install

```sh
npm install @remotish/adapter-sdk
```

The package contains the SDK runtime helpers and TypeScript declarations only. It does not install Remotish, VS Code integration, or a backend adapter.

## 1.x compatibility

The package root is the supported public API surface. Starting with 1.0, it follows semantic versioning: incompatible contract or semantic changes require a major release, additive compatible API can ship in a minor release, and compatible fixes can ship in a patch release.

Release candidates such as `1.0.0-rc.1` may still change before `1.0.0`. Import only from the package root and review release notes before upgrading.
