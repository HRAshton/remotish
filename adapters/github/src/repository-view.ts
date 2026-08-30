import {
  type DirectoryEntry,
  normalizeRepoPath,
  RemotishError,
  type RepoPath,
} from '@remotish/adapter-sdk';
import type { GitHubClient } from './github-client.js';
import { decodeBlob, decodeGitCommit, decodeTree } from './github-json.js';
import type { GitHubGitCommitResponse, GitHubTreeResponse } from './types.js';

/**
 * Reads immutable GitHub Git Data objects without exposing transport details to the adapter.
 * Directory traversal deliberately uses tree objects so file modes and large directories retain
 * Git semantics rather than inheriting the Contents API's limitations.
 */
export class GitHubRepositoryView {
  constructor(private readonly client: GitHubClient) {}

  async getCommit(revision: string, signal?: AbortSignal): Promise<GitHubGitCommitResponse> {
    return this.client.rest(
      this.repoPath(`/git/commits/${encodeURIComponent(revision)}`),
      decodeGitCommit,
      {},
      signal,
    );
  }

  async readDirectory(
    revision: string,
    path: RepoPath,
    signal?: AbortSignal,
  ): Promise<readonly DirectoryEntry[]> {
    const tree = await this.treeAtPath(revision, path, signal);
    return tree.tree
      .filter((entry) => entry.type === 'blob' || entry.type === 'tree')
      .map((entry): DirectoryEntry => {
        if (entry.type === 'tree') {
          return {
            name: entry.path,
            path: joinRepoPath(path, entry.path),
            type: 'directory',
          };
        }
        if (entry.size === undefined) {
          return {
            name: entry.path,
            path: joinRepoPath(path, entry.path),
            type: 'file',
          };
        }
        return {
          name: entry.path,
          path: joinRepoPath(path, entry.path),
          type: 'file',
          size: entry.size,
        };
      })
      .sort(compareEntries);
  }

  async readFile(revision: string, path: RepoPath, signal?: AbortSignal): Promise<Uint8Array> {
    const normalized = normalizeRepoPath(path);
    const segments = normalized.split('/');
    const fileName = segments.pop();
    if (!fileName) {
      throw new RemotishError('NOT_FOUND', 'Repository root is not a file.');
    }

    const directory = await this.treeAtPath(revision, segments.join('/'), signal);
    const entry = directory.tree.find((candidate) => candidate.path === fileName);
    if (entry?.type !== 'blob') {
      throw new RemotishError('NOT_FOUND', `File not found: ${normalized}`);
    }

    const blob = await this.client.rest(
      this.repoPath(`/git/blobs/${encodeURIComponent(entry.sha)}`),
      decodeBlob,
      {},
      signal,
    );
    if (blob.encoding !== 'base64') {
      throw new RemotishError('UNKNOWN', `Unsupported GitHub blob encoding: ${blob.encoding}`);
    }
    return decodeBase64(blob.content.replaceAll('\n', ''));
  }

  async fileMode(
    revision: string,
    path: RepoPath,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const normalized = normalizeRepoPath(path);
    const segments = normalized.split('/');
    const fileName = segments.pop();
    if (!fileName) {
      return undefined;
    }
    const directory = await this.treeAtPath(revision, segments.join('/'), signal);
    return directory.tree.find((entry) => entry.path === fileName && entry.type === 'blob')?.mode;
  }

  private async treeAtPath(
    revision: string,
    path: RepoPath,
    signal?: AbortSignal,
  ): Promise<GitHubTreeResponse> {
    const commit = await this.getCommit(revision, signal);
    let tree = await this.getTree(commit.tree.sha, signal);
    const normalized = normalizeRepoPath(path);
    if (!normalized) {
      return tree;
    }

    for (const segment of normalized.split('/')) {
      const entry = tree.tree.find((candidate) => candidate.path === segment);
      if (entry?.type !== 'tree') {
        throw new RemotishError('NOT_FOUND', `Directory not found: ${normalized}`);
      }
      tree = await this.getTree(entry.sha, signal);
    }
    return tree;
  }

  private async getTree(sha: string, signal?: AbortSignal): Promise<GitHubTreeResponse> {
    const tree = await this.client.rest(
      this.repoPath(`/git/trees/${encodeURIComponent(sha)}`),
      decodeTree,
      {},
      signal,
    );
    if (tree.truncated) {
      throw new RemotishError('UNSUPPORTED', 'GitHub returned a truncated tree.');
    }
    return tree;
  }

  private repoPath(suffix: string): string {
    return `/repos/${encodeURIComponent(this.client.owner)}/${encodeURIComponent(this.client.repository)}${suffix}`;
  }
}

function joinRepoPath(parent: string, child: string): string {
  const normalized = normalizeRepoPath(parent);
  return normalized ? `${normalized}/${child}` : child;
}

function compareEntries(left: DirectoryEntry, right: DirectoryEntry): number {
  if (left.type !== right.type) {
    return left.type === 'directory' ? -1 : 1;
  }
  return left.name.localeCompare(right.name);
}

function decodeBase64(value: string): Uint8Array {
  const binary = globalThis.atob(value);
  const result = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    result[index] = binary.charCodeAt(index);
  }
  return result;
}
