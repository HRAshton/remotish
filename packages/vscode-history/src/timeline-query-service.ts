import type { CommitChange, CommitInfo, RepoPath } from '@remotish/adapter-sdk';
import type { RemotishWorkspace } from '@remotish/core';
import type * as vscode from 'vscode';
import { withCancellation } from './cancellation.js';

const PAGE_SIZE = 25;
const MAX_SCANNED_COMMITS = 250;

interface TimelineCursorState {
  readonly revision: string;
  readonly adapterCursor?: string;
  readonly offset: number;
  readonly trackedPath: RepoPath;
}

export interface FileTimelineEntry {
  readonly commit: CommitInfo;
  readonly change: CommitChange;
  readonly timestamp: number;
}

export interface FileTimelinePage {
  readonly entries: readonly FileTimelineEntry[];
  readonly nextCursor?: string;
}

export class FileTimelineQueryService {
  constructor(private readonly workspace: RemotishWorkspace) {}

  async load(
    path: RepoPath,
    cursor: string | undefined,
    limit: number,
    minimumTimestamp: number | undefined,
    token: vscode.CancellationToken,
  ): Promise<FileTimelinePage> {
    let state = decodeCursor(cursor, this.workspace.baseRevision, path);
    const entries: FileTimelineEntry[] = [];
    let scanned = 0;

    while (
      entries.length < limit &&
      scanned < MAX_SCANNED_COMMITS &&
      !token.isCancellationRequested
    ) {
      const pageStartCursor = state.adapterCursor;
      const page = await withCancellation(token, (options) =>
        this.workspace.getCommits(
          {
            revision: state.revision,
            limit: PAGE_SIZE,
            ...(pageStartCursor ? { cursor: pageStartCursor } : {}),
          },
          options,
        ),
      );

      if (token.isCancellationRequested || page.commits.length === 0) {
        return { entries };
      }

      if (state.offset >= page.commits.length) {
        if (!page.nextCursor) {
          return { entries };
        }
        state = { ...state, adapterCursor: page.nextCursor, offset: 0 };
        continue;
      }

      const pageOffset = state.offset;
      const commits = page.commits.slice(pageOffset);
      const changesByCommit = await Promise.all(
        commits.map((commit) =>
          withCancellation(token, (options) =>
            this.workspace.getCommitChanges(commit.revision, options),
          ),
        ),
      );

      for (let index = 0; index < commits.length; index += 1) {
        if (token.isCancellationRequested) {
          return { entries };
        }
        scanned += 1;

        const commit = commits[index];
        const commitChanges = changesByCommit[index];
        if (!commit || !commitChanges) {
          continue;
        }
        const change = commitChanges.find((candidate) => candidate.path === state.trackedPath);
        const nextOffset = pageOffset + index + 1;

        if (change) {
          const timestamp = parseTimestamp(commit.authoredAt);
          if (
            timestamp !== undefined &&
            (minimumTimestamp === undefined || timestamp >= minimumTimestamp)
          ) {
            entries.push({ commit, change, timestamp });
          }

          state = {
            ...state,
            offset: nextOffset,
            trackedPath:
              change.type === 'renamed' && change.previousPath
                ? change.previousPath
                : state.trackedPath,
          };

          if (change.type === 'added') {
            return { entries };
          }
          if (entries.length >= limit) {
            return {
              entries,
              ...nextCursorForPage(state, page.commits.length, page.nextCursor),
            };
          }
        } else {
          state = { ...state, offset: nextOffset };
        }

        if (scanned >= MAX_SCANNED_COMMITS) {
          return {
            entries,
            ...nextCursorForPage(state, page.commits.length, page.nextCursor),
          };
        }
      }

      if (!page.nextCursor) {
        return { entries };
      }
      state = { ...state, adapterCursor: page.nextCursor, offset: 0 };
    }

    return { entries };
  }
}

function nextCursorForPage(
  state: TimelineCursorState,
  pageLength: number,
  nextAdapterCursor: string | undefined,
): { readonly nextCursor?: string } {
  if (state.offset < pageLength) {
    return { nextCursor: encodeCursor(state) };
  }
  if (!nextAdapterCursor) {
    return {};
  }
  return {
    nextCursor: encodeCursor({
      ...state,
      adapterCursor: nextAdapterCursor,
      offset: 0,
    }),
  };
}

function parseTimestamp(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function decodeCursor(
  value: string | undefined,
  revision: string,
  path: RepoPath,
): TimelineCursorState {
  if (!value) {
    return { revision, offset: 0, trackedPath: path };
  }

  try {
    const parsed = JSON.parse(decodeURIComponent(value)) as Partial<TimelineCursorState>;
    if (
      parsed.revision !== revision ||
      typeof parsed.offset !== 'number' ||
      !Number.isInteger(parsed.offset) ||
      parsed.offset < 0 ||
      typeof parsed.trackedPath !== 'string'
    ) {
      return { revision, offset: 0, trackedPath: path };
    }

    return {
      revision,
      offset: parsed.offset,
      trackedPath: parsed.trackedPath,
      ...(typeof parsed.adapterCursor === 'string' ? { adapterCursor: parsed.adapterCursor } : {}),
    };
  } catch {
    return { revision, offset: 0, trackedPath: path };
  }
}

function encodeCursor(state: TimelineCursorState): string {
  return encodeURIComponent(JSON.stringify(state));
}
