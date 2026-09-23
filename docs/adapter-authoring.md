# Build an adapter

An adapter is the only repository-specific part of Remotish. It translates your backend into the small `@remotish/adapter-sdk` contract; the framework owns editor and source-control behavior.

```text
backend API / SDK / database
          │
          ▼
   your RemotishAdapter
          │
          ▼
 immutable repository semantics
          │
          ▼
 Remotish core + VS Code UI
```

An adapter must not import `vscode`, `@remotish/core`, `@remotish/vscode`, or `@remotish/vscode-history`.

## 1. Start with the SDK boundary

Import only from the package root:

```ts
import {
  type Branch,
  type CommitChange,
  type CommitPage,
  type CommitQuery,
  type DirectoryEntry,
  type RemoteRequestOptions,
  type RemotishAdapter,
  type RemotishCapabilities,
  type RepoPath,
  type RepositoryInfo,
  type RevisionId,
} from '@remotish/adapter-sdk';
```

Source-file imports are implementation details and are not part of the compatibility promise.

## 2. Implement a read-only adapter first

Read-only is the safest path to a correct adapter. `commits: false` lets you omit `commit()` while you validate identity, revisions, files, branches and history.

```ts
export class MyAdapter implements RemotishAdapter {
  readonly capabilities: RemotishCapabilities = {
    commits: false,
  };

  constructor(private readonly client: MyRepositoryClient) {}

  async getRepository(options?: RemoteRequestOptions): Promise<RepositoryInfo> {
    const repo = await this.client.repository(options?.signal);
    return {
      id: repo.stableId,
      name: repo.name,
      defaultBranch: repo.defaultBranch,
      ...(repo.description ? { description: repo.description } : {}),
    };
  }

  async readDirectory(
    revision: RevisionId,
    path: RepoPath,
    options?: RemoteRequestOptions,
  ): Promise<readonly DirectoryEntry[]> {
    return this.client.directory(revision, path, options?.signal);
  }

  async readFile(
    revision: RevisionId,
    path: RepoPath,
    options?: RemoteRequestOptions,
  ): Promise<Uint8Array> {
    return this.client.fileBytes(revision, path, options?.signal);
  }

  async getBranches(options?: RemoteRequestOptions): Promise<readonly Branch[]> {
    return this.client.branches(options?.signal);
  }

  async getCommits(
    request: CommitQuery,
    options?: RemoteRequestOptions,
  ): Promise<CommitPage> {
    return this.client.commits(request, options?.signal);
  }

  async getCommitChanges(
    revision: RevisionId,
    options?: RemoteRequestOptions,
  ): Promise<readonly CommitChange[]> {
    return this.client.commitChanges(revision, options?.signal);
  }
}
```

The exact transport is your choice: REST, GraphQL, RPC, WebSocket, a cloud SDK, a database gateway, or another browser-safe client.

## 3. Make revisions genuinely immutable

This is the most important read-side rule. A `RevisionId` supplied to `readFile(revision, path)` must identify stable content.

Good revision IDs include commit SHAs, immutable object versions, snapshot IDs, or monotonically created revision records. A branch name or mutable "latest" token is not a valid immutable revision.

Remotish may cache immutable reads and use revision-pinned URIs in open diff/history editors.

## 4. Normalize repository paths

Paths are repository-relative, use `/`, and use `''` for the repository root. The SDK exports `normalizeRepoPath()` for adapters that receive path-like input from external sources:

```ts
import { normalizeRepoPath } from '@remotish/adapter-sdk';

const path = normalizeRepoPath('/src\\feature.ts');
// "src/feature.ts"
```

Reject or normalize path traversal before it reaches your backend. Do not let `..` escape repository scope.

## 5. Preserve binary content

`readFile()` returns `Uint8Array`. Do not decode file content as UTF-8 unless your backend contract guarantees text.

If your wire protocol is JSON, encode binary payloads explicitly. The example HTTP adapter uses base64 for add/modify content and raw bytes for reads.

## 6. Map failures to structured errors

Use `RemotishError` for operational failures the framework can classify:

```ts
import { RemotishError } from '@remotish/adapter-sdk';

throw new RemotishError('NOT_FOUND', 'Revision does not exist.');
```

Stable codes are:

```text
NOT_FOUND
UNAUTHORIZED
FORBIDDEN
RATE_LIMITED
OFFLINE
UNSUPPORTED
INVALID_REQUEST
CANCELLED
UNKNOWN
```

Preserve the underlying transport exception with `{ cause }` when useful. Validate untrusted JSON before converting it into SDK values; TypeScript types do not validate network responses.

## 7. Propagate cancellation

Remote methods may receive `RemoteRequestOptions` with an `AbortSignal`. Pass it through to your transport whenever possible:

```ts
return fetch(url, { signal: options?.signal });
```

If your client converts aborts to domain errors, use `RemotishError('CANCELLED', ...)`.

## 8. Add commit-and-publish only when atomic semantics are possible

When the backend can publish changes safely, set `commits: true` and implement `commit()`.

```ts
readonly capabilities = {
  commits: true,
} as const;
```

`commit()` is not "create a commit object". Success means the target remote branch has already been updated and the returned revision is the real published head.

For a normal request:

```ts
{
  type: 'commit',
  branch: 'main',
  baseRevision: 'C42',
  message: 'Update configuration',
  changes: [...],
  push: { mode: 'normal' }
}
```

The adapter should compare/update against the expected remote state atomically or with equivalent optimistic-concurrency protection. If the branch has moved, return:

```ts
{
  status: 'rejected',
  reason: 'REMOTE_CHANGED',
  remoteRevision: 'C45'
}
```

Do not throw for an expected publication conflict when it can be represented as `CommitRejected`. Do throw for transport/authentication/system failures.

## 9. Add optional capabilities independently

Advertise only behavior the backend actually implements:

```ts
readonly capabilities = {
  commits: true,
  forceWithLease: true,
  amend: true,
  createBranch: true,
  deleteBranch: true,
} as const;
```

Dependencies are strict:

```text
forceWithLease -> commits
amend          -> forceWithLease -> commits
createBranch   -> createBranch() method
deleteBranch   -> deleteBranch() method
```

`RemotishWorkspace.open()` validates capability/method consistency and fails early for invalid combinations.

## 10. Treat force as force-with-lease only

Remotish never asks an adapter to perform an unrestricted force push. A force request contains `expectedRevision`. The remote head may be replaced only if it still equals that expected revision.

Amend uses the same protection and replaces the current base commit while preserving its parents according to backend semantics.

If your backend cannot atomically enforce the lease, do not advertise `forceWithLease` or `amend`.

## 11. Implement branch mutation only when remote

`createBranch(name, revision)` must create a real remote branch at the supplied immutable revision. `deleteBranch(name)` must delete the remote branch.

Branch creation and deletion are optional capabilities. Branch listing and branch heads are mandatory because they are part of the base repository model.

## 12. Verify the contract

At minimum test:

- stable repository identity and default branch;
- nested directories and binary file reads;
- immutable revision reads after a branch moves;
- history pagination and commit changes;
- cancellation and error mapping;
- normal publish success;
- stale normal publish rejection without partial state;
- force-with-lease success and stale-lease rejection if supported;
- amend parent/history behavior if supported;
- branch creation/deletion if supported.

The repository's [`tests/adapter/contract.mjs`](../tests/adapter/contract.mjs) and [`@remotish/adapter-fixture`](../packages/adapter-fixture/README.md) are the behavioral reference. See [Testing adapters](testing-adapters.md) for a production checklist.

## Reference adapters

Use the smallest reference that matches your problem:

- [`@remotish/adapter-http`](../adapters/http-example/README.md) - small fetch-only transport and explicit wire validation.
- [`@remotish/adapter-github`](../adapters/github/README.md) - production-style pagination, binary reads, authentication and lease-protected publication.
- [`@remotish/adapter-fixture`](../packages/adapter-fixture/README.md) - deterministic in-memory behavior for tests.
- [`@remotish/adapter-rpc`](../adapters/rpc/README.md) - versioned repository RPC over a caller-supplied transport.

For exact method/result semantics, continue with [Adapter contract](adapter-contract.md).
