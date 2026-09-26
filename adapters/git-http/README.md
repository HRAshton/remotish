# Generic Git HTTP adapter

`@remotish/adapter-git-http` implements the existing Remotish adapter contract over Git smart HTTP.
It uses `isomorphic-git` and a heap-only LightningFS backend in Web. The desktop provider supplies
`memfs` for its Node extension host. Git objects, pack files and temporary refs are adapter
internals; Remotish still exposes an immutable remote revision plus working overlay.

The caller supplies one canonical HTTPS `.git` clone URL, a Git author name and email, and a bounded
HTTP transport. The adapter never owns credentials. Normal publication compares the advertised
remote head with `baseRevision` in `onPrePush`; force-with-lease and amend compare it with the
explicit `expectedRevision`. Git's receive-pack command then carries that same old object ID, so a
head change between advertisement and update is rejected by the server. A thrown or ambiguous push
response remains an operational error for core's publication journal; proven failures before
receive-pack dispatch settle as rejected commits. Writes are never retried.

The adapter supports immutable binary file reads, directory listing, remote branches, paged history,
first-parent file changes, multi-file commits, amend, force-with-lease, branch creation and branch
deletion. It does not implement a Remotish index, local commit queue or merge engine. It refuses
submodules and symbolic links, including directory listings and file reads, because Git link targets
are not ordinary file contents. One Git HTTP request is limited to 32 MiB, one response to 64 MiB, one changed file to
16 MiB, one tree to 100,000 files, branch listing to 10,000 and history pagination to 10,000 commits.
These are pilot limits; a repository exceeding them fails closed.

The disposable Git HTTP fixture in `tests/git-http/` exercises actual Git upload-pack and
receive-pack behavior. Bitbucket Data Center 9.4 qualification needs a separate live test repository
and token.
