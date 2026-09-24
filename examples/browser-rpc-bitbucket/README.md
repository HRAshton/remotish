# Bitbucket Cloud Browser RPC reference endpoint

This is a Tampermonkey read/write example for Bitbucket Cloud. It is source-only: no built
userscript or Bitbucket credential is included in Remotish VSIXes. The source archive contains
the example template, but no customer configuration. The Bitbucket REST API
mapping stays here; the RPC adapter, Browser RPC provider, host, and core remain SCM-neutral.

## Install and configure

1. Install the Remotish host and Browser RPC provider VSIXes in a trusted Code-OSS Web window.
   Configure the provider's bridge pairing key using **Remotish Browser RPC: Configure Bridge
   Pairing Key**. See the [provider setup](../../extensions/browser-rpc-provider/README.md#customer-developer-setup).
2. Copy `userscript-template/entry.ts` and `userscript-template/metadata.txt` to this example's
   ignored `local/` directory. In both files, replace `https://code.example.invalid` with your
   exact Code-OSS HTTPS origin. In `local/entry.ts`, replace the pairing-key placeholder with the
   same customer-generated 43-character base64url key configured in the provider. Do not commit
   the local files or generated userscript.
3. From the repository root, build the single script that runs on both origins:

   ```sh
   node scripts/build-browser-rpc-userscript.mjs examples/browser-rpc-bitbucket/local/entry.ts examples/browser-rpc-bitbucket/local/metadata.txt artifacts/remotish-bitbucket.user.js
   ```

4. Install `artifacts/remotish-bitbucket.user.js` in Tampermonkey. Open a Bitbucket repository
   page such as `https://bitbucket.org/acme/widgets`. In that tab's Tampermonkey menu, choose
   **Set Bitbucket repository read/write token** and enter a Bitbucket repository access token with
   repository-read and repository-write scopes. The token is stored per exact repository target
   in this userscript's local GM storage, not in Code-OSS, Remotish workspace state, the bridge key,
   or a URL. Protect your browser profile and revoke the token when no longer needed. The Bitbucket website login
   alone is not used as REST API authentication.

   Keep the template's `@sandbox DOM` line and enable Tampermonkey's `ISOLATED_WORLD` on Chromium.
   Tampermonkey documents fallback to another enabled world if isolation is disabled; do not use
   a page-world fallback for this token-holding script. The build checks metadata, and startup
   refuses to use the key or token unless `GM_info.sandboxMode` reports `dom`. Verify the actual
   execution world in the installed Tampermonkey configuration as well; see the provider's
   [isolation pitfall](../../extensions/browser-rpc-provider/README.md#customer-developer-setup).

The example supports repository pages on `https://bitbucket.org/<workspace>/<repo-slug>` and
their child pages. Other origins, non-repository pages, and malformed slugs do not register an
endpoint. A request target must be the exact canonical URL without a trailing slash, such as
`https://bitbucket.org/acme/widgets`. Multiple Bitbucket tabs for different repositories expose
different targets; the Browser RPC broker will not route a request for one to the other. Two
tabs for the **same** repository are ambiguous until one closes.

## Open a deep link

Open a Code-OSS Web URL whose `folder` query parameter is the URL-encoded bootstrap URI. For
example, replace the Code-OSS origin and Bitbucket target in this link:

```text
https://code.example.com/?folder=remotish-rpc%3A%2F%2Fopen%2Fv1%2FaHR0cHM6Ly9iaXRidWNrZXQub3JnL2FjbWUvd2lkZ2V0cw
```

The inner URI is
`remotish-rpc://open/v1/aHR0cHM6Ly9iaXRidWNrZXQub3JnL2FjbWUvd2lkZ2V0cw`, which encodes
`https://bitbucket.org/acme/widgets`. An optional base64url-encoded `branch` query selects the
initial branch. Code-OSS first mounts a temporary `remotish-rpc://` folder and waits up to 30
seconds for the matching Bitbucket tab. After repository preparation it opens the canonical
`remotish://browser-rpc-<stable-id>/` workspace. If the tab is absent or closes, reopen the link
after opening the tab. A later tab reload creates a new endpoint session. Existing workspaces can
reconnect; an ambiguous publication is never retried.
After replacing the read-only example with this write-enabled version, reopen the Code-OSS
workspace so its adapter acquires the new capabilities; an already-open read-only adapter is not
upgraded in place.

## Behavior and limits

The endpoint implements repository metadata, immutable directory and binary-file reads, branches,
paginated commit history, commit changes, normal commit-and-publish, and branch creation/deletion.
Normal commits send binary additions/modifications and deletions to Bitbucket's source API with
`branch` and `parents=baseRevision`. Bitbucket atomically rejects a moved branch head with HTTP 409,
which Remotish reports as `REMOTE_CHANGED`. A successful result is already published at the returned
revision. Bitbucket's successful source-upload response has an empty body; the endpoint validates
the created commit SHA from the response `Location` header before reporting success. A network
failure, missing/malformed `Location`, or other malformed response after sending a write is
ambiguous; Remotish does not retry it and retains its publication-recovery protection.

Force-with-lease and amend remain unavailable: Bitbucket's REST API does not provide the atomic
ref replacement needed for those operations. Commits above a 16 MiB payload budget or more than
1000 changes are rejected before dispatch; the Browser RPC transport also rejects unsendable
frames locally. Multipart file parts carry a filename, so root files named `message`, `branch`,
`parents`, or `files` remain writable even though those names are also source API metadata fields.
Paths with control characters or invalid Unicode are rejected. Before dispatching a modification,
the endpoint reads that file's metadata at `baseRevision`.
Ordinary files, including files Bitbucket labels `binary`, can be modified. Existing files marked
`link`, `executable`, `subrepository`, or with an unknown future attribute are rejected as
`UNSUPPORTED` rather than silently changing their repository semantics. Additions create ordinary
files and deletions remain supported. This example deliberately fails closed instead of growing a
Bitbucket-specific file-mode concept into the Remotish adapter SDK.
Files above 16 MiB and oversized/overlong listings fail explicitly; they are never truncated.
Bitbucket LFS media redirects are not followed and fail as
`UNSUPPORTED`. Missing/invalid credentials, insufficient permission, missing paths, rate limits,
and service failures map to Remotish errors.

Repository identity uses Bitbucket's repository UUID, not the mutable workspace/repository slug.
A rename or transfer therefore retains the underlying identity, but the stored Browser RPC target
still uses the old URL. Open a new link to the new target and arrange any necessary workspace
restoration/migration before removing the old target; the example does not migrate stored records.

Requests use the [official Bitbucket Cloud REST API V2](https://developer.atlassian.com/cloud/bitbucket/rest/intro/)
at `https://api.bitbucket.org` with an endpoint-owned bearer token. This reflects the documented
repository, source, refs, commits, and diffstat APIs as checked in September 2026. Network JSON
and pagination URLs are validated before becoming Remotish results. No live Bitbucket service or
real credential is required by normal CI; deterministic fixtures cover the mapping.
