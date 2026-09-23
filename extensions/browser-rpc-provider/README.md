# Remotish Browser RPC provider

This browser-safe extension declares one static `browser-rpc` Remotish provider. A browser tab or
session is an ephemeral RPC endpoint, not another provider. Merely opening a Bitbucket, GitHub, or
other SCM tab does not register a Remotish provider.

Repository requests use only `{ "target": "https://example.com/owner/repository" }`. The target
is normalized as a URL; credentials, queries, fragments, unknown descriptor fields, and non-loopback
HTTP are rejected. The target must not contain secrets in its path. The selected branch remains the
normal Remotish request field, not part of the descriptor.

The endpoint broker keeps registrations in memory. It checks trusted transport origin before an
endpoint's target claim, rejects ambiguous matches, and bounds waits to 30 seconds. Endpoint session
capabilities are validated before the transport-neutral `RpcAdapter` is returned. This PR supplies
only the in-memory broker and deterministic fake endpoints; browser-wide transport and real SCM
endpoints are not yet present. The provider does not implement canonical workspace restoration, so
it can support session-local `remotish.ensureRepository` preparation but not navigation/reload.
