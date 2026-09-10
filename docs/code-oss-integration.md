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

Stable VS Code types come from the pinned `@types/vscode` package (`1.138.0` in this repository).

## Proposal-sensitive APIs

The controlled demo also uses:

```text
scmActionButton
scmHistoryProvider
timeline
```

Proposal declaration files for the controlled host are committed under `types/vscode-proposed/`. Release-contract tests verify that the pinned `@types/vscode`, extension engine, enabled proposal list, and vendored declaration set stay aligned. Install and CI do not download proposal declarations.

`@remotish/vscode-history` isolates SCM history and Timeline APIs so host-version changes do not affect the adapter SDK or core.

The demo enables these proposals because it targets a controlled Code-OSS/Web distribution. A normal Marketplace extension must follow Marketplace/proposed-API rules and may need to omit proposal-dependent features.

## Updating the host version

Treat a VS Code / Code-OSS version change as an integration change, not a dependency-only bump:

1. update the pinned `@types/vscode` and extension `engines.vscode` values together;
2. run `pnpm vscode:types:update` to refresh the enabled proposal declarations from that exact VS Code tag via the official `@vscode/dts` tool, then review and commit the resulting files;
3. typecheck and run the complete test suite;
4. run the source Code-OSS Web smoke test;
5. package the VSIX and run the smoke test against the unpacked exact artifact;
6. manually qualify proposal-dependent native SCM/history behavior when adopting a new controlled host.

## Verification levels

The repository distinguishes three levels:

1. **Core/model tests** - no VS Code module.
2. **Runtime-stub tests** - execute real VFS/SCM/command/history composition against a small API-compatible stub.
3. **Code-OSS Web smoke tests** - run the extension under `@vscode/test-web`, both from the source extension and from the unpacked release VSIX.

The Web test is a smoke/integration gate, not a pixel assertion suite.

## Workspace Trust

`apps/demo-web` declares untrusted workspace support because its fixture cannot use workspace-controlled data to choose credentials, request origins, executable paths or local command execution.

Production integrations must reassess this. If workspace data/settings can influence privileged behavior, use restricted/limited support rather than copying the demo declaration.

## Resource labels and workspace roots

Use a root URI with an explicit `/` path:

```text
remotish://workspace-id/
```

An authority-only URI has an empty path and can break VS Code path joining during initialization.

Contribute `resourceLabelFormatters` for `remotish` and `remotish-base` so native resource labels preserve repository identity.

## File timestamps

Remote adapters do not need to expose mtimes. The VFS maintains stable session timestamps for `FileStat` values and updates them on working-tree mutations, avoiding misleading epoch timestamps in generic VS Code features. Remote commit timestamps in Remotish history still come from adapter commit metadata.
