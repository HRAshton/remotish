> [!WARNING]
> Archived prototype material. This file is retained for historical context only and does not define current Remotish behavior or API contracts. Start at [`docs/README.md`](../README.md).

# Implementation status

## Implemented

The framework currently includes:

- strict package boundaries around the public adapter SDK, core runtime, VS Code integration, history integration, and reference adapters;
- explicit adapter capabilities for publication and remote branch mutation;
- deterministic fixture, HTTP example, and GitHub reference adapters;
- immutable-base working trees with per-branch overlays and path-based commit selection;
- normal publication, force-with-lease publication, amend-with-lease, partial publication, and safe remote-head refresh;
- a bounded 128 MiB immutable-revision LRU cache with concurrent-read coalescing;
- writable `remotish://` and immutable `remotish-base://` virtual filesystems;
- native SCM changes/staging selection, Quick Diff, revert, publication actions, and branch UX;
- native SCM history and per-file Timeline integration in the isolated `@remotish/vscode-history` package;
- host-injected persistence through Memento or generation-based, content-addressed `storageUri` storage with previous-generation recovery;
- framework events with observer-failure isolation and structural disposables;
- command-palette-safe workspace selection for user-facing commands and context-only SCM commands hidden from the palette;
- browser-first HTTP transport examples and validated GitHub/HTTP JSON boundaries;
- CI/release checks for formatting, TypeScript, dependency direction, dead code, documentation, licensing, SBOMs, source artifacts, VSIX packaging, and Code-OSS Web smoke tests.

## Verification model

Deterministic Node tests cover adapter contracts, working-tree and publication semantics, branch state, cache behavior, persistence, VFS/SCM integration, history/timeline behavior, command error boundaries, and release/manifest invariants. Browser-host and packaged-VSIX smoke tests remain separate release gates because they require the Code-OSS Web runtime.

The repository deliberately does not record a hand-maintained passing-test count here. CI is the source of truth for the current number of tests and their status.

## API policy

`@remotish/adapter-sdk` is the only package external adapter authors are expected to depend on. Its root entrypoint is an explicit export list. Reference adapters depend only on that SDK, and dependency checks prevent them from reaching into core or VS Code implementation packages.

Before 1.0 the SDK may still make deliberate breaking changes. At 1.0 and later, semantic-versioning compatibility applies to the documented root API and adapter operation semantics.

## Non-goals

Local Git commits, Git index semantics, partial-file/hunk staging, merge/rebase/stash/conflict resolution, PR/issues UI, worktrees, Git object storage, Git CLI compatibility, and custom SCM graph WebViews remain out of scope unless the product specification changes.
