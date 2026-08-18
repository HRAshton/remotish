import type { WorkingTreeChange } from '@remotish/core';

/** Presentation model for one changed path shown in a native SCM resource group. */
export interface ScmChangeResourceModel {
  readonly path: string;
  readonly type: WorkingTreeChange['type'];
  readonly originalPath?: string;
  readonly icon: 'diff-added' | 'diff-modified' | 'diff-removed' | 'diff-renamed';
  readonly tooltip: string;
  readonly strikeThrough: boolean;
}

/** Maps a core working-tree change to VS Code SCM decoration and tooltip metadata. */
export function toScmChangeResource(change: WorkingTreeChange): ScmChangeResourceModel {
  switch (change.type) {
    case 'added':
      return {
        path: change.path,
        type: change.type,
        icon: 'diff-added',
        tooltip: 'Added',
        strikeThrough: false,
      };
    case 'modified':
      return {
        path: change.path,
        type: change.type,
        icon: 'diff-modified',
        tooltip: 'Modified',
        strikeThrough: false,
      };
    case 'deleted':
      return {
        path: change.path,
        type: change.type,
        icon: 'diff-removed',
        tooltip: 'Deleted',
        strikeThrough: true,
      };
    case 'renamed':
      return {
        path: change.path,
        type: change.type,
        originalPath: change.originalPath,
        icon: 'diff-renamed',
        tooltip: `Renamed from ${change.originalPath}`,
        strikeThrough: false,
      };
  }
}
