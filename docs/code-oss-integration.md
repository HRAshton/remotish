# Code-OSS integration

Remotish uses VS Code / Code-OSS as the source-control frontend. It does not embed GitLens or maintain a custom SCM WebView.

## Stable integration surface

The main `@remotish/vscode` package uses native editor primitives for:

- virtual filesystem access;
- Source Control resource groups and input;
- menus and commands;
- Quick Diff and diff editors;
- QuickPick and status-bar branch controls;
- workspace storage APIs.

Stable VS Code types come from the local `@types/vscode` package under `types/vscode/`, vendored byte-for-byte from the controlled Code-OSS tag. The current controlled host is `1.139.1`.

## Proposal-sensitive APIs

The base `@remotish/vscode` package and the published Open VSX host are proposal-free. The repository-controlled `apps/demo-web` host additionally composes `@remotish/vscode-history`, which uses:

```text
scmHistoryProvider
timeline
```

Proposal declaration files for controlled-host qualification are committed under `types/vscode-proposed/`. The root `package.json#codeOss` object declares the exact host version, release commit, and upstream Git blob IDs for the stable and proposal declarations. Release-contract tests verify those blobs, the local `@types/vscode` version, every extension engine, and every Code-OSS Web launcher against that one host. Install and CI do not download declarations.

`@remotish/vscode-history` isolates SCM history and Timeline APIs so host-version changes do not affect the adapter SDK, core, or public VS Code host. It remains available for products that control their Code OSS build and proposal policy, but it is not a dependency of the Open VSX host artifact.

Release packaging derives a public manifest from `apps/demo-web` with the proposal declarations and history dependency removed, then bundles `apps/demo-web/src/extension-stable.ts`. `pnpm test:vscode-web:stable` exercises the proposal-free base composition, while the controlled demo and runtime-stub/history tests continue to qualify the optional history integration.

## Updating the host version

Treat a VS Code / Code-OSS version change as an integration change, not a dependency-only bump:

1. update `package.json#codeOss.version`, its exact release commit, the local `types/vscode/package.json` version, and every extension `engines.vscode` value together;
2. run `pnpm vscode:types:update` to refresh the stable and enabled proposal declarations from that exact VS Code tag via the official `@vscode/dts` tool, then record the resulting upstream Git blob IDs in `package.json#codeOss.declarationBlobs`;
3. update every `vscode-test-web` launcher to the declared release commit;
4. typecheck and run the complete test suite;
5. run the source Code-OSS Web smoke test;
6. package the VSIX and run the smoke test against the unpacked exact artifact;
7. manually qualify proposal-dependent native SCM/history behavior when adopting a new controlled host.

## Verification levels

The repository distinguishes three levels:

1. **Core/model tests** - no VS Code module.
2. **Runtime-stub tests** - execute real VFS/SCM/command/history composition against a small API-compatible stub.
3. **Code-OSS Web smoke tests** - run the extension under `@vscode/test-web`, both from the source extension and from the unpacked release VSIX.

The Web test is a smoke/integration gate, not a pixel assertion suite.

## Workspace Trust

`apps/demo-web` is the generic Remotish host. It can support untrusted workspaces because the host itself does not let workspace-controlled data select provider credentials, network origins, executable paths, or local command execution. The deterministic `extensions/fixture-provider` independently declares untrusted-workspace support for the same reason.

Production provider extensions must make their own trust decision. The host's trust declaration does not grant a provider permission to run in an untrusted workspace. If provider workspace data/settings can influence privileged behavior, use restricted/limited support rather than copying the fixture-provider declaration.

## Resource labels and workspace roots

Use a root URI with an explicit `/` path:

```text
remotish://workspace-id/
```

An authority-only URI has an empty path and can break VS Code path joining during initialization.

Contribute `resourceLabelFormatters` for `remotish` and `remotish-base` so native resource labels preserve repository identity.

## File timestamps

Remote adapters do not need to expose mtimes. The VFS maintains stable session timestamps for `FileStat` values and updates them on working-tree mutations, avoiding misleading epoch timestamps in generic VS Code features. Remote commit timestamps in Remotish history still come from adapter commit metadata.
