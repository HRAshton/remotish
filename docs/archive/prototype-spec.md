> [!WARNING]
> Archived prototype material. This file is retained for historical context only and does not define current Remotish behavior or API contracts. Start at [`docs/README.md`](../README.md).

# Remotish specification

## Product invariant

Remotish is a browser-first remote repository framework for VS Code / Code-OSS.
It exposes remote content through a virtual filesystem without a local clone,
`.git`, Git executable, or production Node.js runtime.

A workspace contains only:

```text
repository + branch + immutable base revision + working changes
```

VS Code may additionally keep a lightweight path-based **commit selection** for each branch. This is UI state only: it stores selected paths, not file snapshots, commits, or Git index entries.

Branches are remote repository semantics. Remotish may persist a separate base
and working overlay for each selected remote branch, but it never creates a
local branch or local commit.

## Commit operations

Supported write operations are:

1. Commit & Push.
2. Commit & Push (Force with Lease).
3. Amend & Push (Force with Lease).

There is no plain local Commit, no plain Amend, and no unrestricted force push.
A successful adapter commit returns a real remote revision. If all changes are published, core rebinds the workspace and clears the overlay. If only selected paths are published, core rebinds to the returned revision and preserves the unselected overlay. A rejected commit mutates nothing.

Amend may contain zero selected working-file changes so the current remote commit message can be rewritten safely through force-with-lease. Selection is path-based: editing a selected file before publication commits its current content. Partial-file or hunk staging is not supported.

## Remote movement and refresh

Remote branch movement is not a merge conflict. A dirty workspace remains pinned
to its immutable base. Normal publication may be rejected as `REMOTE_CHANGED`.

Explicit Refresh may advance a **clean** workspace to the latest remote branch
head. It never advances a dirty workspace.

## VS Code integration

Working resources:

```text
remotish://<workspace-id>/<path>
```

Immutable revision resources:

```text
remotish-base://<workspace-id>/<path>?revision=<revision>
```

The workspace root URI always includes the root path (`remotish://<workspace-id>/`). VS Code workspace configuration code joins child paths against the folder URI, so an authority-only URI with an empty path is invalid for this use. Native resource-label formatting uses the authority for Remotish resources. File stat timestamps are stable session timestamps when the adapter has no file-level timestamp API; remote Timeline timestamps come from commit metadata.

Native Source Control renders `Changes` and `Staged Changes`. Remotish provides path-based stage/unstage selection, row-click diff opening, Open File (editable working resource), Quick Diff, revert commands, the commit-and-push action button and branch controls. Native SCM history and per-file Timeline integration are isolated in `@remotish/vscode-history`. Timeline entries are derived from the pinned workspace revision and open revision-pinned historical diffs.

## Adapter boundary

All adapters provide repository metadata, immutable file/tree reads, remote
branches, remote history, changed-file metadata, and the logical remote
`commit()` transaction. `commits: false` makes a repository read-only.

Branch support is mandatory in v0; it is not a capability flag. Rename is
framework-owned and is not an adapter capability.

## v0 non-goals

Local commits, Git index semantics, partial-file/hunk staging, merge, rebase, stash, conflict resolution, PR UI,
issues, worktrees, Git object storage, Git CLI compatibility, and custom SCM or
graph WebViews are out of scope.

See `Appendix I.md` for the implementation order and acceptance gates.
