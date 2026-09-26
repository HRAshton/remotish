import LightningFS, { MemoryBackend } from '@isomorphic-git/lightning-fs';
import { RemotishError } from '@remotish/adapter-sdk';
import * as git from 'isomorphic-git';
import { requireBranch, requireNotAborted, requireRevision } from './git-validation.js';
import {
  createGitHttpClient,
  type GitHttpAdapterOptions,
  normalizeGitHttpError,
  validateGitUrl,
} from './transport.js';

export const GIT_DIR = '/repository';

/** Owns one adapter's in-memory Git object store and remote fetch lifecycle. */
export class GitSession {
  readonly fs: git.PromiseFsClient;
  readonly url: string;
  private initialized: Promise<void> | undefined;
  private refreshing: Promise<void> | undefined;
  private remoteDefaultBranch?: string;

  constructor(readonly options: GitHttpAdapterOptions) {
    this.fs = options.fs ?? new LightningFS(crypto.randomUUID(), { db: new MemoryBackend() });
    this.url = validateGitUrl(options.url);
    if (!options.author.name.trim() || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(options.author.email)) {
      throw new RemotishError('INVALID_REQUEST', 'Configure a Git author name and email.');
    }
  }

  get defaultBranch(): string | undefined {
    return this.remoteDefaultBranch;
  }

  http(signal?: AbortSignal, onReceivePackRequest?: () => void): git.HttpClient {
    return createGitHttpClient(this.options, signal, onReceivePackRequest);
  }

  async ready(signal?: AbortSignal): Promise<void> {
    if (!this.initialized) {
      this.initialized = this.initialize();
    }
    await this.initialized;
    if (!this.remoteDefaultBranch) {
      await this.refresh(signal);
    }
  }

  async refresh(signal?: AbortSignal): Promise<void> {
    if (!this.refreshing) {
      this.refreshing = this.fetchRemote(signal);
    }
    try {
      await this.refreshing;
    } finally {
      this.refreshing = undefined;
    }
  }

  async commitObject(oid: string): Promise<git.ReadCommitResult> {
    try {
      return await git.readCommit({ fs: this.fs, dir: GIT_DIR, oid: requireRevision(oid) });
    } catch {
      throw new RemotishError('NOT_FOUND', 'Git commit is unavailable in this session.');
    }
  }

  private async initialize(): Promise<void> {
    await this.fs.promises.mkdir(GIT_DIR);
    await git.init({ fs: this.fs, dir: GIT_DIR });
    await git.addRemote({ fs: this.fs, dir: GIT_DIR, remote: 'origin', url: this.url });
  }

  private async fetchRemote(signal?: AbortSignal): Promise<void> {
    requireNotAborted(signal);
    const result = await git
      .fetch({
        fs: this.fs,
        http: this.http(signal),
        dir: GIT_DIR,
        url: this.url,
        remote: 'origin',
        singleBranch: false,
        tags: false,
        prune: true,
      })
      .catch((error: unknown) => {
        throw normalizeGitHttpError(error);
      });
    if (!result.defaultBranch) {
      throw new RemotishError('UNSUPPORTED', 'Git remote has no default branch.');
    }
    this.remoteDefaultBranch = requireBranch(result.defaultBranch.replace(/^refs\/heads\//u, ''));
  }
}
