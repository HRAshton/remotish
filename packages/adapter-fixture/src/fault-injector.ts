import {
  type RemoteRequestOptions,
  RemotishError,
  type RemotishErrorCode,
} from '@remotish/adapter-sdk';
import { delay } from './support.js';

/** Fixture operation names that can receive deterministic latency or injected failures. */
export type FixtureMethod =
  | 'getRepository'
  | 'readDirectory'
  | 'readFile'
  | 'getBranches'
  | 'getCommits'
  | 'getCommitChanges'
  | 'commit'
  | 'createBranch'
  | 'deleteBranch';

/** Per-operation latency and failure controls used by adapter contract tests. */
export interface FixtureFaultOptions {
  readonly latencyMs?: number;
  readonly failures?: Partial<Record<FixtureMethod, RemotishErrorCode>>;
}

/** Applies deterministic latency and configured failures before fixture adapter operations. */
export class FixtureFaultInjector {
  constructor(private readonly options: FixtureFaultOptions) {}

  async before(method: FixtureMethod, options?: RemoteRequestOptions): Promise<void> {
    if (options?.signal?.aborted) {
      throw new RemotishError('CANCELLED', 'Operation cancelled.');
    }
    const failure = this.options.failures?.[method];
    if (failure) {
      throw new RemotishError(failure, `Injected ${method} failure.`);
    }
    if (this.options.latencyMs && this.options.latencyMs > 0) {
      await delay(this.options.latencyMs, options?.signal);
    }
  }
}
