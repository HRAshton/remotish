> [!WARNING]
> Archived prototype material. This file is retained for historical context only and does not define current Remotish behavior or API contracts. Start at [`docs/README.md`](../README.md).

# Appendix I - Remotish Implementation Plan

**Applies to:** Remotish Development Specification v0.4
**Purpose:** concrete implementation order, maintainability rules, verification gates, and pre-implementation adjustments.

---

## 1. Implementation stance

Remotish should be implemented as a new codebase.

The previous `vscode-universal-remote-repositories` project is a **reference implementation only**. It may be consulted for proven behavior, tests, release workflow ideas, URI handling, overlay behavior, and VS Code integration details, but its architecture should not be migrated wholesale.

The goal is to avoid recreating the previous failure mode: a small number of large stateful files that simultaneously own repository state, remote synchronization, storage, commands, filesystem behavior, and UI integration.

The core Remotish state model remains:

```text
remote revision
      +
working changes
```

There are no Remotish-local commits, no staging/index model, no push queue, and no local Git graph.

---

## 2. Locked architectural decisions

These decisions should be treated as fixed unless implementation proves one technically impossible.

1. **Browser-first runtime.** No production dependency on Node.js APIs, Git CLI, native binaries, or `.git`.
2. **Adapters implement repository semantics only.** They do not implement VS Code UI or editor integration.
3. **A clean workspace is bound to one real remote revision.**
4. **Edits exist only as a framework-owned working overlay.**
5. **Commit means remote commit-and-publish.**
6. Supported commit actions are:
   - `Commit & Push`
   - `Commit & Push (Force with Lease)`
   - `Amend & Push (Force with Lease)`
7. **No unrestricted force push** in the standard contract.
8. **No merge/rebase/conflict-resolution engine in v0.** A moved remote branch causes publication rejection; it does not mutate the workspace base.
9. **Native VS Code / Code-OSS UI first.** Custom WebViews are a last resort.
10. **GitLens is not a runtime dependency.**
11. **History is remote history only.** Remotish never merges synthetic/local commits into it.
12. **The old repository is not a migration target.** Reuse ideas selectively, not structure.

---

## 3. Maintainability rules

### 3.1 Dependency direction

```text
@remotish/adapter-sdk
          │
          ▼
    @remotish/core
       │       │
       ▼       ▼
@remotish/vscode   @remotish/vscode-history

@remotish/adapter-fixture ──► @remotish/adapter-sdk
```

Adapters must never import:

```text
vscode
@remotish/vscode
@remotish/vscode-history
```

`@remotish/core` must never import `vscode`.

These rules should be mechanically enforced in CI rather than documented only.

### 3.2 Small responsibility boundaries

Avoid generic classes such as `RepositoryController` or `RepositorySession` accumulating unrelated responsibilities.

Prefer narrowly scoped modules such as:

```text
packages/core/src/
  workspace/
    workspace.ts
    workspace-state.ts
    branch-workspaces.ts

  working-tree/
    working-tree.ts
    change.ts
    change-set.ts

  overlay/
    overlay.ts
    overlay-entry.ts
    overlay-storage.ts

  repository/
    repository.ts
    revision-cache.ts

  commit/
    commit-service.ts
    commit-request.ts
    commit-result.ts

  events/
    events.ts
```

The exact filenames may change, but the responsibility boundaries should remain.

### 3.3 Thin VS Code layer

VS Code integration should mostly translate core state/events into native editor primitives.

```text
packages/vscode/src/
  extension.ts

  filesystem/
    provider.ts
    uri.ts
    errors.ts

  scm/
    source-control.ts
    resources.ts
    commands.ts
    action-button.ts
    quick-diff.ts

  branches/
    branch-picker.ts
    branch-status.ts

  persistence/
    vscode-storage.ts
```

Domain behavior must not live in command handlers.

For example:

```text
command handler
    ↓
commit service
    ↓
adapter
```

not:

```text
command handler
  ├── reads storage
  ├── calculates changes
  ├── calls adapter
  ├── mutates workspace
  └── refreshes several unrelated systems
```

### 3.4 No arbitrary file-size rule

Do not enforce artificial limits such as "every file must be under 200 lines".

Instead, treat rapid growth, unrelated dependencies, excessive constructor parameters, and mixed reasons-to-change as signals that a module should be split.

### 3.5 Explicit state transitions

Core operations should make state transitions obvious and testable.

Successful commit:

```text
(base A, changes X)
      ↓
commit succeeds with revision B
      ↓
(base B, changes ∅)
```

Rejected commit:

```text
(base A, changes X)
      ↓
commit rejected
      ↓
(base A, changes X)
```

No hidden refresh operation may silently move the base revision while changes exist.

---

## 4. Repository layout

Initial layout:

```text
remotish/
│
├── packages/
│   ├── adapter-sdk/
│   ├── core/
│   ├── vscode/
│   ├── vscode-history/
│   └── adapter-fixture/
│
├── adapters/
│   └── http-example/
│
├── apps/
│   └── demo-web/
│
├── tests/
│   └── browser/
│
├── docs/
│   ├── architecture.md
│   ├── adapter-authoring.md
│   ├── code-oss-integration.md
│   └── release-security.md
│
├── .github/
│   └── workflows/
│
├── README.md
├── SPEC.md
├── Appendix I.md
├── IMPLEMENTATION_STATUS.md
├── LICENSE
└── package.json
```

The `adapters/` directory is intentionally separate from framework packages once real provider-specific implementations appear.

---

# 5. Implementation phases

## Phase 0 - Repository, tooling, CI, and release skeleton

Create the greenfield repository before feature work.

Deliverables:

```text
pnpm workspace
typecheck
lint/format
unit-test command
browser-test command
standard-tool package commands
CI workflow
release workflow skeleton
license
third-party notices
architecture dependency checks
```

Tooling is invoked directly from `package.json`: Biome for formatting, JavaScript/TypeScript linting, and import organization; Dependency Cruiser for boundaries/cycles; Knip for dead code/dependencies; TypeDoc for public API documentation checks; cdxgen for SBOMs; esbuild for browser bundling; and `@vscode/test-web` for the web host. No custom `scripts/` directory is maintained.

### Acceptance gate

A clean checkout can run the complete non-VS-Code build/test pipeline with one documented command.

### Pre-implementation comment

This is intentionally earlier than in the previous plan. CI and package boundaries should exist before architectural shortcuts become entrenched.

---

## Phase 1 - `@remotish/adapter-sdk`

Define the smallest public contract first.

Initial public concepts:

```text
RepositoryId
RevisionId
RepoPath
RepositoryInfo
DirectoryEntry
Branch
CommitInfo
CommitChange
Change
CommitRequest
CommitResult
RemotishCapabilities
RemotishAdapter
RemotishError
```

The commit request must make unsafe combinations unrepresentable.

Conceptually:

```ts
type CommitRequest =
  | NormalCommitRequest
  | ForceCommitRequest
  | AmendCommitRequest;
```

Supported operations:

```text
commit + normal push
commit + force-with-lease
amend + force-with-lease
```

No normal amend variant exists.

### Acceptance gate

An adapter package can implement the full interface without importing anything outside `@remotish/adapter-sdk` plus its own transport/client dependencies.

---

## Phase 2 - Fixture adapter and reusable adapter contract tests

Implement `@remotish/adapter-fixture` before core orchestration.

Fixture repository should contain:

```text
C1 ── C2 ── C3       main
       \
        F1 ── F2     feature/test
```

Provide deterministic files and binary-file coverage.

Fixture behavior must support:

```text
read directory
read file
list branches
list commits
get commit changes
normal commit & push
stale normal push rejection
force-with-lease success
force-with-lease rejection
amend with lease
amend lease rejection
create branch
delete branch
artificial latency
injected failures
external branch-head movement
```

Create a reusable suite:

```ts
runRemotishAdapterContractTests(() => new FixtureAdapter());
```

### Acceptance gate

All adapter semantics are proven without VS Code and without the core workspace implementation.

### Pre-implementation comment

This is a deliberate inversion of the usual order. The adapter contract must become executable before the framework depends on it.

---

## Phase 3 - Core working tree and immutable-base workspace

Implement core workspace behavior.

Core state:

```text
repository
branch
base revision
working overlay
```

Implement:

```text
read
stat
readDirectory
write
create directory
delete
rename
get changes
revert path
revert all
```

Read order:

```text
overlay
  ↓ miss
immutable cache
  ↓ miss
adapter
```

The working tree must never automatically move to a newer branch head.

### Acceptance gate

Tests cover:

```text
modify existing file
add file
delete file
rename file
rename directory
revert each change kind
revert all
binary files
no-op write equal to base
base remains immutable while remote branch moves
```

---

## Phase 4 - Commit service

Keep commit orchestration separate from generic working-tree mutation.

Implement operations:

```text
commitAndPush
commitAndPushForceWithLease
amendAndPushForceWithLease
```

They all convert the current working tree into `Change[]`, call the adapter, then apply one of two transitions.

Success:

```text
base = adapter-returned revision
working changes = empty
```

Failure:

```text
base unchanged
working changes unchanged
```

The framework must not retain an unpublished commit object after failure.

### Acceptance gate

Tests prove state is unchanged for every rejected write operation.

---

## Phase 5 - Branch-bound workspaces

Implement per-branch workspace state.

Example:

```text
main
├── base C3
└── overlay A

feature/test
├── base F2
└── overlay B
```

Branch switching selects a different base + overlay pair.

Remote branch creation/deletion is delegated to adapter capabilities.

### Acceptance gate

Switching branches repeatedly preserves independent working changes without creating local commits or local branches.

---

## Phase 6 - Persistence and immutable cache

Persist core state before introducing VS Code APIs.

Persist:

```text
repository identity
selected branch
base revision per branch
overlay per branch
```

Do not persist:

```text
local commits
push queue
synthetic revision graph
```

Cache immutable resources by:

```text
repository + revision + path
```

Mutable branch heads must not use the same indefinite caching policy.

### Acceptance gate

A serialized workspace can be destroyed and restored with identical visible files and working changes.

### Pre-implementation comment

This phase moves earlier than in the previous plan. Persistence should be a core concern behind an interface, not retrofitted through VS Code storage after VFS/SCM code exists.

---

## Phase 7 - Virtual filesystem

Implement `@remotish/vscode` filesystem support using the already-tested core.

Schemes:

```text
remotish://
remotish-base://
```

Responsibilities:

```text
stat
readDirectory
readFile
writeFile
createDirectory
delete
rename
watch/file-change events
VS Code error translation
```

`remotish-base://` is immutable and revision-bound.

### Acceptance gate

VS Code Web integration tests can:

```text
open fixture repository
browse directories
open file
edit file
create file
delete file
rename file
reload workspace
verify edits remain
```

---

## Phase 8 - Native SCM basics

Use native `vscode.scm` primitives.

Implement:

```text
Changes resource group
M/A/D/R states
open diff
Quick Diff
revert resource
revert all
refresh UI state
SCM input box
```

VS Code renders the actual tree, decorations, menus, diff editor, and resource actions.

Do not create a custom SCM WebView.

### Acceptance gate

A second adapter passes through the exact same SCM code without provider-specific conditionals.

---

## Phase 9 - Commit action button and remote write UX

Add the primary SCM action:

```text
Commit & Push
```

Dropdown actions according to capabilities:

```text
Commit & Push
Commit & Push (Force with Lease)
Amend & Push (Force with Lease)
```

No plain `Commit` and no plain `Amend`.

For amend, prefill or otherwise expose the current remote commit message when practical.

### Acceptance gate

Browser integration tests verify:

```text
successful commit clears Changes
workspace now reads returned revision
rejected normal push preserves Changes
force-with-lease rejection preserves Changes
successful amend rebinds workspace to rewritten revision
```

### Pre-implementation comment

The SCM action-button API may require the controlled Code-OSS/proposed-API path. Keep this code isolated from the rest of SCM integration so a Code-OSS API change affects one module.

---

## Phase 10 - Branch UX

Implement native branch controls only.

Use:

```text
status bar / SCM status primitive
QuickPick
commands
```

Functions:

```text
show current branch
switch branch
create branch when supported
delete branch when supported
```

No custom branch WebView.

### Acceptance gate

`adapter.getBranches()` plus optional branch-management methods are sufficient to drive the full branch UI.

---

## Phase 11 - Code-OSS SCM history / graph integration

Keep history in a dedicated package/module because this is the most version-sensitive integration.

Feed only real remote data:

```text
commits
parents
refs
changed files
historical file contents
pagination
```

Do not add a Remotish local-history layer.

### Acceptance gate

From the native history UI, the user can:

```text
browse commits
select branches/refs
inspect changed files
open historical file
open revision diff
page older history
```

### Pre-implementation comment

This is the feature with the highest uncertainty without an interactive Code-OSS launch. Keep it late enough that the framework is already useful if the exact history API needs one manual compatibility pass.

---

## Phase 12 - Simple HTTP example adapter

Only after fixture/core/VS Code behavior is stable, implement a deliberately boring remote adapter.

Example service surface:

```text
GET  /repository
GET  /tree
GET  /file
GET  /branches
GET  /commits
GET  /commits/:revision/changes
POST /commit
POST /branches
DELETE /branches/:name
```

Its purpose is not production Git hosting support.

Its purpose is to prove:

> a real network-backed adapter remains small and contains no VS Code integration code.

---

## Phase 13 - Hardening and first release

Before the first public release:

```text
full lint/typecheck/tests
browser E2E
package VSIX
verify reproducible package contents where practical
generate checksums
generate SBOM
attest release artifact provenance
attest SBOM
publish GitHub Release
publish verification instructions
```

---

# 6. Testing strategy

Use four layers.

## Layer A - adapter contract

Runs against fixture and every official adapter.

Proves remote semantics only.

## Layer B - core unit/integration tests

Runs without VS Code.

Proves:

```text
overlay behavior
state transitions
branch-bound overlays
persistence
cache
commit rejection invariants
```

## Layer C - VS Code integration tests

Exercise VFS/SCM command wiring without relying heavily on visual selectors.

Use test-only commands/state probes where they make tests less brittle.

## Layer D - browser E2E

Use `@vscode/test-web` + Playwright for a smaller set of high-value workbench flows.

Do not try to assert every Monaco/SCM DOM detail.

Prefer behavior:

```text
edit file
change appears
revert works
commit works
switch branch works
history opens
```

rather than pixel-perfect UI testing.

---

# 7. CI quality gates

Every pull request should run at least:

```text
install with frozen lockfile
format/lint check
typecheck
architecture/dependency rules
unit tests
adapter contract tests
core integration tests
extension build
browser smoke tests
```

Release tags run the complete release pipeline again from the tagged commit.

Do not publish artifacts produced by an earlier untrusted PR job.

---

# 8. Release security and attestation

Preserve the strongest parts of the previous project release process:

```text
immutable-SHA-pinned GitHub Actions
persist-credentials: false
minimal job permissions
frozen lockfile
version/tag verification
full tests before packaging
SHA-256 checksum manifest
separate release job
release environment protection
artifact provenance attestation
```

For the new project, use the current general attestation action for new workflow code rather than the older dedicated build-provenance wrapper.

Recommended release flow:

```text
tag
 ↓
verify package version == tag
 ↓
clean checkout
 ↓
frozen dependency install
 ↓
lint + typecheck + tests + browser tests
 ↓
build/package
 ↓
generate SBOM
 ↓
generate SHA256SUMS
 ↓
attest VSIX provenance
 ↓
attest SBOM
 ↓
upload workflow artifact
 ↓
separate release job
 ↓
verify SHA256SUMS
 ↓
publish GitHub Release
```

For stronger supply-chain isolation, move the actual release build into a reusable workflow before the first stable release.

Verification documentation should include both checksum verification and GitHub attestation verification.

---

# 9. Code review checklist

Before merging a feature, check:

- Does this belong in adapter SDK, core, VS Code integration, or provider code?
- Did any VS Code type leak into core?
- Did provider-specific behavior leak into framework code?
- Does a command handler contain domain logic that belongs in core?
- Can the behavior be tested without VS Code?
- Does a rejected operation leave workspace state unchanged?
- Did we add a hidden remote refresh/base mutation?
- Are capabilities driving optional UI rather than provider-specific conditionals?
- Did one class gain another unrelated responsibility?
- Could a native Code-OSS primitive replace custom UI?
- Does the new dependency increase browser-runtime assumptions?
- Are release/security workflows still SHA-pinned and least-privileged?

---

# 10. Explicit non-goals for v0

Do not add these opportunistically during implementation:

```text
local commits
staging/index
stash
merge
rebase
merge-conflict editor
cherry-pick
worktrees
PR UI
issue UI
CI pipeline/status dashboards
Git object database
Git CLI compatibility layer
full repository download
custom graph renderer
custom SCM WebView
```

If a future feature requires one of these, it should begin with a separate design decision rather than appear as incidental framework complexity.

---

# 11. Pre-implementation changes from the previous plan

The following adjustments should be made before writing production code:

### Change A - build greenfield

Do not refactor the old repository into Remotish. Use it only for reference and regression ideas.

### Change B - fixture before core

Make the adapter contract executable first. This reduces the chance of designing the public SDK around implementation convenience.

### Change C - persistence before VS Code

Define persistence as a core abstraction before VFS/SCM work. This prevents editor integration from owning domain state.

### Change D - release infrastructure early

Create CI, architecture checks, and release scaffolding in Phase 0.

### Change E - isolate proposed Code-OSS APIs

Both SCM action-button and history/graph integrations should live behind narrow modules so Code-OSS version changes do not spread through the framework.

### Change F - treat amend as remote rewrite only

The only amend operation is:

```text
Amend & Push (Force with Lease)
```

No API should allow a non-forced amend.

### Change G - never auto-refresh dirty base

A dirty workspace remains bound to its original base revision even when the remote branch changes. Remote movement is discovered when explicitly refreshed for information or when publication is attempted; it does not cause automatic rebasing or conflict calculation.

---

# 12. First implementation target

The first meaningful milestone should finish with these packages working together:

```text
@remotish/adapter-sdk
@remotish/adapter-fixture
@remotish/core
```

and prove this flow without VS Code:

```text
open fixture main at C3
        ↓
edit README.md
        ↓
changes = [M README.md]
        ↓
Commit & Push
        ↓
adapter returns C4
        ↓
workspace base = C4
changes = []
```

plus the rejection invariant:

```text
open main at C3
        ↓
edit README.md
        ↓
remote main moves to C4
        ↓
Commit & Push rejected
        ↓
workspace base remains C3
changes remain intact
```

Once those two flows are boring, deterministic, and well tested, proceed to the VS Code layer.

---

# 13. Definition of architectural success

Remotish is succeeding if a new adapter author can implement remote repository operations without learning VS Code extension APIs, while framework maintainers can change SCM/VFS/history integration without touching provider code.

The intended long-term shape is:

```text
adapter author complexity
        ≈
remote API mapping
```

not:

```text
remote API mapping
+
VS Code filesystem
+
SCM UI
+
branch UI
+
history UI
+
revert semantics
+
persistence
```

That separation is the primary maintainability requirement of the project.

---

# 14. Implementation discoveries after the plan was written

These are small corrections discovered by implementing the contracts; they do
not change the central architecture.

### H - branches are mandatory, not a capability

The workspace cannot open or bind a branch without remote branch semantics, so
`getBranches()` is part of the required v0 repository contract. The redundant
`branches` capability was removed.

### I - rename is framework-owned

Working-tree rename is an overlay operation. Commit serialization already turns
it into ordinary added/deleted file changes, so adapters do not need a `rename`
capability. History adapters may still *report* a remote commit change as
`renamed` when their backend knows that information.

### J - explicit Refresh may advance only a clean workspace

The earlier rule against automatic dirty-base movement remains. A user-requested
Refresh is useful, however: if the workspace is clean it can safely rebind to the
current remote head; if dirty it reports the newer head and remains pinned.

### K - add a VS Code runtime-stub verification layer

Because the current implementation environment cannot launch Code-OSS Web, the
project now has a small runtime stub that executes the actual VFS/SCM/command/
history composition. This catches wiring and state-transition bugs while making
no claim about real workbench rendering. Real `@vscode/test-web`/Playwright
coverage remains a mandatory release gate.

### L - file Timeline is remote commit history, not another local-history model

The native Timeline surface is version-sensitive and therefore belongs in
`@remotish/vscode-history` beside the SCM history provider. It is derived from
the workspace's pinned base revision plus adapter `getCommits()` /
`getCommitChanges()` data. It does not introduce local commits or a second
history store. Historical navigation always uses revision-pinned
`remotish-base://` URIs.

### M - virtual file timestamps and workspace labels remain framework-owned

Adapters are not required to expose file-level mtimes. The VS Code VFS therefore
uses stable session timestamps for `FileStat` and updates them on local
mutations, preventing unknown timestamps from being rendered as 1970. Remote
commit timestamps remain adapter metadata.

Workspace roots use a Remotish URI with an explicit root path (for example,
`remotish://fixture-demo/`) and the extension contributes native resource-label
formatting for Remotish URI schemes. The explicit `/` keeps the URI valid for
VS Code workspace path joining while the authority remains the repository
identity. Adapter implementations remain unaware of this presentation concern.
