# Contributing to Remotish

Contributions are welcome when they preserve the project's central boundary: adapters describe repository semantics; Remotish owns workspace/editor semantics.

## Development setup

Requirements: Node.js 22.x or 24.x and Corepack.

```bash
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm test
```

For the complete repository gate run:

```bash
corepack pnpm run ci
```

For the browser demo:

```bash
corepack pnpm vscode:web
```

See [docs/maintainers/development.md](docs/maintainers/development.md) for the full command/reference guide.

## Before opening a change

- Keep adapters dependent on `@remotish/adapter-sdk`, not core/VS Code packages.
- Add/update deterministic tests for behavioral changes.
- Update canonical documentation when public semantics change.
- Run `pnpm format` or `pnpm fix` before submitting formatting-sensitive changes.
- Do not commit build output, release artifacts, tool caches or dependency directories. The proposal declarations in `types/vscode-proposed/` are intentionally committed and integrity-pinned.

## Public API changes

Changes to `@remotish/adapter-sdk` require special care because third-party adapters depend on that boundary. Include:

- the behavioral reason for the change;
- compatibility impact;
- fixture/reference-adapter updates;
- contract tests;
- matching updates to `docs/adapter-contract.md` and `docs/adapter-authoring.md` when relevant.

## VS Code / Code-OSS changes

Proposal-sensitive APIs are deliberately isolated. A host-version change must be validated against both the source extension and packaged VSIX Web smoke paths. See [docs/code-oss-integration.md](docs/code-oss-integration.md).

## Security reports

Do not open a public issue for a suspected vulnerability. Follow [SECURITY.md](SECURITY.md).
