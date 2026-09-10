# Core concepts

Remotish intentionally models less than Git. The framework needs enough version-control semantics to provide a safe editable remote workspace, but it does not reproduce a local Git repository.

## The state model

The central equation is:

```text
immutable remote revision + working overlay = visible workspace
```

For the selected branch, Remotish pins the workspace to one immutable remote revision. Edits are stored separately as an overlay. Reads merge those two layers.

```text
Remote revision C42          Working overlay           Visible workspace
-------------------          ---------------           -----------------
README.md   old              README.md   modified  ->  README.md   modified
src/a.ts    ...              src/b.ts    added     ->  src/a.ts    ...
assets/x    ...              assets/x    deleted   ->  src/b.ts    added
                                                     assets/x    absent
```

This gives editor-like behavior without a clone or `.git` directory.

## Revisions must be immutable

`RevisionId` values are adapter-defined, but a revision passed to `readFile()` or `readDirectory()` must continue to describe the same content. Remotish caches revision reads and creates revision-pinned URIs for diffs and history.

Do not use a mutable branch name as a revision ID.

## Branches are remote branches

A branch is `{ name, revision }`, where `revision` is its current remote head. Switching branches selects a branch-local Remotish workspace state; it does not create a local Git branch.

Each visited branch may retain its own pinned base revision and working overlay through workspace persistence.

## Working changes and staging

Remotish owns file editing, create/delete/rename behavior, diffing and revert.

The Source Control view has **Changes** and **Staged Changes**, but staging is only a selection of paths for the next publication. There is no Git index and no second staged content snapshot.

Consequences:

- Editing a staged file still changes the content that will be published.
- Publishing only staged paths advances the base to the new remote revision and keeps the remaining working changes rebased in the overlay.
- Renames are working-tree behavior and reach adapters as normal add/delete content changes.
- Revert restores the affected path from the pinned base revision.

## Commit means commit and publish

There is no local commit state. `commit()` is a logical remote transaction.

A successful result means all of the following are already true:

1. the remote commit/revision exists;
2. the target branch points to it;
3. the returned `revision` is the real new branch head;
4. Remotish can safely make that revision the new workspace base.

After success:

```text
(base C42, overlay X) -- commit & push --> (base C43, overlay empty)
```

If the remote cannot publish, return a rejection or throw an adapter error. Never report success for a locally created but unpublished object.

## Remote concurrency

A normal publication is based on `baseRevision`. If the remote branch has moved since that base, the adapter should reject it as `REMOTE_CHANGED`.

```text
workspace base: C42
remote head:    C45

normal commit -> rejected REMOTE_CHANGED
```

Force operations are never unrestricted force pushes. Remotish models only **force-with-lease**: the adapter receives an explicit `expectedRevision` and may replace the remote head only if the current remote head still matches that lease.

An amend is also a force-with-lease operation because it replaces an already-published commit.

## Rejection preserves local work

A rejected publication is not a partial success. Core keeps the existing base and all working changes:

```text
(base C42, overlay X)
        │
        ├─ REMOTE_CHANGED
        ▼
(base C42, overlay X)
```

This invariant is one of the most important requirements for adapter implementations.

## Refresh is intentionally conservative

`refreshRemoteHead()` compares the selected branch's current remote head with the pinned base.

| Result | Meaning | Workspace action |
| --- | --- | --- |
| `current` | remote head equals base | no change |
| `updated` | remote moved and workspace is clean | rebind base to remote head |
| `pinned` | remote moved and workspace is dirty | preserve base and overlay |

Remotish never silently rebases or discards a dirty workspace when the remote moves.

## History is repository history

Adapters expose commit metadata and per-commit changed files. Remotish uses this to populate native history/Timeline surfaces. History reads are independent of the working overlay and should describe immutable remote revisions.

## Persistence belongs to the host

Core accepts a `WorkspaceStorage` implementation. In VS Code, `StorageUriWorkspaceStorage` persists branch-local overlays as content-addressed blobs plus generation manifests. It retains a previous generation for recovery from an interrupted or corrupt save.

`MemoryWorkspaceStorage` is useful for tests or deliberately ephemeral hosts. `MementoWorkspaceStorage` is available for small host-managed snapshots.

## What Remotish deliberately does not model

Remotish has no local commits, merge engine, rebase engine, tags, Git index, stash, hooks, submodules, Git configuration, object database, or arbitrary ref namespace. An adapter may talk to Git internally, but the framework contract remains repository-semantic rather than Git-semantic.
