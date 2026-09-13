# Maintainer development guide

## Toolchain

The repository supports Node.js 22.x and 24.x. Node 22 is the local-development baseline. The package manager is pinned in `package.json`.

```bash
corepack enable
corepack pnpm install --frozen-lockfile
```

The committed proposal declaration set is validated by the release-contract tests. Install and CI do not fetch proposal declarations; maintainers update them explicitly with the pinned `@vscode/dts` tool.

## Daily checks

Fast feedback:

```bash
corepack pnpm check:biome
corepack pnpm test:unit
```

Full local validation:

```bash
corepack pnpm run ci
```

The `ci` script covers the VS Code declaration contract, Biome, dependency boundaries, dead code/dependency declarations, TypeDoc and Markdown validation, compilation/tests, production-dependency policy and SBOM generation.

## Useful commands

```bash
# Apply formatting
corepack pnpm format

# Apply Biome formatting/safe fixes/import organization
corepack pnpm fix

# Check repository Markdown links
corepack pnpm lint:markdown

# All non-live tests
corepack pnpm test

# Adapter-focused tests
corepack pnpm test:adapter

# Run browser demo
corepack pnpm vscode:web

# Source extension Web smoke test
corepack pnpm test:vscode-web

# Package and smoke-test exact VSIX contents
corepack pnpm test:vscode-web:vsix

# Optional small live GitHub read-only smoke test
corepack pnpm test:github-live
```

## Updating VS Code proposal declarations

When changing the controlled VS Code / Code-OSS host version, update `@types/vscode` and `engines.vscode`, then refresh the vendored proposal declarations explicitly:

```bash
corepack pnpm vscode:types:update
```

Review and commit the resulting files under `types/vscode-proposed`. Install and CI do not fetch proposal declarations.

## Dependency boundaries

The intended direction is:

```text
adapter-sdk -> core -> vscode -> vscode-history
     │
     └------> adapters
```

Adapters may depend on `@remotish/adapter-sdk` and their transport libraries. They must not import framework internals or VS Code.

Dependency Cruiser enforces these boundaries; do not bypass them with deep relative/package-source imports.

## Coding conventions

- Use braced control flow.
- Prefer `async`/`await` for sequential asynchronous work.
- Give repeated/non-trivial domain shapes a name instead of duplicating inline object types.
- Validate untrusted transport data before it enters SDK/domain values.
- Public API JSDoc should explain semantics, invariants or responsibility rather than restating names.
- Prefer small explicit code over speculative service abstractions.
- Keep production code browser-safe unless a package is explicitly host-specific.

## Changing the adapter SDK

Treat `@remotish/adapter-sdk` as the highest-cost API to change.

Before changing it:

1. state the semantic need, not just the desired method shape;
2. determine whether the behavior belongs in an adapter or in core;
3. update the fixture/reference adapters and contract tests together;
4. update [Adapter contract](../adapter-contract.md) in the same change;
5. verify existing adapters still typecheck or document the compatibility break.

Do not add capabilities as roadmap markers. A capability belongs in the SDK only when there is a corresponding framework operation and exact behavioral contract.

## Changing VS Code integration

Keep editor API handling out of adapters/core. Proposal-sensitive history APIs stay in `@remotish/vscode-history` where possible.

Any host-version change must follow the qualification path in [Code-OSS integration](../code-oss-integration.md).

## Release work

See [Release security](../release-security.md) for the release gate and artifact expectations.
