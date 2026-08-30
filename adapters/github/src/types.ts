/** Configuration for connecting the reference adapter to one GitHub repository. */
export interface GitHubAdapterOptions {
  /** Repository owner or organization. */
  readonly owner: string;
  /** Repository name without the owner prefix. */
  readonly repository: string;
  /** Authentication token. Public repositories remain readable when omitted. */
  readonly token?: string;
  /** GitHub API base URL, primarily for GitHub Enterprise and tests. */
  readonly apiBaseUrl?: string;
  /** Fetch implementation override for tests and non-default browser runtimes. */
  readonly fetch?: typeof fetch;
  /** Request deadline in milliseconds. */
  readonly requestTimeoutMs?: number;
  /** Maximum bytes accepted for one GitHub response. */
  readonly maxResponseBytes?: number;
}

/** GitHub repository fields consumed by Remotish. */
export interface GitHubRepositoryResponse {
  readonly id: number;
  readonly node_id: string;
  readonly name: string;
  readonly full_name: string;
  readonly description: string | null;
  readonly default_branch: string;
}

/** One entry in a Git Data tree response. */
export interface GitHubTreeEntry {
  readonly path: string;
  readonly mode: string;
  readonly type: 'blob' | 'tree' | 'commit';
  readonly sha: string;
  readonly size?: number;
}

/** Git Data tree fields consumed by immutable repository reads. */
export interface GitHubTreeResponse {
  readonly sha: string;
  readonly tree: readonly GitHubTreeEntry[];
  readonly truncated?: boolean;
}

/** Git Data commit fields used for publication and historical reads. */
export interface GitHubGitCommitResponse {
  readonly sha: string;
  readonly message: string;
  readonly tree: { readonly sha: string };
  readonly parents: readonly { readonly sha: string }[];
  readonly author?: GitHubCommitAuthor | null;
}

/** Author metadata supplied by GitHub when available. */
export interface GitHubCommitAuthor {
  readonly name?: string;
  readonly email?: string;
  readonly date?: string;
}

/** One branch entry returned by GitHub's branch listing endpoint. */
export interface GitHubBranchResponse {
  readonly name: string;
  readonly commit: { readonly sha: string };
}

/** Commit-list fields used by Remotish history. */
export interface GitHubCommitListResponse {
  readonly sha: string;
  readonly parents: readonly { readonly sha: string }[];
  readonly commit: {
    readonly message: string;
    readonly author?: GitHubCommitAuthor | null;
  };
}

/** Commit-detail fields used to map GitHub file changes into Remotish history. */
export interface GitHubCommitDetailResponse extends GitHubCommitListResponse {
  readonly files?: readonly GitHubCommitFileResponse[];
}

/** One changed-file entry from a GitHub commit-detail response. */
export interface GitHubCommitFileResponse {
  readonly filename: string;
  readonly previous_filename?: string;
  readonly status: string;
}

/** Git Data blob fields used by binary file reads. */
export interface GitHubBlobResponse {
  readonly content: string;
  readonly encoding: string;
}

/** Common response shape for newly created Git Data objects. */
export interface GitHubShaResponse {
  readonly sha: string;
}

/** Git reference target returned by GitHub. */
export interface GitHubObjectShaResponse {
  readonly object: { readonly sha: string };
}
