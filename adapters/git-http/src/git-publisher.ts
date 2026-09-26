import { RemotishError } from '@remotish/adapter-sdk';
import * as git from 'isomorphic-git';
import { GIT_DIR, type GitSession } from './git-session.js';
import { ZERO_OID } from './git-validation.js';
import { GitHttpNotDispatchedError, normalizeGitHttpError } from './transport.js';

export interface RefUpdateOutcome {
  readonly stale: boolean;
  readonly rejected?: boolean;
  readonly remoteRevision?: string;
}

/** Publishes Git refs while preserving the boundary between pre-dispatch and ambiguous failures. */
export class GitPublisher {
  constructor(private readonly session: GitSession) {}

  async update(
    localOid: string,
    target: string,
    expected: string,
    force: boolean,
    signal?: AbortSignal,
    deleting = false,
  ): Promise<RefUpdateOutcome> {
    const localRef = `refs/remotish/publish/${crypto.randomUUID().replaceAll('-', '')}`;
    let observed: string | undefined;
    let requestAttempted = false;
    let localRefWritten = false;
    try {
      await git.writeRef({
        fs: this.session.fs,
        dir: GIT_DIR,
        ref: localRef,
        value: deleting ? expected : localOid,
      });
      localRefWritten = true;
      const result = await git.push({
        fs: this.session.fs,
        http: this.session.http(signal, () => {
          requestAttempted = true;
        }),
        dir: GIT_DIR,
        url: this.session.url,
        remote: 'origin',
        ref: localRef,
        remoteRef: target,
        force,
        delete: deleting,
        ...(signal ? { signal } : {}),
        onPrePush({ remoteRef }) {
          observed = remoteRef.oid;
          return observed === expected;
        },
      });
      if (result.refs[target]?.ok === false) {
        return this.rejectedRefUpdate(target, expected, signal);
      }
      if (!result.ok || result.refs[target]?.ok !== true) {
        // A missing ref status does not prove whether the remote accepted the update.
        throw new RemotishError('UNKNOWN', 'Git server rejected the ref update.');
      }
      return { stale: false };
    } catch (error) {
      if (observed !== undefined && observed !== expected) {
        return { stale: true, ...(observed !== ZERO_OID ? { remoteRevision: observed } : {}) };
      }
      if (isDefiniteRefRejection(error, target)) {
        return this.rejectedRefUpdate(target, expected, signal);
      }
      if (!requestAttempted && !(error instanceof GitHttpNotDispatchedError)) {
        throw new GitHttpNotDispatchedError(
          normalizeGitHttpError(error).code,
          'Git publication failed before receive-pack dispatch.',
          { cause: error },
        );
      }
      throw normalizeGitHttpError(error);
    } finally {
      if (localRefWritten) {
        await this.deleteScratchRef(localRef);
      }
    }
  }

  async remoteHead(ref: string, signal?: AbortSignal): Promise<string | undefined> {
    const remote = await git
      .getRemoteInfo2({ http: this.session.http(signal), url: this.session.url, forPush: true })
      .catch((error: unknown) => {
        throw normalizeGitHttpError(error);
      });
    return remote.refs?.find((entry) => entry.ref === ref)?.oid;
  }

  private async rejectedRefUpdate(
    target: string,
    expected: string,
    signal?: AbortSignal,
  ): Promise<RefUpdateOutcome> {
    try {
      const current = await this.remoteHead(target, signal);
      if (current !== expected) {
        return { stale: true, ...(current ? { remoteRevision: current } : {}) };
      }
    } catch {
      // The server's explicit ref rejection remains definitive if this optional lookup fails.
    }
    return { stale: false, rejected: true };
  }

  private async deleteScratchRef(ref: string): Promise<void> {
    try {
      await git.deleteRef({ fs: this.session.fs, dir: GIT_DIR, ref });
    } catch {
      // This ref is heap-only scratch state. Cleanup cannot change a known remote outcome.
    }
  }
}

function isDefiniteRefRejection(error: unknown, ref: string): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const gitError = error as Record<string, unknown>;
  if (gitError.code !== 'GitPushError' || !gitError.data || typeof gitError.data !== 'object') {
    return false;
  }
  const data = gitError.data as Record<string, unknown>;
  if (!data.result || typeof data.result !== 'object') {
    return false;
  }
  const result = data.result as Record<string, unknown>;
  if (!result.refs || typeof result.refs !== 'object') {
    return false;
  }
  const status = (result.refs as Record<string, unknown>)[ref];
  return !!status && typeof status === 'object' && (status as Record<string, unknown>).ok === false;
}
