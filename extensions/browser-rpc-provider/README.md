# Remotish Browser RPC provider

This browser-safe extension declares one static `browser-rpc` Remotish provider. A browser tab or
session is an ephemeral RPC endpoint, not another provider. Merely opening a Bitbucket, GitHub, or
other SCM tab does not register a Remotish provider.

Repository requests use only `{ "target": "https://example.com/owner/repository" }`. The target
is normalized as a URL; credentials, queries, fragments, unknown descriptor fields, and non-loopback
HTTP are rejected. The target must not contain secrets in its path. The selected branch remains the
normal Remotish request field, not part of the descriptor.

The endpoint broker keeps registrations in memory. It checks authenticated userscript origin before
an endpoint's target claim, rejects ambiguous matches, and bounds waits to 30 seconds. Endpoint
session capabilities are validated before the transport-neutral `RpcAdapter` is returned. A live
compatible endpoint may replace a reloaded tab for later calls; re-pairing also reconnects on the
next call from an existing adapter. An ambiguous in-flight publication is never retried. The
provider persists only a credential-free target for canonical workspace restoration.

## Customer-developer setup

Install the released Browser RPC provider VSIX alongside the Remotish host in a trusted Code-OSS
window. The provider is disabled in Restricted Mode: a repository request can direct privileged
network activity, so Workspace Trust is required. It remains discoverable without activation;
opening a repository or invoking its pairing command activates it.

The customer-developer chooses both the Code-OSS host origin and each SCM endpoint origin. Copy
`userscript-template/entry.ts`, `customer-endpoint.ts`, and `metadata.txt` into
`extensions/browser-rpc-provider/local/` (gitignored). Replace the two `.invalid` example origins
in both the TypeScript runtime allowlist and the Tampermonkey `@match` lines with exact customer
origins. Never use a catch-all `@match`. For
multiple SCM origins, add each exact origin to both places. The userscript must be **one script
installed on both host and endpoint origins**: Tampermonkey `GM_*` storage is isolated per
userscript, so two separately installed scripts cannot share this mailbox.

Generate a fresh 256-bit base64url key locally (for example,
`node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`). Put it in
the local `entry.ts` copy and run the VS Code command `Remotish Browser RPC: Configure Bridge
Pairing Key` with the same value. The provider stores its copy in VS Code SecretStorage. Do not
commit, publish, log, or put this key in repository descriptors, URLs, or workspace settings.
Re-pairing disconnects the old host session. Anyone with the key and access to a matched userscript
context can impersonate an endpoint; treat the generated userscript and its bundled endpoint code
as trusted software.

Replace `customer-endpoint.ts` with a synchronous `createEndpoint()` function that returns a
`UserscriptEndpoint` only on a supported endpoint page. Its `target` must be the canonical HTTPS
repository URL on that page's origin. Its `session` is `{ version: 1, capabilities: ... }` as
defined by `@remotish/adapter-rpc`; `handle(request, signal)` receives a validated V1 RPC request
and returns the operation's domain result. Implement only the nine defined repository operations;
the runtime encodes success or an error code. Keep site credentials and API calls entirely inside
this endpoint implementation. Do not obtain a handler, token, or origin from page globals; bundle
trusted handler code into the same userscript. The template deliberately supplies no SCM backend.
For a concrete read-only implementation, see the
[Bitbucket Cloud userscript example](../../examples/browser-rpc-bitbucket/README.md). It is not
bundled in the provider VSIX and requires its own customer-managed Bitbucket token.

Build the local copy with the repository's pinned tool:

```sh
node scripts/build-browser-rpc-userscript.mjs extensions/browser-rpc-provider/local/entry.ts extensions/browser-rpc-provider/local/metadata.txt artifacts/customer-browser-rpc.user.js
```

Install that output in Tampermonkey, open the endpoint tab, and request
`{ "provider": "browser-rpc", "repository": { "target": "https://your-scm.example/repo" } }`
through `remotish.ensureRepository`. The `target` must exactly match the endpoint's target after
URL normalization. Source-only template files and customer secrets are not included in the VSIX.

## Bootstrap web link

The unresolved repository link uses `remotish-rpc://open/v1/<target>`, where `<target>` is the
base64url encoding of the UTF-8 normalized repository URL, without padding. An optional
`?branch=<base64url-utf8-branch>` selects an initial branch; it is not part of the repository
descriptor or stable workspace ID. A branch such as `feature/test` therefore stays in the query
as `ZmVhdHVyZS90ZXN0`, not in a path segment. For example, this Code-OSS Web URL opens a bootstrap folder for
`https://example.com/browser-rpc-smoke`:

```text
https://code-oss.example/?folder=remotish-rpc%3A%2F%2Fopen%2Fv1%2FaHR0cHM6Ly9leGFtcGxlLmNvbS9icm93c2VyLXJwYy1zbW9rZQ
```

Replace the Code-OSS origin and target for your deployment, then URL-encode the complete
`remotish-rpc://` URI as the outer `folder` value. The extension must already have its bridge
pairing key configured. Code-OSS mounts a temporary read-only folder while the provider waits up
to 30 seconds for a matching endpoint. Open the compatible SCM tab during that wait. On success,
the provider calls `remotish.ensureRepository`, selects the requested branch if present, persists
`{ version: 1, target }` in its own global state, then opens the returned canonical
`remotish://<stable-workspace-id>/` root. Branch-bearing links require a host supporting the
SDK's versioned `remotish.selectPreparedBranch` command; the provider checks that support before
repository preparation. It does not call `remotish.openRepository` as a second preparation step.
Closing the temporary folder cancels late navigation; after a timeout or other failure, reopen
the link to retry.

On a later Code-OSS restart, `restoreWorkspace()` returns that validated target. The host then
reconnects to an endpoint and recomputes the stable workspace ID before registering the canonical
workspace. The selected branch and working overlay remain in core-owned state. Missing endpoints,
pairing errors, or failed restoration never delete that overlay.

## Transport and trust

The host extension's browser worker and the host-side userscript relay exchange AES-256-GCM packets
over `BroadcastChannel`. The same userscript relays packets through per-script `GM_*` storage to
the endpoint tab, in bounded chunks. Page scripts can observe or replay broadcast ciphertext but
cannot forge authenticated frames without the pairing key. The endpoint runtime derives its origin
from `location.origin`; the handler cannot supply it. This origin binding assumes the customer
installs only trusted endpoint code in the key-holding userscript on the configured `@match`
origins. A malicious or compromised key-holding userscript can claim any origin; no browser bridge
can independently repair that trust violation.

Transport V1 and repository RPC V1 are separately versioned and strictly decoded. Host, endpoint,
and request IDs are random; endpoint counters and retained request IDs reject captured-frame replay
within a session. The host rejects stale endpoint IDs after disconnect or timeout. Heartbeats run
every five seconds; an endpoint absent for fifteen seconds is removed. Calls time out after sixty
seconds, cancellation is best-effort across tabs, and late responses cannot settle a new request.
There are at most 32 registered endpoints and 32 pending host requests. Each decoded frame is
limited to 24 MiB, each encrypted packet to 32 MiB of base64url text, and retained mailbox packets
to 96 MiB of text. A locally unsendable commit returns a settled `UNSUPPORTED` rejection without
publishing; an oversized file response returns `INVALID_REQUEST`. Failures after dispatch remain
uncertain for publication. Files never truncate. A browser/tab
crash may leave mailbox data
until the ninety-second retention sweep. Authentication tokens never enter pairing, descriptors,
workspace state, or generic RPC diagnostics.

To prevent replay of publication requests, an endpoint retains request IDs for its tab lifetime;
it fails closed after 65,536 distinct requests. Reload that endpoint tab to start a fresh session
if this limit is reached. The mailbox is not a durable job queue and does not retry commits.
