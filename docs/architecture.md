# Architecture

Remotish separates repository semantics from editor integration so adapters stay small, testable and portable.

## State equation

```text
immutable remote revision + working overlay = visible workspace
```

A clean workspace is bound to a real remote revision. Remotish does not create local commits, local refs, a staging index, or a push queue.

## Dependency direction

```text
@remotish/adapter-sdk
        │
        ├──────────────► external / reference adapters
        │
        ▼
@remotish/core
        │
        ▼
@remotish/vscode
        │
        ▼
@remotish/vscode-history
```

`@remotish/adapter-fixture` implements only the adapter SDK and is used as a deterministic reference. Adapters never depend on core or VS Code packages.

`@remotish/adapter-rpc` is a browser-safe, transport-neutral adapter. It forwards the SDK repository contract through a versioned, validated RPC protocol; a separate transport owns connection and authentication. It has no editor or SCM-service behavior.

Dependency Cruiser enforces package-layer and circular-dependency rules. Knip checks dead files/dependency declarations and TypeDoc validates the exported TypeScript API documentation.

## Package responsibilities

### `@remotish/adapter-sdk`

Owns the public compatibility boundary: repository metadata, immutable file/tree reads, branches, history, commit-and-publish requests/results, capabilities, path normalization, structured adapter errors, and the versioned provider/request contract used by independently installed provider extensions.

It has no VS Code or core dependency and no transport opinion.

### `@remotish/core`

Owns the runtime repository model:

- immutable revision reading and bounded caching;
- working overlay and file mutations;
- branch-local workspace states;
- commit orchestration;
- safe refresh behavior;
- persistence snapshots;
- serialized state-changing operations.

Core is browser-safe and does not import `vscode`.

### `@remotish/vscode`

Maps core behavior to stable/native editor primitives:

- `remotish://` editable filesystem;
- `remotish-base://` revision-pinned read-only filesystem;
- Source Control resource groups;
- diff/quick-diff integration;
- staging selection and revert commands;
- branch controls and refresh;
- VS Code-backed workspace storage implementations;
- manifest-only provider discovery and lazy provider activation;
- versioned provider-to-host repository commands;
- canonical workspace restoration and stable provider/repository identity verification.

### `@remotish/vscode-history`

Isolates version-sensitive native SCM history and per-file Timeline integration. Keeping it separate prevents proposal API churn from leaking into core or the adapter SDK.

## Branch-local state

Each visited remote branch may have a persisted workspace state:

```text
branch
├── immutable base revision
└── working overlay
```

Switching branches selects another branch state. It does not create a local branch or commit.

## Serialized mutation boundary

`RemotishWorkspace` serializes state-changing operations. Write, delete, rename, revert, commit, branch transitions, refresh and persistence therefore do not race each other inside one workspace instance.

Remote systems still require their own optimistic-concurrency protection. Serialization inside Remotish is not a substitute for a lease/check at the remote publication boundary.

## Immutable read caching

`RepositoryReader` caches immutable revision reads in a bounded LRU cache. The default budget is 128 MiB per reader. Concurrent reads for the same revision/path are coalesced; oversized entries are served without being retained.

This is why revision IDs must actually be immutable.

## Publication state transitions

Before a remote publication starts, core durably records a `prepared` journal containing the branch and expected remote revision. After a known success, it records the exact `published` revision before local reconciliation. If recovery cannot prove the outcome, mutations remain blocked rather than guessing. A host may inspect `pendingPublication` and explicitly call `resolvePendingCommitPublication(...)` only after independently establishing that nothing was published or determining the exact published revision.

Normal success:

```text
(base A, changes X)
   │ commit & publish
   ▼
remote accepts B
   │
   ▼
(base B, changes empty)
```

Rejected publication:

```text
(base A, changes X)
   │
   ▼
REMOTE_CHANGED
   │
   ▼
(base A, changes X)
```

Force operations are force-with-lease. Amend is exposed only as amend + publish with force-with-lease because it replaces an already-published revision.

## Refresh state transition

Remote branch movement never changes a dirty workspace automatically:

- `current` - remote head still equals base;
- `updated` - workspace was clean and is rebound to the newer head;
- `pinned` - workspace was dirty, so base and overlay are preserved.

## Persistence model

Core accepts a host-injected `WorkspaceStorage`. In VS Code, `StorageUriWorkspaceStorage` separates JSON manifests from raw bytes:

1. overlay bytes are stored as SHA-256-addressed blobs;
2. a complete generation manifest is written only after its blobs exist;
3. the current pointer is replaced last;
4. current and previous generations are retained;
5. startup can fall back to the previous valid generation.

Persisted data is decoded/validated before it becomes core state.

## Events and failure semantics

Core events are notifications, not transactional hooks. Local-only mutations persist before change events are emitted. For irreversible remote mutations, core first persists any safety-critical intent it can; if a later persistence write fails after remote success, the remote outcome is not falsely reported as failed. A failing observer is reported but does not roll back a completed operation or prevent later observers from running.

## URI architecture

Editable resources remain stable as the base revision changes:

```text
remotish://workspace-id/path/to/file
```

Historical resources pin an immutable revision:

```text
remotish-base://workspace-id/path/to/file?revision=C42
```

Open history/diff editors therefore keep their original meaning after later commits, refreshes or branch switches.

For host-specific details, see [VS Code integration](vscode-integration.md) and [Code-OSS integration](code-oss-integration.md).
