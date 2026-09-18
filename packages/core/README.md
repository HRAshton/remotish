# @remotish/core

Browser-safe repository workspace runtime for Remotish.

`RemotishWorkspace` combines an immutable remote revision with a local working overlay, coordinates branch-local states, persistence, refresh and commit-and-publish operations, and exposes repository history without depending on VS Code.

```ts
import { RemotishWorkspace } from '@remotish/core';

const workspace = await RemotishWorkspace.open(adapter, storage);
```

Most adapter authors do not need to depend on this package. VS Code/product integrators use it when composing a remote repository into a host. See [`docs/concepts.md`](../../docs/concepts.md), [`docs/architecture.md`](../../docs/architecture.md), and [`docs/vscode-integration.md`](../../docs/vscode-integration.md).
