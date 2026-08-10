import type {
  Branch,
  BranchName,
  CommitChange,
  CommitPage,
  CommitQuery,
  CommitRequest,
  CommitResult,
  DirectoryEntry,
  RemoteRequestOptions,
  RemotishAdapter,
  RepositoryInfo,
  RevisionId,
} from '@remotish/adapter-sdk';
import { FixtureBranchService } from './branch-service.js';
import { FixtureCommitEngine } from './commit-engine.js';
import { FixtureFaultInjector, type FixtureFaultOptions } from './fault-injector.js';
import type { FixtureRepository } from './model.js';
import { FixtureRepositoryView } from './repository-view.js';
import { createFixtureRepository } from './seed.js';

/** Optional fixture repository and fault controls used when constructing the test adapter. */
export interface FixtureAdapterOptions extends FixtureFaultOptions {}

/** Deterministic in-memory adapter used for contract and framework tests. */
export class FixtureAdapter implements RemotishAdapter {
  readonly capabilities = {
    commits: true,
    forceWithLease: true,
    amend: true,
    createBranch: true,
    deleteBranch: true,
  } as const;

  private readonly repository: FixtureRepository;
  private readonly view: FixtureRepositoryView;
  private readonly branches: FixtureBranchService;
  private readonly commits: FixtureCommitEngine;
  private readonly faults: FixtureFaultInjector;

  constructor(options: FixtureAdapterOptions = {}) {
    this.repository = createFixtureRepository();
    this.view = new FixtureRepositoryView(this.repository);
    this.branches = new FixtureBranchService(this.repository, this.view);
    this.commits = new FixtureCommitEngine(this.repository);
    this.faults = new FixtureFaultInjector(options);
  }

  async getRepository(options?: RemoteRequestOptions): Promise<RepositoryInfo> {
    await this.faults.before('getRepository', options);
    return { ...this.repository.info };
  }

  async readDirectory(
    revision: RevisionId,
    path: string,
    options?: RemoteRequestOptions,
  ): Promise<readonly DirectoryEntry[]> {
    await this.faults.before('readDirectory', options);
    return this.view.readDirectory(revision, path);
  }

  async readFile(
    revision: RevisionId,
    path: string,
    options?: RemoteRequestOptions,
  ): Promise<Uint8Array> {
    await this.faults.before('readFile', options);
    return this.view.readFile(revision, path);
  }

  async getBranches(options?: RemoteRequestOptions): Promise<readonly Branch[]> {
    await this.faults.before('getBranches', options);
    return this.view.getBranches();
  }

  async getCommits(request: CommitQuery, options?: RemoteRequestOptions): Promise<CommitPage> {
    await this.faults.before('getCommits', options);
    return this.view.getCommits(request);
  }

  async getCommitChanges(
    revision: RevisionId,
    options?: RemoteRequestOptions,
  ): Promise<readonly CommitChange[]> {
    await this.faults.before('getCommitChanges', options);
    return this.view.getCommitChanges(revision);
  }

  async commit(request: CommitRequest, options?: RemoteRequestOptions): Promise<CommitResult> {
    await this.faults.before('commit', options);
    return this.commits.execute(request);
  }

  async createBranch(
    name: BranchName,
    revision: RevisionId,
    options?: RemoteRequestOptions,
  ): Promise<Branch> {
    await this.faults.before('createBranch', options);
    return this.branches.create(name, revision);
  }

  async deleteBranch(name: BranchName, options?: RemoteRequestOptions): Promise<void> {
    await this.faults.before('deleteBranch', options);
    this.branches.delete(name);
  }

  moveBranchHead(branch: BranchName, revision: RevisionId): void {
    this.branches.moveHead(branch, revision);
  }

  getBranchHead(branch: BranchName): RevisionId {
    return this.branches.head(branch);
  }
}
