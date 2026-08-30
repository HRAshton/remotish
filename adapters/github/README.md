# @remotish/adapter-github

Production-style GitHub reference adapter for Remotish.

Public repositories can be browsed without authentication. Supplying a token enables commit publication and branch mutation when that token has the required repository permissions.

```ts
import { GitHubAdapter } from '@remotish/adapter-github';

const readOnly = new GitHubAdapter({
  owner: 'octocat',
  repository: 'Hello-World',
});

const writable = new GitHubAdapter({
  owner: 'your-org',
  repository: 'your-repo',
  token: getToken(),
});
```

`apiBaseUrl` can be overridden for compatible GitHub Enterprise/test environments, and `fetch` can be injected for tests/non-default browser runtimes.

## Publication model

Writes use GitHub Git Data APIs to create blobs, trees and commits. The final branch mutation uses GraphQL `updateRefs` with `beforeOid`, giving normal and force-with-lease publication an explicit remote-head guard.

The adapter never exposes an unrestricted force push. Amend also uses a lease because it replaces already-published history.

All GitHub JSON consumed by the adapter is runtime-validated before it becomes SDK/domain data.

## Authentication

Treat the token as adapter/client configuration. Do not store it in Remotish workspace persistence or derive it from untrusted workspace content.

For the general semantics behind the implementation, read [`docs/adapter-contract.md`](../../docs/adapter-contract.md). For testing guidance, see [`docs/testing-adapters.md`](../../docs/testing-adapters.md).
