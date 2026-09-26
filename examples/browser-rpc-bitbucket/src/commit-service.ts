import { type CommitRejected, type CommitResult, RemotishError } from '@remotish/adapter-sdk';
import type { BitbucketApiClient } from './api-client.js';
import {
  branchName,
  createdCommitRevision,
  list,
  object,
  prePublicationRejection,
  remotePath,
  revision,
  stringValue,
  text,
  wellFormed,
} from './codec.js';

const API_ORIGIN = 'https://api.bitbucket.org';
const MAX_COMMIT_BYTES = 16 * 1024 * 1024;
const MAX_COMMIT_CHANGES = 1000;
const MAX_ATTRIBUTE_PROBES = 8;

export interface BitbucketSourcePublishRequest {
  readonly url: URL;
  readonly authorization: string;
  readonly form: FormData;
  readonly signal: AbortSignal;
}

export interface BitbucketSourcePublishResponse {
  readonly status: number;
  readonly location?: string;
}

export type BitbucketSourcePublisher = (
  request: BitbucketSourcePublishRequest,
) => Promise<BitbucketSourcePublishResponse>;

interface PreparedCommit {
  readonly form: FormData;
  readonly baseRevision: string;
  readonly message: string;
  readonly modifiedPaths: readonly string[];
}

/** Validates and publishes Bitbucket Cloud source-API commits without owning RPC dispatch. */
export class BitbucketCommitService {
  constructor(
    private readonly basePath: string,
    private readonly client: BitbucketApiClient,
    private readonly sourcePublisher?: BitbucketSourcePublisher,
  ) {}

  async commit(value: unknown, signal: AbortSignal): Promise<CommitResult> {
    let prepared: CommitRejected | PreparedCommit;
    try {
      prepared = this.prepare(value);
    } catch {
      // Preparation is entirely local. Nothing was sent, so core can settle its journal.
      return {
        status: 'rejected',
        reason: 'UNSUPPORTED',
        message: 'Invalid Bitbucket commit request.',
      };
    }
    if ('status' in prepared) {
      return prepared;
    }
    if (!this.sourcePublisher) {
      return {
        status: 'rejected',
        reason: 'UNSUPPORTED',
        message: 'Bitbucket commit publication requires the privileged userscript request.',
      };
    }

    let credential: string;
    try {
      const attributeRejection = await this.checkModificationAttributes(
        prepared.baseRevision,
        prepared.modifiedPaths,
        signal,
      );
      if (attributeRejection) {
        return attributeRejection;
      }
      credential = await this.client.credential();
      if (signal.aborted) {
        throw new RemotishError('CANCELLED', 'Bitbucket commit was cancelled before publication.');
      }
    } catch (error) {
      // These checks happen before the source publication request is invoked. Settling the result
      // here lets core clear its prepared journal because no remote write could have happened.
      return prePublicationRejection(error);
    }

    // Bitbucket atomically asserts that parents is the current head of branch, returning 409
    // when it moved. Never retry this non-idempotent publication after an ambiguous failure.
    const publication = await this.sourcePublisher({
      url: new URL(`${this.basePath}/src`, API_ORIGIN),
      authorization: `Bearer ${credential}`,
      form: prepared.form,
      signal,
    });
    if (publication.status === 409) {
      return { status: 'rejected', reason: 'REMOTE_CHANGED' };
    }
    this.client.requireStatusCode(publication.status, 201);
    const publishedRevision = createdCommitRevision(publication.location, this.basePath);
    return {
      status: 'success',
      revision: publishedRevision,
      commit: {
        revision: publishedRevision,
        parents: [prepared.baseRevision],
        message: prepared.message,
      },
    };
  }

  private prepare(value: unknown): CommitRejected | PreparedCommit {
    const input = object(value, 'commit request');
    // These modes cannot be implemented with Bitbucket's source API without an unsafe ref rewrite.
    if (input.type !== 'commit' || object(input.push, 'commit push').mode !== 'normal') {
      return { status: 'rejected', reason: 'UNSUPPORTED' };
    }
    const branch = branchName(input.branch);
    const baseRevision = revision(input.baseRevision);
    const message = stringValue(input.message, 'commit.message');
    const changes = list(input.changes, 'commit.changes');
    if (
      !message.trim() ||
      !wellFormed(message) ||
      message.length > 10_000 ||
      !changes.length ||
      changes.length > MAX_COMMIT_CHANGES
    ) {
      return {
        status: 'rejected',
        reason: 'UNSUPPORTED',
        message: 'Bitbucket commit exceeds supported limits.',
      };
    }

    const validated: Array<
      { type: 'delete'; path: string } | { type: 'file'; path: string; content: Uint8Array }
    > = [];
    const modifiedPaths: string[] = [];
    const seen = new Set<string>();
    let size = 0;
    for (const item of changes) {
      const change = object(item, 'commit change');
      const path = remotePath(change.path, 'commit change.path');
      if (
        !wellFormed(path) ||
        [...path].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        )
      ) {
        return {
          status: 'rejected',
          reason: 'UNSUPPORTED',
          message: 'Bitbucket path cannot be represented in multipart form.',
        };
      }
      if (seen.has(path)) {
        throw new RemotishError('INVALID_REQUEST', 'Duplicate Bitbucket commit path.');
      }
      seen.add(path);
      size += path.length * 4 + 256;
      if (change.type === 'delete') {
        validated.push({ type: 'delete', path });
      } else if (change.type === 'add' || change.type === 'modify') {
        if (!(change.content instanceof Uint8Array)) {
          throw new RemotishError('INVALID_REQUEST', 'Invalid Bitbucket commit bytes.');
        }
        size += change.content.byteLength;
        validated.push({ type: 'file', path, content: change.content });
        if (change.type === 'modify') {
          modifiedPaths.push(path);
        }
      } else {
        throw new RemotishError('INVALID_REQUEST', 'Invalid Bitbucket commit change.');
      }
      if (size > MAX_COMMIT_BYTES) {
        return {
          status: 'rejected',
          reason: 'UNSUPPORTED',
          message: 'Bitbucket commit exceeds the transport size limit.',
        };
      }
    }

    const form = new FormData();
    form.set('branch', branch);
    form.set('parents', baseRevision);
    form.set('message', message);
    for (const change of validated) {
      if (change.type === 'delete') {
        form.append('files', change.path);
      } else {
        form.append(
          change.path,
          new Blob([change.content.slice()], { type: 'application/octet-stream' }),
          change.path.split('/').at(-1),
        );
      }
    }
    return { form, baseRevision, message, modifiedPaths };
  }

  private async checkModificationAttributes(
    baseRevision: string,
    paths: readonly string[],
    signal: AbortSignal,
  ): Promise<CommitRejected | undefined> {
    for (let offset = 0; offset < paths.length; offset += MAX_ATTRIBUTE_PROBES) {
      const batch = paths.slice(offset, offset + MAX_ATTRIBUTE_PROBES);
      const attributes = await Promise.all(
        batch.map((path) => this.getFileAttributes(baseRevision, path, signal)),
      );
      if (attributes.some((values) => values.some((value) => value !== 'binary'))) {
        return {
          status: 'rejected',
          reason: 'UNSUPPORTED',
          message: 'Bitbucket cannot safely modify a file with repository attributes.',
        };
      }
    }
    return undefined;
  }

  private async getFileAttributes(
    valueRevision: string,
    valuePath: string,
    signal: AbortSignal,
  ): Promise<readonly string[]> {
    const source = this.sourcePath(valueRevision, valuePath);
    const metadata = object(
      await this.client.getJson(`${source}?format=meta`, signal),
      'file metadata',
    );
    if (metadata.type !== 'commit_file' || remotePath(metadata.path, 'file.path') !== valuePath) {
      throw new RemotishError('NOT_FOUND', 'Bitbucket path is not a file.');
    }
    return list(metadata.attributes, 'file.attributes').map((value) =>
      text(value, 'file.attribute'),
    );
  }

  private sourcePath(valueRevision: string, path: string): string {
    const suffix = path ? `/${path.split('/').map(encodeURIComponent).join('/')}` : '/';
    return `${this.basePath}/src/${revision(valueRevision)}${suffix}`;
  }
}
