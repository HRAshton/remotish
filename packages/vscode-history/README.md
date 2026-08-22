# @remotish/vscode-history

Proposal-sensitive SCM history and file Timeline integration for Remotish.

The package owns native:

- SCM history/graph integration;
- per-file Timeline entries for remote commits.

```ts
import { RemotishHistoryHost } from '@remotish/vscode-history';

const history = new RemotishHistoryHost(host);
context.subscriptions.push(history);
```

Timeline history is read from immutable repository revisions and filtered by repository path. Selecting an entry opens a revision-pinned diff or historical file as appropriate.

Consumers must use a controlled VS Code / Code-OSS host that enables the `scmHistoryProvider` and `timeline` API proposals. See [`docs/code-oss-integration.md`](../../docs/code-oss-integration.md) before shipping this package.
