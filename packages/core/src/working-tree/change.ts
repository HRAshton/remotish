import type { RepoPath } from '@remotish/adapter-sdk';

/** Normalized add/modify/delete/rename change produced from base revision plus overlay state. */
export type WorkingTreeChange =
  | { readonly type: 'added' | 'modified' | 'deleted'; readonly path: RepoPath }
  | { readonly type: 'renamed'; readonly path: RepoPath; readonly originalPath: RepoPath };
