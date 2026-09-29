# Support and compatibility

This page defines the compatibility and qualification scope for the Remotish 1.x line.

## 1.0 release-candidate status

`1.0.0-rc.1` is the first candidate for the 1.0 compatibility contract. Release candidates are intended for final integration and deployment qualification and may still change before `1.0.0`.

Once `1.0.0` is published, the public `@remotish/adapter-sdk` package-root API follows semantic versioning for the 1.x line.

## Public compatibility boundary

The supported third-party adapter API is limited to symbols exported from the `@remotish/adapter-sdk` package root and the semantics documented in [Adapter contract](adapter-contract.md).

The following are not public compatibility surfaces unless a future release explicitly says otherwise:

- source-path or internal imports;
- `@remotish/core`, `@remotish/vscode`, `@remotish/vscode-history`, and reference-adapter internals;
- proposed VS Code API integration;
- workspace persistence file/layout details;
- test helpers, build scripts, and demo implementation details.

Provider extensions should communicate with the host through the versioned provider contract exported by `@remotish/adapter-sdk`, not through framework internals.

## Qualified matrix

| Surface | 1.0 qualification |
| --- | --- |
| Code-OSS / VS Code API baseline | 1.139.1 |
| Code-OSS Web | 1.139.1, release-qualified with packaged VSIX smoke tests |
| Browser | Chromium-compatible runtime used by the release Web qualification |
| Node.js | 22.x and 24.x for SDK/tooling/CI |
| Public Remotish host | Stable VS Code APIs only |
| SCM History / Timeline | Controlled-host integration through `@remotish/vscode-history`; proposed API, not part of the public registry host contract |
| GitHub provider | Browser, anonymous public GitHub repositories |
| Browser RPC provider | Browser, trusted workspace, customer-supplied authenticated endpoint |
| Git HTTP provider | Web and desktop provider paths; credential handling differs by host |
| Fixture provider | Demo/reference/testing only |

Extension manifests accept compatible VS Code versions through their engine range, but the release gate qualifies the pinned Code-OSS 1.139.1 revision. A host-version change is an integration change and must be requalified before it becomes the documented baseline.

The Git HTTP provider has a packaged desktop entry point and desktop transport tests. End-to-end release qualification is centered on the pinned Code-OSS Web build; products embedding Remotish in a controlled desktop host should run their own integration smoke against that host.

## Upgrade policy

For stable 1.x releases:

- incompatible changes to the public adapter SDK contract require a major version;
- additive compatible SDK capabilities may ship in a minor version;
- compatible fixes may ship in a patch version;
- internal implementation and non-public integration surfaces may change in minor or patch releases when the documented public adapter contract is preserved.

Persistence is an implementation detail rather than a third-party API. Releases should preserve user working state where practical, but consumers that depend on a specific on-disk/storage representation must treat that representation as unsupported.

## Security support

During the 1.0 release-candidate phase, security fixes target the actively maintained main line and the latest 1.0 release candidate where practical. After `1.0.0`, the actively maintained 1.x line and latest supported stable release are the supported upgrade targets. See [Security policy](../SECURITY.md) for reporting and disclosure.
