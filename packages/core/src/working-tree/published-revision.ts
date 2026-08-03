import type { RevisionId } from '@remotish/adapter-sdk';
import type { Overlay } from './overlay.js';
import type { RepositoryReader } from '../repository/repository-reader.js';
import { equalBytes } from '../util/bytes.js';

/**
 * Rebase an existing overlay onto a newly published remote revision while
 * preserving changes that were not part of the publication.
 */
export async function rebaseOverlayAfterPartialPublish(
  repository: RepositoryReader,
  revision: RevisionId,
  overlay: Overlay,
): Promise<void> {
  for (const file of overlay.listFiles()) {
    const stat = await repository.tryStat(revision, file.path);
    if (stat?.type !== 'file') {
      continue;
    }

    const remote = await repository.readFile(revision, file.path);
    if (equalBytes(remote, file.content)) {
      overlay.removeFile(file.path);
    }
  }

  for (const directory of overlay.listDirectories()) {
    const stat = await repository.tryStat(revision, directory);
    if (stat?.type === 'directory') {
      overlay.removeDirectory(directory);
    }
  }

  for (const deleted of overlay.listDeletedPaths()) {
    if (!(await repository.tryStat(revision, deleted))) {
      overlay.unmarkDeleted(deleted);
    }
  }

  for (const rename of overlay.listRenames()) {
    const source = await repository.tryStat(revision, rename.from);
    const target = await repository.tryStat(revision, rename.to);
    if (!source && target) {
      overlay.removeRename(rename.from, rename.to);
    }
  }
}
