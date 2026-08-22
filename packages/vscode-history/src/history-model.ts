import type { Branch, CommitChange, CommitInfo, RevisionId } from '@remotish/adapter-sdk';
import { type RepositoryUriParts, revisionUriParts } from '@remotish/vscode/model';

/** Framework-neutral representation of one history reference and its target revision. */
export interface HistoryRefModel {
  readonly id: string;
  readonly name: string;
  readonly revision: RevisionId;
  readonly category: 'Workspace' | 'Remote Branches';
}

/** Commit metadata prepared for the native SCM history surface. */
export interface HistoryItemModel {
  readonly id: string;
  readonly parentIds: string[];
  readonly subject: string;
  readonly message: string;
  readonly displayId: string;
  readonly author?: string;
  readonly authorEmail?: string;
  readonly timestamp?: number;
}

/** File-level history change with revision-pinned URIs for historical diffs. */
export interface HistoryChangeModel {
  readonly uri: RepositoryUriParts;
  readonly originalUri?: RepositoryUriParts;
  readonly modifiedUri?: RepositoryUriParts;
}

/** Builds the synthetic ref that represents the workspace's pinned base for a branch. */
export function workspaceRef(branch: string, revision: RevisionId): HistoryRefModel {
  return {
    id: `workspace:${branch}`,
    name: branch,
    revision,
    category: 'Workspace',
  };
}

/** Builds the ref that represents a remote branch head independently of workspace pinning. */
export function branchRef(branch: Branch): HistoryRefModel {
  return {
    id: `branch:${branch.name}`,
    name: branch.name,
    revision: branch.revision,
    category: 'Remote Branches',
  };
}

/** Converts adapter commit metadata into the framework-neutral SCM history model. */
export function toHistoryItem(commit: CommitInfo): HistoryItemModel {
  const subject = commit.message.split(/\r?\n/, 1)[0] || commit.revision;
  const timestamp = commit.authoredAt ? Date.parse(commit.authoredAt) : undefined;
  return {
    id: commit.revision,
    parentIds: [...commit.parents],
    subject,
    message: commit.message,
    displayId: commit.revision.slice(0, 12),
    ...(commit.author ? { author: commit.author.name } : {}),
    ...(commit.author?.email ? { authorEmail: commit.author.email } : {}),
    ...(timestamp !== undefined && Number.isFinite(timestamp) ? { timestamp } : {}),
  };
}

/** Creates revision-pinned original/modified URIs for one historical file change. */
export function toHistoryChange(
  workspaceId: string,
  revision: RevisionId,
  parentRevision: RevisionId | undefined,
  change: CommitChange,
): HistoryChangeModel {
  const modifiedUri =
    change.type === 'deleted' ? undefined : revisionUriParts(workspaceId, revision, change.path);
  const originalPath = change.type === 'renamed' ? change.previousPath : change.path;
  const originalUri =
    parentRevision && change.type !== 'added' && originalPath
      ? revisionUriParts(workspaceId, parentRevision, originalPath)
      : undefined;
  const uri = modifiedUri ?? originalUri ?? revisionUriParts(workspaceId, revision, change.path);
  return {
    uri,
    ...(originalUri ? { originalUri } : {}),
    ...(modifiedUri ? { modifiedUri } : {}),
  };
}

/** Extracts the branch name from either a workspace or remote-branch history ref identifier. */
export function branchNameFromRef(ref: string): string | undefined {
  if (ref.startsWith('branch:')) {
    return ref.slice('branch:'.length);
  }
  if (ref.startsWith('workspace:')) {
    return ref.slice('workspace:'.length);
  }
  return undefined;
}
