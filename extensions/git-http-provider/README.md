# Git HTTP provider

This independent provider opens one configured HTTPS Git clone URL in Code-OSS Web or desktop VS
Code. The repository descriptor contains only the canonical URL; credentials remain provider-owned.
The provider is part of the normal Remotish release and packaged-smoke workflow.

## Desktop setup

1. Install the Remotish host and Git HTTP provider VSIXes in a trusted workspace.
2. Run **Remotish Git HTTP: Configure Repository**. Enter the canonical HTTPS `.git` clone URL,
   author name/email and bearer token. The token is stored only in VS Code SecretStorage.
3. Run **Remotish Git HTTP: Open Repository**. The provider prepares the workspace, persists its
   URL-only reconstruction record, then opens the canonical `remotish://` folder.

The desktop transport sends `Authorization: Bearer` only to the configured Git origin and repository
path and rejects redirects. Re-running the configure command rotates the token; already-open
workspaces use the new token on their next request. Desktop uses an in-memory `memfs` object store.

## Code-OSS Web setup

1. Install the Remotish host and Git HTTP provider VSIXes in a trusted Code-OSS Web window. Generate
   one 256-bit base64url pairing key locally. Run the configure command with the Git URL, author
   identity and pairing key. The Web extension stores only the pairing key in SecretStorage; it does
   not store the Git bearer token.
2. Copy `userscript-template/entry.ts` and `metadata.txt` into this extension's ignored `local/`
   directory. Replace the Code-OSS origin, Git clone URL, pairing key, exact `@match`, and both
   `@connect` hosts. Set `redirectProbeUrl` to a public endpoint on the Code-OSS origin that always
   responds with HTTP 302 to a different URL. The probe receives no token and proves Tampermonkey's
   `redirect: 'manual'` behavior before the bridge starts. Keep `@sandbox DOM`.
3. Build the customer-specific userscript outside tracked source:

   ```sh
   node scripts/build-git-http-userscript.mjs extensions/git-http-provider/local/entry.ts extensions/git-http-provider/local/metadata.txt artifacts/remotish-git-http.user.js
   ```

4. Install the userscript on the Code-OSS origin. Use its **Set Git HTTP bearer token** menu to store
   the token in Tampermonkey storage, then open the repository with the provider command.

When rotating the Web pairing key, update the userscript and configure the provider with the same new
key. Already-open workspaces reconnect on their next request. Changing the configured clone URL
requires opening the corresponding repository workspace.

## Web bridge boundaries

The userscript performs bounded Git smart HTTP requests from the Code-OSS tab. Paired
BroadcastChannel frames use AES-GCM authentication and are bound to the current userscript session.
The userscript validates the exact Git URL, method and headers before attaching the bearer token,
uses `redirect: 'manual'` and `anonymous: true` for authenticated requests, and rejects redirect
responses or a changed final URL.

Web bridge request/response bodies are limited to 4 MiB. Cancellation aborts the Tampermonkey
request; cancellation or timeout after receive-pack dispatch remains an uncertain publication to
Remotish. The userscript retains at most 4,096 distinct request IDs per page lifetime; reload
Code-OSS to start a new session after the limit. Retaining every seen ID for a session prevents an
old authenticated write from becoming replayable through cache eviction.

## Repository limits and server requirements

The server must provide Git smart HTTP upload-pack and receive-pack and accept the configured bearer
token for both. Bitbucket Data Center 9.4 can be used directly through its HTTPS clone URL when those
requirements are met; no Bitbucket REST API is involved. Server redirects, proxy authentication
changes and nonstandard ref-update behavior fail closed.

The adapter loads remote refs and reachable objects into memory. Limits are 32 MiB per Git request,
64 MiB per response, 16 MiB per changed file, 100,000 files per tree, 10,000 branches and 10,000
history commits; Web bridge bodies are limited to 4 MiB. Repositories beyond those limits require a
separately reviewed transport/object-store design. CI uses disposable local Git HTTP fixtures; live
service qualification remains an environment-specific integration test.
