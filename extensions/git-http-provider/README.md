# Git HTTP provider pilot

This independent provider opens one configured HTTPS Git clone URL. It works in Code-OSS Web and
desktop VS Code. It is a pilot package and is not part of the release workflow.

## Desktop setup

1. Install the Remotish host and this provider VSIX in a trusted workspace.
2. Run **Remotish Git HTTP: Configure Repository**. Enter the canonical HTTPS `.git` clone URL,
   author name/email and bearer token. The token is stored only in VS Code SecretStorage. The
   descriptor and restoration record contain only the validated URL.
3. Run **Remotish Git HTTP: Open Repository**. The provider prepares the workspace, persists its
   URL-only reconstruction record, then opens the canonical `remotish://` folder.

The desktop transport sends `Authorization: Bearer` only to the exact configured Git origin and
repository path. Redirects are disabled. Token rotation uses the configure command again.
Desktop uses a heap-only `memfs` object store; Web uses a heap-only LightningFS store.

## Code-OSS Web setup

1. Install the host and provider VSIXes in a trusted Code-OSS Web window. Generate one 256-bit
   base64url pairing key locally. Run the configure command with the same Git URL, author identity
   and pairing key. The Web extension stores only the pairing key in SecretStorage; it never stores
   the Git token.
2. Copy `userscript-template/entry.ts` and `metadata.txt` into this extension's ignored `local/`
   directory. Replace the Code-OSS origin, Git clone URL, pairing key, exact `@match` and both
   `@connect` hosts. Set `redirectProbeUrl` to a public endpoint on the Code-OSS origin that always
   responds with HTTP 302 to a different URL. The probe receives no token. Its response must expose
   the original `finalUrl` and status 302 under Tampermonkey's `redirect: 'manual'` option; otherwise
   the script refuses to start. Keep `@sandbox DOM` and Tampermonkey's isolated world.
3. Build the customer script outside tracked source:

   ```sh
   node scripts/build-git-http-userscript.mjs extensions/git-http-provider/local/entry.ts extensions/git-http-provider/local/metadata.txt artifacts/remotish-git-http.user.js
   ```

4. Install the script on the Code-OSS origin. Use its **Set Git HTTP pilot bearer token** menu to
   store the token in Tampermonkey storage. Open the repository with the provider command.

The script makes bounded Git smart HTTP requests from the Code-OSS tab. It has no Bitbucket tab and
no repository-semantic RPC endpoint. The paired BroadcastChannel frames are AES-GCM authenticated;
the userscript validates the exact Git URL, method and headers before attaching the token. It uses
`redirect: 'manual'` on every authenticated request and rejects redirect responses or a changed
final URL. Requests and responses are each limited to 4 MiB in Web. Cancellation aborts the
Tampermonkey request; a cancellation or timeout during publication remains uncertain to Remotish.

## Bitbucket Data Center 9.4 pilot

Use a Bitbucket Data Center 9.4 test repository's HTTPS clone URL, for example
`https://bitbucket.example.com/scm/PRJ/repo.git`. The server must enable Git smart HTTP
upload-pack and receive-pack and accept bearer tokens for both. The token needs repository read and
write permission, subject to branch restrictions. This package has no Bitbucket REST dependency.
Server redirects, proxy authentication changes and nonstandard ref update behavior fail closed.

The adapter loads all remote refs and reachable objects into memory. Limits are 32 MiB per Git
request, 64 MiB per response, 16 MiB per changed file, 100,000 files per tree, 10,000 branches and
10,000 history commits; Web bridge bodies are limited to 4 MiB. Larger repositories need a
separately reviewed transport/object-store design. No live Bitbucket service is used by CI.
