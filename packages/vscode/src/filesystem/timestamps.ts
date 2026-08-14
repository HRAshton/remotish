import type * as vscode from 'vscode';

interface TimestampEntry {
  readonly ctime: number;
  readonly mtime: number;
}

export class FileTimestampStore {
  private readonly entries = new Map<string, TimestampEntry>();

  constructor(private readonly now: () => number = Date.now) {}

  stat(uri: vscode.Uri): TimestampEntry {
    const key = resourceKey(uri);
    let entry = this.entries.get(key);
    if (!entry) {
      const timestamp = this.now();
      entry = { ctime: timestamp, mtime: timestamp };
      this.entries.set(key, entry);
    }
    return entry;
  }

  touch(uri: vscode.Uri): void {
    const key = resourceKey(uri);
    const previous = this.entries.get(key);
    const timestamp = this.now();
    this.entries.set(key, {
      ctime: previous?.ctime ?? timestamp,
      mtime: timestamp,
    });
  }

  remove(uri: vscode.Uri): void {
    const prefix = resourcePrefix(uri);
    for (const key of this.entries.keys()) {
      if (key === resourceKey(uri) || key.startsWith(prefix)) {
        this.entries.delete(key);
      }
    }
  }

  rename(source: vscode.Uri, target: vscode.Uri): void {
    const sourceKey = resourceKey(source);
    const sourcePrefix = resourcePrefix(source);
    const timestamp = this.now();
    const moved: Array<readonly [string, TimestampEntry]> = [];

    for (const [key, entry] of this.entries) {
      if (key !== sourceKey && !key.startsWith(sourcePrefix)) {
        continue;
      }
      const suffix = key === sourceKey ? '' : key.slice(sourceKey.length);
      moved.push([resourceKey(target) + suffix, { ctime: entry.ctime, mtime: timestamp }]);
      this.entries.delete(key);
    }

    if (moved.length === 0) {
      moved.push([resourceKey(target), { ctime: timestamp, mtime: timestamp }]);
    }

    for (const [key, entry] of moved) {
      this.entries.set(key, entry);
    }
  }

  invalidateWorkspace(workspaceId: string): void {
    const prefix = `${workspaceId.toLowerCase()}\0`;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
      }
    }
  }
}

function resourceKey(uri: vscode.Uri): string {
  return `${uri.authority.toLowerCase()}\0${uri.path}\0${uri.query}`;
}

function resourcePrefix(uri: vscode.Uri): string {
  const path = uri.path.endsWith('/') ? uri.path : `${uri.path}/`;
  return `${uri.authority.toLowerCase()}\0${path}`;
}
