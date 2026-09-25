# Bitbucket Data Center 9.4 Browser RPC reference endpoint

This is a Tampermonkey example for Bitbucket Data Center 9.4. It exposes repository metadata,
immutable file reads, branches, commit history, commit changes, and branch creation/deletion through
the Browser RPC provider. It is source-only: no built userscript or Bitbucket credential is included
in Remotish VSIXes.

The example intentionally does **not** advertise commit publication, force-with-lease, or amend.
Bitbucket Data Center's public REST API can edit one file with `PUT .../browse/{path}`, but that
operation guards the prior version of that file with `sourceCommitId`; it does not provide the
branch-head compare-and-swap required by the Remotish publication contract. It also does not provide
a general atomic multi-file commit endpoint. Approximating publication with a sequence of file edits
could silently build on a moved branch and could partially publish a Remotish change set, so this
endpoint fails closed instead.

## Install and configure

1. Install the Remotish host and Browser RPC provider VSIXes in a trusted Code-OSS Web window.
   Configure the provider's bridge pairing key using **Remotish Browser RPC: Configure Bridge
   Pairing Key**. See the
   [provider setup](../../extensions/browser-rpc-provider/README.md#customer-developer-setup).
2. Copy `userscript-template/entry.ts` and `userscript-template/metadata.txt` to this example's
   ignored `local/` directory. Replace `https://code.example.invalid` with the exact Code-OSS HTTPS
   origin and `https://bitbucket.example.invalid` with the exact Bitbucket Data Center origin in
   both files. In `local/entry.ts`, replace the pairing-key placeholder with the same customer-
   generated 43-character base64url key configured in the provider. Do not commit the local files
   or generated userscript.
3. From the repository root, build the single script that runs on both origins:

   ```sh
   node scripts/build-browser-rpc-userscript.mjs examples/browser-rpc-bitbucket-datacenter/local/entry.ts examples/browser-rpc-bitbucket-datacenter/local/metadata.txt artifacts/remotish-bitbucket-datacenter.user.js
   ```

4. Install `artifacts/remotish-bitbucket-datacenter.user.js` in Tampermonkey. Open a repository page,
   for example `https://bitbucket.example.com/bitbucket/projects/PRJ/repos/widgets/browse`. In that
   tab's Tampermonkey menu, choose **Set Bitbucket Data Center access token** and enter a personal,
   project, or repository HTTP access token suitable for that repository. The REST requests use
   `Authorization: Bearer <token>`. Read operations require repository read permission; branch
   creation/deletion requires repository write permission and remains subject to branch permissions.
   The token is stored per exact repository target in this userscript's GM storage, not in Code-OSS,
   Remotish workspace state, the bridge key, or a URL.

   Keep the template's `@sandbox DOM` line and enable Tampermonkey's `ISOLATED_WORLD` on Chromium.
   Do not run this key- and token-holding script in the page world. The builder rejects missing or
   changed sandbox metadata, and runtime startup refuses to use the key or token unless
   `GM_info.sandboxMode` reports `dom`.

The userscript `@match` must name the exact Bitbucket origin. The endpoint accepts normal project
repository pages under `/projects/<projectKey>/repos/<repoSlug>` and personal repositories under
`/users/<userSlug>/repos/<repoSlug>`, with an arbitrary Bitbucket context path before those routes.
For example, both `/bitbucket/projects/PRJ/repos/widgets/browse` and
`/bitbucket/users/alice/repos/widgets/browse` are supported. HTTPS is required except for loopback
HTTP development origins, matching the Browser RPC target policy.

## Open a deep link

The Browser RPC target is the canonical repository UI URL through the repository segment, without a
trailing slash, query, fragment, or child page. For the example above it is:

```text
https://bitbucket.example.com/bitbucket/projects/PRJ/repos/widgets
```

Encode that target with base64url and place it in the standard
`remotish-rpc://open/v1/<target>` bootstrap URI. An optional base64url-encoded `branch` query selects
the initial branch. The Code-OSS host waits for the matching Bitbucket tab and then opens the
canonical `remotish://` workspace. Multiple tabs for the same repository are ambiguous until only
one remains.

## Behavior and limits

Repository identity combines the Bitbucket server base/context path with the repository's numeric
ID, so project/repository renames do not create a new underlying identity. The Browser RPC target is
still URL-based; after a rename or project move, open a new link for the new target and arrange any
necessary workspace restoration/migration before removing the old target.

Directory reads use Bitbucket's recursive `files` endpoint at the requested full commit SHA and
reduce the returned file paths to immediate children. Raw file reads preserve exact bytes. History
uses paged `commits` results and opaque numeric page cursors. Commit changes map Bitbucket ADD,
MODIFY, DELETE, MOVE, and COPY records to Remotish change records. Responses are bounded: JSON is
limited to 2 MiB, file payloads to 16 MiB, listings to 10,000 items and 100 pages. Redirects are not
followed, so credentials are never forwarded to another origin.

Branch creation and deletion use `/rest/branch-utils/1.0`. Branch creation starts from a full 40-hex
commit ID. Branch deletion sends a fully qualified `refs/heads/...` name and relies on Bitbucket's
normal permission/branch-restriction checks. Bitbucket Data Center 9.4 added a `no-creates` branch
permission; a server that denies the requested mutation is surfaced as a Remotish error.

The endpoint's session capabilities are therefore:

```ts
{
  commits: false,
  createBranch: true,
  deleteBranch: true,
}
```

`forceWithLease` and `amend` are absent. A direct RPC `commit` call is rejected as `UNSUPPORTED`
without making a network request.

The REST mapping targets Bitbucket Data Center 9.4's documented repository APIs under
`/rest/api/1.0` and branch utility APIs under `/rest/branch-utils/1.0`. See Atlassian's
[Bitbucket Data Center 9.4 REST reference](https://developer.atlassian.com/server/bitbucket/rest/v904/api-group-repository/).
No live Bitbucket service or real credential is required by normal CI; deterministic fixtures cover
the mapping.
