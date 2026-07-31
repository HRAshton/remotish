import { RemotishError, type RepoPath } from '@remotish/adapter-sdk';

/** Default maximum nesting followed by recursive repository operations. */
const DEFAULT_MAX_TRAVERSAL_DEPTH = 256;

/** Default maximum number of directory entries visited by one recursive operation. */
const DEFAULT_MAX_TRAVERSAL_NODES = 100_000;

/** Small per-operation guard against hostile or accidentally cyclic/huge remote trees. */
export class TraversalBudget {
  private visitedNodes = 0;

  constructor(
    private readonly maxDepth = DEFAULT_MAX_TRAVERSAL_DEPTH,
    private readonly maxNodes = DEFAULT_MAX_TRAVERSAL_NODES,
  ) {}

  enterDirectory(path: RepoPath, depth: number): void {
    if (depth > this.maxDepth) {
      throw new RemotishError(
        'UNSUPPORTED',
        `Repository traversal exceeded the maximum depth of ${this.maxDepth} at ${
          path || '<root>'
        }.`,
      );
    }
  }

  visit(path: RepoPath): void {
    this.visitedNodes += 1;
    if (this.visitedNodes > this.maxNodes) {
      throw new RemotishError(
        'UNSUPPORTED',
        `Repository traversal exceeded the maximum node count of ${this.maxNodes} at ${path}.`,
      );
    }
  }
}
