# Adapter contract reference

This page is the semantic reference for `@remotish/adapter-sdk`. Type declarations define the shape; this document defines the expectations behind those shapes.

## Interface

A Remotish adapter implements:

```ts
interface RemotishAdapter {
  readonly capabilities: RemotishCapabilities;

  getRepository(options?): Promise<RepositoryInfo>;
  readDirectory(revision, path, options?): Promise<readonly DirectoryEntry[]>;
  readFile(revision, path, options?): Promise<Uint8Array>;

  getBranches(options?): Promise<readonly Branch[]>;
  getCommits(request, options?): Promise<CommitPage>;
  getCommitChanges(revision, options?): Promise<readonly CommitChange[]>;

  commit?(request, options?): Promise<CommitResult>;
  createBranch?(name, revision, options?): Promise<Branch>;
  deleteBranch?(name, options?): Promise<void>;
}
```

## Repository identity

### `getRepository()`

Returns metadata for exactly one repository.

`RepositoryInfo.id` must be stable across extension sessions and must distinguish repositories that can be opened by the same host. It is also used as the persistence key.

`defaultBranch` must name a branch that can normally be returned by `getBranches()`.

## Immutable repository reads

### `readDirectory(revision, path)`

Returns the immediate children of one directory at an immutable revision.

Requirements:

- `revision` identifies immutable repository state.
- `path` is repository-relative; `''` is the root.
- every returned `DirectoryEntry.path` is repository-relative and corresponds to the requested revision;
- each entry type is `file` or `directory`;
- `size` is optional and should only be populated when it is meaningful/cheaply known.

Use `RemotishError('NOT_FOUND', ...)` for a missing revision or path.

### `readFile(revision, path)`

Returns exact file bytes as `Uint8Array` at an immutable revision. Do not perform implicit text decoding, newline conversion, or character-set conversion.

A later call with the same revision/path must describe the same immutable content.

## Branches

### `getBranches()`

Returns remote branches and their current head revisions:

```ts
{
  name: 'main',
  revision: 'C42',
  isDefault: true,
}
```

Branch heads may move between calls. The `revision` values they point to must remain immutable.

Branch support is mandatory because branch identity is part of the workspace model. Branch mutation is optional.

### `createBranch(name, revision)`

Optional. Creates a real remote branch at the supplied immutable revision and returns the resulting branch. Advertise `createBranch: true` only when this method is implemented.

### `deleteBranch(name)`

Optional. Deletes the named remote branch. Advertise `deleteBranch: true` only when this method is implemented.

Core prevents deletion of the currently selected branch, but adapters should still validate remote constraints and permissions.

## History

### `getCommits(request)`

Returns commits in newest-first order. A request can select history by `branch` or `revision`, include an adapter-defined cursor, and request a maximum `limit`.

`nextCursor` is opaque to Remotish. Return it only when another page is available.

Commit revisions and parent revisions are immutable IDs. `authoredAt`, when supplied, should be an ISO-8601 timestamp.

### `getCommitChanges(revision)`

Returns file-level changes for one immutable commit. Supported types are `added`, `modified`, `deleted`, and `renamed`. For a rename, supply `previousPath` when the backend knows it.

This method describes repository history, not the current working overlay.

## Capabilities

```ts
interface RemotishCapabilities {
  commits: boolean;
  forceWithLease?: boolean;
  amend?: boolean;
  createBranch?: boolean;
  deleteBranch?: boolean;
}
```

Rules:

| Capability | Requirement |
| --- | --- |
| `commits` | `commit()` exists when true; false makes the workspace read-only |
| `forceWithLease` | requires `commits: true` |
| `amend` | requires `forceWithLease: true` |
| `createBranch` | requires `createBranch()` |
| `deleteBranch` | requires `deleteBranch()` |

`RemotishWorkspace.open()` validates these combinations.

Capabilities are behavioral promises, not feature labels. Do not advertise a capability for an operation the remote can only approximate unsafely.

## Commit-and-publish

### Change set

A commit request contains working-tree changes:

```ts
type Change =
  | { type: 'add' | 'modify'; path: RepoPath; content: Uint8Array }
  | { type: 'delete'; path: RepoPath };
```

Rename is not a commit payload type. Framework rename behavior resolves to ordinary content add/delete changes.

### Normal publication

```ts
{
  type: 'commit',
  branch,
  baseRevision,
  message,
  changes,
  push: { mode: 'normal' }
}
```

`baseRevision` is the workspace's pinned immutable base. A correct adapter must prevent silently publishing a normal commit on top of an unexpectedly moved remote branch.

If the remote head no longer matches the publication precondition, return a `REMOTE_CHANGED` rejection with the current remote revision when known.

### Force-with-lease publication

```ts
{
  type: 'commit',
  branch,
  baseRevision,
  message,
  changes,
  push: {
    mode: 'force-with-lease',
    expectedRevision,
  },
}
```

The new commit is built from the workspace's `baseRevision`, while `expectedRevision` protects the branch update. The adapter may replace the branch head only if the remote head still equals `expectedRevision`.

This allows an intentional history replacement without granting an unguarded force push.

### Amend

```ts
{
  type: 'amend',
  branch,
  baseRevision,
  message,
  changes,
  push: {
    mode: 'force-with-lease',
    expectedRevision,
  },
}
```

Amend replaces the current base commit and therefore requires force-with-lease. Its new commit should have the amended base commit's parent(s), not the base commit itself as a new parent.

### Success

```ts
{
  status: 'success',
  revision: 'C43',
  commit: {
    revision: 'C43',
    parents: ['C42'],
    message: 'Update',
  },
}
```

Success means the target branch is already published at `revision`. Core will advance its base and clear the successfully published working changes.

### Rejection

```ts
{
  status: 'rejected',
  reason: 'REMOTE_CHANGED',
  remoteRevision: 'C45',
  message: 'Remote branch moved.',
}
```

Stable rejection reasons are:

- `REMOTE_CHANGED` - optimistic concurrency / lease no longer matches;
- `FORBIDDEN` - publication is not permitted in this request context;
- `UNSUPPORTED` - the requested publication mode is not supported.

A rejection means publication did not complete and must not be represented as partial success. Core preserves the previous base and working changes.

## Errors

Operational failures use `RemotishError`:

| Code | Typical meaning |
| --- | --- |
| `NOT_FOUND` | repository, revision, branch or path does not exist |
| `UNAUTHORIZED` | authentication is missing/invalid |
| `FORBIDDEN` | authenticated caller lacks permission |
| `RATE_LIMITED` | remote rate limit prevents the operation |
| `OFFLINE` | network/service is unavailable |
| `UNSUPPORTED` | operation cannot be performed by this backend |
| `INVALID_REQUEST` | caller/backend input violates the contract |
| `CANCELLED` | request was cancelled |
| `UNKNOWN` | failure cannot be classified more specifically |

Expected commit concurrency conflicts should normally be `CommitRejected`, not thrown `RemotishError`s.

## Cancellation

`RemoteRequestOptions.signal` is an `AbortSignal`. Adapters should pass it into their transport or SDK when supported. Cancellation should stop unnecessary remote work and should not mutate remote state after the operation is known to be cancelled unless the underlying remote transaction has already committed atomically.

## Transport and validation

Transport is intentionally not part of the SDK. Adapters own authentication, retries, headers, base URLs, pagination translation and wire schemas.

Network JSON is untrusted input. Validate it before returning SDK values. The GitHub and HTTP reference adapters both decode/validate transport responses at their boundaries.

Avoid hidden retries for non-idempotent publication unless the remote provides an idempotency mechanism. A timeout after an ambiguous write must not cause a second commit to be created accidentally.

## Compatibility

Only symbols exported by the `@remotish/adapter-sdk` package root are public adapter API. Do not import SDK source paths or framework internals.

The project is pre-1.0 today. The intended post-1.0 compatibility policy is semantic versioning:

- removing/changing a required member, changing established operation semantics, or narrowing accepted values requires a major version;
- additive optional capabilities or result metadata can be minor-version changes when existing adapters continue to typecheck and behave correctly;
- internal helpers that are not exported from the package root carry no compatibility guarantee.

For implementation guidance, see [Build an adapter](adapter-authoring.md). For verification, see [Testing adapters](testing-adapters.md).
