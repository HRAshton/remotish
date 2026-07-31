import type { DirectoryEntry, RepoPath, RevisionId } from '@remotish/adapter-sdk';
import { cloneBytes } from '../util/bytes.js';
import { normalizePath } from '../util/path.js';

/** Default memory budget for immutable revision data cached by one repository reader. */
export const DEFAULT_REVISION_CACHE_MAX_BYTES = 128 * 1024 * 1024;

/** Memory limits applied to immutable revision caching. */
export interface RevisionCacheOptions {
  /** Approximate maximum bytes retained by the cache. Zero disables caching. */
  readonly maxBytes?: number;
  /** Optional maximum number of cached file/directory entries. */
  readonly maxEntries?: number;
}

type CacheEntry =
  | { readonly kind: 'file'; readonly value: Uint8Array; readonly weight: number }
  | {
      readonly kind: 'directory';
      readonly value: readonly DirectoryEntry[];
      readonly weight: number;
    };

/**
 * LRU cache for immutable directory and file reads keyed by revision and normalized path.
 *
 * File contents are copied on insertion and retrieval so callers cannot mutate cached state. The
 * byte budget is approximate for directory metadata and exact for file payloads.
 */
export class RevisionCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly maxBytes: number;
  private readonly maxEntries: number | undefined;
  private retainedBytes = 0;

  constructor(options: RevisionCacheOptions = {}) {
    this.maxBytes = requireNonNegativeFinite(
      options.maxBytes ?? DEFAULT_REVISION_CACHE_MAX_BYTES,
      'maxBytes',
    );
    this.maxEntries =
      options.maxEntries === undefined
        ? undefined
        : requireNonNegativeInteger(options.maxEntries, 'maxEntries');
  }

  /** Approximate bytes currently retained by the cache. */
  get sizeBytes(): number {
    return this.retainedBytes;
  }

  /** Number of cached file/directory entries. */
  get size(): number {
    return this.entries.size;
  }

  getFile(revision: RevisionId, path: RepoPath): Uint8Array | undefined {
    const entry = this.getEntry(key(revision, path));
    return entry?.kind === 'file' ? entry.value.slice() : undefined;
  }

  setFile(revision: RevisionId, path: RepoPath, content: Uint8Array): void {
    const cacheKey = key(revision, path);
    const value = cloneBytes(content);
    this.setEntry(cacheKey, {
      kind: 'file',
      value,
      weight: estimateKeyWeight(cacheKey) + value.byteLength,
    });
  }

  getDirectory(revision: RevisionId, path: RepoPath): readonly DirectoryEntry[] | undefined {
    const entry = this.getEntry(key(revision, path));
    return entry?.kind === 'directory'
      ? entry.value.map((candidate) => ({ ...candidate }))
      : undefined;
  }

  setDirectory(revision: RevisionId, path: RepoPath, entries: readonly DirectoryEntry[]): void {
    const cacheKey = key(revision, path);
    const value = entries.map((entry) => ({ ...entry }));
    this.setEntry(cacheKey, {
      kind: 'directory',
      value,
      weight: estimateKeyWeight(cacheKey) + estimateDirectoryWeight(value),
    });
  }

  clear(): void {
    this.entries.clear();
    this.retainedBytes = 0;
  }

  private getEntry(cacheKey: string): CacheEntry | undefined {
    const entry = this.entries.get(cacheKey);
    if (!entry) {
      return undefined;
    }
    // Map iteration order is the LRU order: oldest first, newest last.
    this.entries.delete(cacheKey);
    this.entries.set(cacheKey, entry);
    return entry;
  }

  private setEntry(cacheKey: string, entry: CacheEntry): void {
    const previous = this.entries.get(cacheKey);
    if (previous) {
      this.entries.delete(cacheKey);
      this.retainedBytes -= previous.weight;
    }

    if (this.maxBytes === 0 || entry.weight > this.maxBytes || this.maxEntries === 0) {
      return;
    }

    this.entries.set(cacheKey, entry);
    this.retainedBytes += entry.weight;
    this.evictToBudget();
  }

  private evictToBudget(): void {
    while (
      this.retainedBytes > this.maxBytes ||
      (this.maxEntries !== undefined && this.entries.size > this.maxEntries)
    ) {
      const oldest = this.entries.entries().next().value as [string, CacheEntry] | undefined;
      if (!oldest) {
        break;
      }
      this.entries.delete(oldest[0]);
      this.retainedBytes -= oldest[1].weight;
    }
  }
}

function key(revision: RevisionId, path: RepoPath): string {
  return `${revision}\u0000${normalizePath(path)}`;
}

function estimateKeyWeight(value: string): number {
  return 64 + value.length * 2;
}

function estimateDirectoryWeight(entries: readonly DirectoryEntry[]): number {
  let bytes = 64;
  for (const entry of entries) {
    bytes += 96 + entry.name.length * 2 + entry.path.length * 2;
  }
  return bytes;
}

function requireNonNegativeFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number.`);
  }
  return value;
}

function requireNonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer.`);
  }
  return value;
}
