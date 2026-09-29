# GitHub provider

This browser-only provider opens public GitHub.com repositories in Remotish without authentication.
Repository descriptors contain only `owner` and `repository`; tokens and alternate API origins are
not accepted. The provider always constructs `@remotish/adapter-github` without a token, so remote
commit, force-push, amend, create-branch and delete-branch capabilities remain disabled.

## Bootstrap web link

The temporary folder URI is:

```text
remotish-github://open/v1/<owner>/<repository>
```

For example, a Code-OSS Web deployment can open the public `octocat/Hello-World` repository with:

```text
https://code-oss.example/?folder=remotish-github%3A%2F%2Fopen%2Fv1%2Foctocat%2FHello-World
```

Replace the Code-OSS origin for your deployment and URL-encode the complete inner URI as the outer
`folder` value. The provider exposes a temporary read-only root, calls
`remotish.ensureRepository`, stores a credential-free restoration record, and then opens the
canonical `remotish://<stable-workspace-id>/` root.

On a later reload, `restoreWorkspace()` recreates the anonymous adapter from the stored owner and
repository. Remotish verifies the stable repository identity before restoring the core-owned
selected branch and working overlay.

## Capabilities and limits

Public repository metadata, files, existing branches, and history use GitHub's anonymous REST API.
Normal Remotish local edits, staging, diffs, branch switching among existing remote branches, and
overlay persistence remain available. Publishing and remote branch mutation are intentionally
unsupported in this first pass.

Anonymous GitHub API rate limits apply. Private repositories and authenticated writes require a
separately reviewed authentication design rather than putting credentials in repository descriptors
or bootstrap URLs.
