# Controlled-host Remotish

The public Open VSX package and the controlled-host package intentionally have different API
boundaries.

- `remotish.vsix` is the public/Open VSX artifact. It uses only stable VS Code APIs and does not
  include `@remotish/vscode-history`.
- `remotish-controlled.vsix` is the independently distributed controlled-host artifact. It keeps
  the `hrashton.remotish` extension identity, declares `scmHistoryProvider` and `timeline`, and
  includes `@remotish/vscode-history`.

The controlled artifact is published only as a Remotish GitHub Release asset. It is not published to
Open VSX, and Code OSS Static Web (COSW) does not bundle, preinstall, download, or redistribute it.

## Host compatibility contract

COSW issue [#17](https://github.com/HRAshton/code-oss-static-web/issues/17) defines the host-side
contract. Its implementation in
[PR #18](https://github.com/HRAshton/code-oss-static-web/pull/18) grants only
`hrashton.remotish` access to:

```text
scmHistoryProvider
timeline
```

The grant landed after the currently published COSW `v1.139.1-web.1` release. That release
therefore does not contain the grant and is not a qualified native-history host.

## Support matrix

Native SCM History and file Timeline are supported only for rows explicitly marked **Qualified**.

| Remotish controlled artifact | COSW release | Code-OSS | Status |
| --- | --- | --- | --- |
| — | `v1.139.1-web.1` | `1.139.1` / `04c0d99f4fb0d8afe6ce4f0c58e31e183ac3e4b1` | Not qualified; release predates the scoped Remotish proposal grant |
| — | — | — | No qualified released pair yet |

Do not infer compatibility from the Code-OSS version alone. A COSW release must contain the scoped
proposal grant and must pass the artifact-level qualification below before a Remotish version is
added as a Qualified row.

## Qualification requirements

The normal `pnpm test:vscode-web:controlled-vsix` gate packages and unpacks the exact
`remotish-controlled.vsix` artifact and checks its extension identity, proposal declarations,
history dependency, activation, deterministic fixture preparation, and normal virtual-filesystem
behavior under the pinned Code-OSS build. This catches controlled-artifact packaging regressions,
but it is not sufficient to declare a COSW release pair supported.

Before adding a Qualified row, run browser qualification with the exact Remotish controlled VSIX
installed into the exact COSW release artifact. Qualification must fail on any regression in:

1. scoped proposal permission for `hrashton.remotish`;
2. the `scmHistoryProvider` or `timeline` proposal shape;
3. extension activation;
4. SCM History rendering of the deterministic fixture commits and parents;
5. history-item resolution and changed-file enumeration;
6. revision-pinned original/modified resources and diff opening; or
7. file Timeline entries and their revision commands.

Record the exact Remotish version, COSW release tag, and pinned Code-OSS version/commit in the support
matrix only after that browser run passes.

The controlled VSIX remains a Remotish distribution artifact throughout qualification. COSW's
proposal grant is host compatibility configuration and does not make Remotish a COSW runtime,
SBOM, or license-inventory component.
