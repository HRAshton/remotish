import {
  type DirectoryEntry,
  type RemotishAdapter,
  RemotishError,
  type RepoPath,
  type RevisionId,
} from '@remotish/adapter-sdk';
import { baseName, normalizePath, parentPath } from '../util/path.js';
import { TraversalBudget } from '../util/traversal-budget.js';
import { RevisionCache } from './revision-cache.js';

/** Default deadline for one immutable adapter read at the core boundary. */
const DEFAULT_REPOSITORY_REQUEST_TIMEOUT_MS = 30_000;

/** Maximum children accepted from one adapter directory response. */
const MAX_DIRECTORY_ENTRIES = 50_000;

/** Maximum length of one repository path segment accepted from adapter metadata. */
const MAX_REPO_PATH_SEGMENT_LENGTH = 1_024;

/** Maximum canonical repository path length accepted from adapter metadata. */
const MAX_REPO_PATH_LENGTH = 8_192;

/** Resource limits applied by the core repository-reader trust boundary. */
export interface RepositoryReaderOptions {
  /** Deadline for one adapter file/directory read, in milliseconds. */
  readonly requestTimeoutMs?: number;
}

/** Framework file metadata derived from immutable adapter directory/file reads. */
export interface FileStat {
  readonly type: 'file' | 'directory';
  readonly size: number;
}

/** Adds normalized paths, bounded immutable caching, and request coalescing around adapter reads. */
export class RepositoryReader {
  private readonly pendingFiles = new Map<string, Promise<Uint8Array>>();
  private readonly pendingDirectories = new Map<string, Promise<readonly DirectoryEntry[]>>();

  private readonly requestTimeoutMs: number;

  constructor(
    readonly adapter: RemotishAdapter,
    readonly cache: RevisionCache = new RevisionCache(),
    options: RepositoryReaderOptions = {},
  ) {
    this.requestTimeoutMs = requirePositiveInteger(
      options.requestTimeoutMs ?? DEFAULT_REPOSITORY_REQUEST_TIMEOUT_MS,
      'requestTimeoutMs',
    );
  }

  async readFile(revision: RevisionId, path: RepoPath): Promise<Uint8Array> {
    const normalized = normalizePath(path);
    const cached = this.cache.getFile(revision, normalized);
    if (cached) {
      return cached;
    }

    const requestKey = key(revision, normalized);
    let pending = this.pendingFiles.get(requestKey);
    if (!pending) {
      pending = this.withReadDeadline(`Reading file ${normalized || '<root>'}`, (signal) =>
        this.adapter.readFile(revision, normalized, { signal }),
      )
        .then((content) => {
          this.cache.setFile(revision, normalized, content);
          return content.slice();
        })
        .finally(() => this.pendingFiles.delete(requestKey));
      this.pendingFiles.set(requestKey, pending);
    }
    return (await pending).slice();
  }

  async readDirectory(revision: RevisionId, path: RepoPath): Promise<readonly DirectoryEntry[]> {
    const normalized = normalizePath(path);
    const cached = this.cache.getDirectory(revision, normalized);
    if (cached) {
      return cached;
    }

    const requestKey = key(revision, normalized);
    let pending = this.pendingDirectories.get(requestKey);
    if (!pending) {
      pending = this.withReadDeadline(`Reading directory ${normalized || '<root>'}`, (signal) =>
        this.adapter.readDirectory(revision, normalized, { signal }),
      )
        .then((entries) => {
          const validated = validateDirectoryEntries(normalized, entries);
          this.cache.setDirectory(revision, normalized, validated);
          return validated.map((entry) => ({ ...entry }));
        })
        .finally(() => this.pendingDirectories.delete(requestKey));
      this.pendingDirectories.set(requestKey, pending);
    }
    return (await pending).map((entry) => ({ ...entry }));
  }

  async stat(revision: RevisionId, path: RepoPath): Promise<FileStat> {
    const normalized = normalizePath(path);
    if (!normalized) {
      return { type: 'directory', size: 0 };
    }
    const parent = parentPath(normalized);
    if (parent === undefined) {
      throw new RemotishError('NOT_FOUND', `Path ${normalized} does not exist.`);
    }
    const entry = (await this.readDirectory(revision, parent)).find(
      (candidate) => candidate.name === baseName(normalized),
    );
    if (!entry) {
      throw new RemotishError('NOT_FOUND', `Path ${normalized} does not exist.`);
    }
    return { type: entry.type, size: entry.size ?? 0 };
  }

  async tryStat(revision: RevisionId, path: RepoPath): Promise<FileStat | undefined> {
    try {
      return await this.stat(revision, path);
    } catch (error) {
      if (error instanceof RemotishError && error.code === 'NOT_FOUND') {
        return undefined;
      }
      throw error;
    }
  }

  async listFilesRecursively(revision: RevisionId, path: RepoPath): Promise<readonly RepoPath[]> {
    const normalized = normalizePath(path);
    const stat = await this.stat(revision, normalized);
    if (stat.type === 'file') {
      return [normalized];
    }

    const result: string[] = [];
    const budget = new TraversalBudget();
    await this.walk(revision, normalized, result, budget, 0);
    return result;
  }

  private async withReadDeadline<T>(
    operation: string,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(
          new RemotishError('OFFLINE', `${operation} timed out after ${this.requestTimeoutMs} ms.`),
        );
      }, this.requestTimeoutMs);
    });

    try {
      return await Promise.race([Promise.resolve().then(() => run(controller.signal)), timeout]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  private async walk(
    revision: RevisionId,
    directory: RepoPath,
    output: string[],
    budget: TraversalBudget,
    depth: number,
  ): Promise<void> {
    budget.enterDirectory(directory, depth);
    for (const entry of await this.readDirectory(revision, directory)) {
      budget.visit(entry.path);
      if (entry.type === 'file') {
        output.push(entry.path);
      } else {
        await this.walk(revision, entry.path, output, budget, depth + 1);
      }
    }
  }
}

function validateDirectoryEntries(
  parent: RepoPath,
  entries: readonly DirectoryEntry[],
): readonly DirectoryEntry[] {
  if (!Array.isArray(entries)) {
    throw invalidAdapterDirectory(parent, 'directory response must be an array');
  }
  if (entries.length > MAX_DIRECTORY_ENTRIES) {
    throw invalidAdapterDirectory(
      parent,
      `directory response contains ${entries.length} entries; maximum is ${MAX_DIRECTORY_ENTRIES}`,
    );
  }

  const names = new Set<string>();
  return entries.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw invalidAdapterDirectory(parent, `entry ${index} must be an object`);
    }

    const candidate = entry as unknown as Record<string, unknown>;
    const name = candidate.name;
    if (typeof name !== 'string' || !name) {
      throw invalidAdapterDirectory(parent, `entry ${index} name must be a non-empty string`);
    }
    if (name.length > MAX_REPO_PATH_SEGMENT_LENGTH) {
      throw invalidAdapterDirectory(
        parent,
        `entry ${index} name exceeds ${MAX_REPO_PATH_SEGMENT_LENGTH} characters`,
      );
    }
    if (name.includes('\u0000') || name.includes('/') || name.includes('\\')) {
      throw invalidAdapterDirectory(parent, `entry ${index} name is not one path segment`);
    }

    let normalizedName: string;
    try {
      normalizedName = normalizePath(name);
    } catch (cause) {
      throw invalidAdapterDirectory(parent, `entry ${index} name is invalid`, cause);
    }
    if (normalizedName !== name) {
      throw invalidAdapterDirectory(parent, `entry ${index} name is not canonical`);
    }
    if (names.has(name)) {
      throw invalidAdapterDirectory(parent, `entry ${index} duplicates child name ${name}`);
    }
    names.add(name);

    const type = candidate.type;
    if (type !== 'file' && type !== 'directory') {
      throw invalidAdapterDirectory(parent, `entry ${index} type must be file or directory`);
    }

    const size = candidate.size;
    if (
      size !== undefined &&
      (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0)
    ) {
      throw invalidAdapterDirectory(
        parent,
        `entry ${index} size must be a non-negative safe integer when present`,
      );
    }

    // Adapter-supplied `path` is deliberately ignored. Child identity is derived from the
    // requested parent and validated name so untrusted metadata cannot escape the subtree.
    const canonicalPath = parent ? `${parent}/${name}` : name;
    if (canonicalPath.length > MAX_REPO_PATH_LENGTH) {
      throw invalidAdapterDirectory(
        parent,
        `entry ${index} canonical path exceeds ${MAX_REPO_PATH_LENGTH} characters`,
      );
    }

    return size === undefined
      ? { name, path: canonicalPath, type }
      : { name, path: canonicalPath, type, size };
  });
}

function invalidAdapterDirectory(parent: RepoPath, detail: string, cause?: unknown): RemotishError {
  return new RemotishError(
    'UNKNOWN',
    `Invalid adapter directory response for ${parent || '<root>'}: ${detail}.`,
    cause === undefined ? undefined : { cause },
  );
}

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

function key(revision: RevisionId, path: RepoPath): string {
  return `${revision}\u0000${path}`;
}
