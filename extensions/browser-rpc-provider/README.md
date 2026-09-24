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
compatible endpoint may replace a reloaded tab for later calls; an ambiguous in-flight publication
is never retried. This provider does not yet implement canonical workspace restoration, so it
supports session-local `remotish.ensureRepository` preparation but not navigation/reload.

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

Build the local copy with the repository's pinned tool:

```sh
node scripts/build-browser-rpc-userscript.mjs extensions/browser-rpc-provider/local/entry.ts extensions/browser-rpc-provider/local/metadata.txt artifacts/customer-browser-rpc.user.js
```

Install that output in Tampermonkey, open the endpoint tab, and request
`{ "provider": "browser-rpc", "repository": { "target": "https://your-scm.example/repo" } }`
through `remotish.ensureRepository`. The `target` must exactly match the endpoint's target after
URL normalization. Source-only template files and customer secrets are not included in the VSIX.

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
to 96 MiB of text. A file exceeding these limits fails explicitly, never truncates. A browser/tab
crash may leave mailbox data
until the ninety-second retention sweep. Authentication tokens never enter pairing, descriptors,
workspace state, or generic RPC diagnostics.

To prevent replay of publication requests, an endpoint retains request IDs for its tab lifetime;
it fails closed after 65,536 distinct requests. Reload that endpoint tab to start a fresh session
if this limit is reached. The mailbox is not a durable job queue and does not retry commits.
