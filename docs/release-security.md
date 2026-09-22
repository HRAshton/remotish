# Release security

The release pipeline treats the browser VSIXes and source archive as supply-chain artifacts, not just build outputs.

## Release gates

A release build is expected to satisfy all of these controls:

- GitHub Actions are pinned to immutable commit SHAs.
- checkout uses `persist-credentials: false`.
- jobs use least-privilege permissions.
- the release tag must match the root package version, and the host, fixture-provider extension, and public adapter SDK versions must match that release version.
- Node.js 22 and 24 are covered by CI; release/Web smoke jobs use the minimum supported Node 22 runtime.
- project dependencies install from the frozen pnpm lockfile.
- build/release CLIs never use ephemeral package execution: the required tools are exact-version root `devDependencies`, and the committed pnpm lockfile freezes their resolved dependency graphs.
- release-contract tests reject reintroduction of ephemeral package execution in package scripts and workflows.
- the canonical `pnpm run ci` gate runs declaration-contract, lint, build/test, production-dependency policy and native pnpm SBOM checks before packaging.
- the browser host extension and deterministic fixture-provider extension are bundled and packaged with exact-version development dependencies declared in the root `package.json`; VS Code proposal declarations are committed under `types/vscode-proposed`, and release-contract tests keep their set aligned with the pinned 1.138.0 host and enabled proposals.
- VSIX contents are governed by each extension's `.vscodeignore`; the exact locally produced host and provider packages are unpacked and smoke-tested together under Code-OSS Web.
- the packaged smoke verifies manifest-only provider discovery, lazy provider activation, canonical workspace preparation, and host virtual-filesystem behavior.
- SHA-256 checksums cover both VSIXes, the source archive, SBOM, and tracked third-party notices.
- provenance attestations use GitHub OIDC via `actions/attest` and cover both VSIXes plus the other release artifacts.
- a validated CycloneDX JSON SBOM is generated and associated with the Remotish host VSIX.
- publishing uses the protected `release` environment.

A failure in a release gate blocks artifact creation/publishing.

The generic Remotish host is released as `remotish.vsix`. The released `remotish-fixture-provider.vsix` is a deterministic demo/reference provider. It is not a production repository backend and is not published to the VS Code Marketplace.

## Consumer verification

Release consumers can verify integrity and provenance with the release's `SHA256SUMS` and GitHub attestations:

```sh
sha256sum -c SHA256SUMS
gh attestation verify remotish.vsix -R HRAshton/remotish
gh attestation verify remotish-fixture-provider.vsix -R HRAshton/remotish
```

Use the repository/release coordinates that correspond to the artifact you downloaded if the project is mirrored or renamed.

## VSIX artifact gate

`pnpm test:vscode-web:vsix` performs the important packaging-path check:

1. builds the framework, host browser bundle, and fixture-provider browser bundle;
2. packages `remotish.vsix` and `remotish-fixture-provider.vsix` independently;
3. unpacks those exact locally produced VSIXes into the smoke-test layout;
4. injects the test bundle only into the unpacked host smoke-test copy;
5. runs provider discovery/lazy activation plus host command and virtual-filesystem behavior under Code-OSS Web.

The packaged file sets are controlled by `apps/demo-web/.vscodeignore` and `extensions/fixture-provider/.vscodeignore`; `vsce ls --no-dependencies` is the standard way to inspect either set when changing packaging rules. Release-contract tests pin the host ignore rules and verify the promoted provider manifest/package path.

Tests are injected only into the unpacked smoke-test copy, not into either release VSIX. Canonical cold restoration through the discovered-provider mechanism is covered separately by the deterministic runtime-stub tests.

## Proposed API distribution constraint

The host intentionally uses `scmActionButton`, `scmHistoryProvider`, and `timeline`. The host release is therefore aimed at the controlled Code-OSS distribution described in [Code-OSS integration](code-oss-integration.md), not an ordinary Marketplace-compatible extension unless those proposal dependencies are removed or otherwise made compliant.

The current target is VS Code / Code-OSS 1.138.0. Requalify before changing that host version.

## Locked build and release tooling

The project intentionally does not execute registry-resolved one-off CLIs during install, CI, or release. Build, analysis, documentation, VS Code test, and packaging tools are exact-version root `devDependencies` and are invoked through normal package scripts, which resolve executables from the local installation. The committed `pnpm-lock.yaml` is expected to freeze the complete resolved dependency graph; regenerate and commit it whenever `package.json` changes, and keep CI/release on `pnpm install --frozen-lockfile`.

VS Code proposed API declarations are vendored from the supported 1.138.0 declaration set instead of being downloaded from a package postinstall hook. Maintainers refresh them explicitly with the exact `@vscode/dts` devDependency; the release-contract tests also reject ephemeral executors such as `pnpm dlx`, `pnpx`, `npx`, and `npm exec` from package scripts and workflows.

Before CI or release, regenerate and commit `pnpm-lock.yaml` with the pinned pnpm version after any dependency change. CI deliberately uses `pnpm install --frozen-lockfile` so an absent or stale lockfile fails closed.

## Licensing and notices

Remotish source uses the `0BSD` license. The current workspace has no third-party production npm dependencies: production edges are only internal `@remotish/*` workspace packages. Release-contract tests enforce that invariant, and the tracked `THIRD_PARTY_NOTICES.md` is copied into release artifacts. The fixture-provider VSIX includes the project `0BSD` license. If an external runtime dependency is introduced, the contract test fails until dependency licensing/notices handling is made explicit and the notice is updated.

## Vulnerability reporting

Do not report suspected vulnerabilities in a public issue. Follow [SECURITY.md](../SECURITY.md) for the repository's private reporting path and disclosure expectations.

## npm publishing

`@remotish/adapter-sdk` is the public npm package for third-party adapter authors. Tag releases publish it only after the package/release gates succeed. The workflow checks that the git tag, root version and adapter SDK version agree, builds the SDK, inspects the npm tarball with `npm pack --dry-run`, and publishes the scoped package with public access.

Publishing is designed for npm Trusted Publishing with GitHub Actions OIDC. Configure the `@remotish/adapter-sdk` package on npmjs.com with this repository and `.github/workflows/release.yml` as its trusted publisher, and protect the GitHub `npm` environment as appropriate. No long-lived `NPM_TOKEN` is expected in the workflow.

For a beta version such as `0.1.0-beta.1`, publish with the `beta` npm dist-tag rather than replacing `latest`. Stable versions can use the default `latest` dist-tag.
