# Testing adapters

A Remotish adapter is a concurrency and data-integrity boundary. Test observable repository semantics, not only transport calls.

## Recommended test layers

Use three layers:

1. **Decoder/client tests** - malformed JSON, status mapping, authentication, pagination and binary payload handling.
2. **Adapter contract tests** - repository reads, immutable revisions, branches, history, publication and lease behavior.
3. **Small live smoke tests** - optional; verify the real service without making the main suite dependent on external availability.

The repository follows this pattern for the HTTP and GitHub adapters.

## Baseline contract cases

A production adapter should cover all applicable cases below.

### Repository and files

- `getRepository()` returns a stable ID and valid default branch.
- root and nested directory listing works.
- missing revision/path maps to `NOT_FOUND`.
- binary file bytes survive round trips unchanged.
- path normalization cannot escape repository scope.
- a revision remains readable after a branch moves.

### Branches

- default branch can be identified.
- heads change when the remote branch changes.
- branch creation starts exactly at the requested revision when supported.
- branch deletion is remote and permission failures are classified correctly.

### History

- newest-first ordering is stable.
- pagination returns an opaque cursor and terminates correctly.
- querying by branch and by immutable revision behaves as documented by the backend.
- changed-file mapping covers add/modify/delete and rename when the backend reports it.

### Cancellation and errors

- an aborted request reaches the transport when possible.
- authentication, authorization, rate limiting and offline failures map to useful `RemotishError` codes.
- malformed successful responses are rejected instead of trusted because TypeScript expected a shape.

### Normal publication

Given base `A` and remote head `A`:

```text
commit(base=A) -> success B
remote head     -> B
readFile(B, p)  -> published bytes
```

Then repeat a request from stale base `A` after the head is `B`:

```text
commit(base=A) -> rejected REMOTE_CHANGED
```

Verify no second/partial commit is reported as success.

### Force-with-lease

When supported, test these as separate conditions:

```text
workspace base = A
remote head    = X
expected lease = X
force commit   -> may replace X with B built from A
```

and:

```text
workspace base = A
remote head    = Y
expected lease = X
force commit   -> rejected REMOTE_CHANGED
```

The second test proves the implementation is not an unrestricted force push.

### Amend

When supported, verify that amending base `A`:

- requires a matching lease;
- replaces `A` remotely;
- creates a new revision whose parent list matches the intended parents of `A`, not `[A]`;
- preserves local work on rejection.

## Use the fixture as the behavioral oracle

`@remotish/adapter-fixture` is deterministic and deliberately supports the complete capability set. Its behavior is exercised by [`tests/adapter/contract.mjs`](../tests/adapter/contract.mjs).

That test helper is currently repository-internal rather than a published test-kit API. External adapter projects can mirror its cases, or vendor/adapt the test pattern until a public adapter test kit is introduced.

Do not depend on fixture-only helper methods such as `moveBranchHead()` in production code; they exist for deterministic concurrency tests.

## Test your adapter through core as well

Contract tests prove the adapter itself. Add at least one integration test that opens it through `RemotishWorkspace` and verifies:

- edits produce working changes;
- a rejected publication leaves base and changes unchanged;
- a successful publication advances the base and clears published changes;
- dirty refresh returns `pinned` when the remote moves;
- clean refresh returns `updated`.

## Live tests should be small

Live service tests are valuable for catching upstream API drift, but they should not be the only correctness signal.

Prefer:

- read-only public fixtures where possible;
- explicit environment flags for credentialed tests;
- deterministic mocked/fake tests in normal CI;
- no destructive operations against user data;
- narrow assertions that distinguish service availability from contract bugs.

The GitHub adapter uses deterministic mocked tests in the normal suite and a small unauthenticated read-only smoke test separately.

## Production readiness checklist

Before publishing an adapter, verify that:

- capabilities exactly match implemented operations;
- revision IDs are immutable;
- binary files are preserved;
- untrusted responses are runtime-validated;
- cancellation reaches long-running requests;
- publication is concurrency-safe;
- force means force-with-lease only;
- retries cannot accidentally duplicate non-idempotent commits;
- credentials are not persisted in Remotish workspace state;
- errors contain safe user-facing messages and do not leak tokens;
- tests cover stale-head and stale-lease races.
