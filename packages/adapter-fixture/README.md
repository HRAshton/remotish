# @remotish/adapter-fixture

Deterministic in-memory reference adapter for Remotish.

The fixture implements the full capability set and is used by contract tests, framework tests and the browser demo. It is useful for integration tests that need predictable repository history and publication behavior without a network service.

```ts
import { FixtureAdapter } from '@remotish/adapter-fixture';
import { RemotishWorkspace } from '@remotish/core';

const workspace = await RemotishWorkspace.open(new FixtureAdapter());
```

Fixture-only helpers such as branch-head movement exist for tests and are not part of the general adapter contract. See [`docs/testing-adapters.md`](../../docs/testing-adapters.md).
