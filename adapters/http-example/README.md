# @remotish/adapter-http

Small browser-first example adapter for a conventional HTTP repository API. Use it as a protocol example or as a starting point when your service already exposes repository operations over HTTP.

## Create the adapter

```ts
import { HttpRemotishAdapter } from '@remotish/adapter-http';

const adapter = new HttpRemotishAdapter({
  baseUrl: 'https://repo.example.test/api',
  capabilities: {
    commits: true,
    forceWithLease: true,
    createBranch: true,
    deleteBranch: true,
  },
  headers: () => ({ Authorization: `Bearer ${getToken()}` }),
});
```

Set only the capabilities your server actually supports.

## Endpoints

| Operation | Endpoint |
| --- | --- |
| repository metadata | `GET /repository` |
| directory at revision | `GET /tree?revision=...&path=...` |
| file bytes at revision | `GET /file?revision=...&path=...` |
| branches | `GET /branches` |
| commit history | `GET /commits?...` |
| changed files | `GET /commits/:revision/changes` |
| commit and publish | `POST /commit` |
| create branch | `POST /branches` |
| delete branch | `DELETE /branches/:name` |

`GET /file` returns raw bytes. JSON responses are decoded and validated before becoming SDK values.

## Commit payloads

The request preserves the normal Remotish `CommitRequest` shape except add/modify content is JSON-safe base64:

```json
{
  "type": "commit",
  "branch": "main",
  "baseRevision": "C42",
  "message": "Update settings",
  "changes": [
    {
      "type": "modify",
      "path": "settings.json",
      "contentBase64": "eyJlbmFibGVkIjp0cnVlfQo="
    }
  ],
  "push": { "mode": "normal" }
}
```

`POST /commit` may return a normal `CommitRejected` body with HTTP `409` or `412`; the adapter returns that value to core rather than converting an expected concurrency rejection into an exception.

The server must still enforce the semantics documented in [`docs/adapter-contract.md`](../../docs/adapter-contract.md), especially immutable revisions, atomic publish success, `REMOTE_CHANGED`, and force-with-lease.
