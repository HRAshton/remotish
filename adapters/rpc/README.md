# Remotish RPC adapter

`@remotish/adapter-rpc` implements the Remotish adapter contract over a caller-supplied RPC transport. It has no editor, browser-tab, or SCM-service dependency. A transport correlates calls, forwards `AbortSignal`, and supplies a versioned response for each request. Authentication stays with the transport and endpoint.

```ts
import { RpcAdapter } from '@remotish/adapter-rpc';

const adapter = new RpcAdapter(transport, {
  version: 1,
  capabilities: { commits: false },
});
```

Session metadata is validated synchronously, before the adapter is exposed. Optional methods exist only when the endpoint advertises them. A transport must supply trustworthy metadata from its connection setup; it must not treat an arbitrary repository result as a capability grant.

Protocol version 1 uses JSON-safe `{ version, operation, payload }` requests and `{ version, status: 'ok', result }` or `{ version, status: 'error', error: { code } }` responses. Operations are exactly `getRepository`, `readDirectory`, `readFile`, `getBranches`, `getCommits`, `getCommitChanges`, `commit`, `createBranch`, and `deleteBranch`. Empty operations use `{}` payloads; reads use `{ revision, path }`; history uses the SDK query fields; branch mutations use `{ name, revision }` or `{ name }`. `deleteBranch` success has a `null` wire result. Read-file bytes and add/modify content use `{ base64 }`; no text conversion occurs. The commit payload keeps `type`, `branch`, `baseRevision`, `message`, `changes`, and the exact normal or force-with-lease `push` shape.

The endpoint can use `decodeRpcRequest()`, `encodeRpcSuccess()`, and `encodeRpcFailure()` to enforce the same wire contract. Unknown versions and operations fail closed. Responses are validated before they become SDK values; remote exception messages and stacks are never reconstructed. Operational failures carry only a stable Remotish error code. A commit success retains the SDK meaning: the endpoint has already published the branch at the returned revision. The RPC adapter does not retry writes or reinterpret publication outcomes.

The transport owns framing, request correlation, timeouts, session lifecycle, and authentication. Its `request()` method receives the local abort signal. The adapter also rejects a cancelled call locally, so a delayed transport reply cannot resolve it. A future cross-tab transport must ignore stale responses for its own sessions.
