import type { RemotishAdapter } from '@remotish/adapter-sdk';
import { RemotishError } from '@remotish/adapter-sdk';

/** Fails fast when an adapter advertises a capability its implementation cannot honor. */
export function validateAdapterContract(adapter: RemotishAdapter): void {
  const { capabilities } = adapter;

  if (capabilities.commits && !adapter.commit) {
    invalid('Adapter declares commit support but does not implement commit().');
  }
  if (capabilities.forceWithLease && !capabilities.commits) {
    invalid('forceWithLease requires commit support.');
  }
  if (capabilities.amend && !capabilities.forceWithLease) {
    invalid('amend requires forceWithLease support.');
  }
  if (capabilities.createBranch && !adapter.createBranch) {
    invalid('Adapter declares branch creation support but does not implement createBranch().');
  }
  if (capabilities.deleteBranch && !adapter.deleteBranch) {
    invalid('Adapter declares branch deletion support but does not implement deleteBranch().');
  }
}

function invalid(message: string): never {
  throw new RemotishError('INVALID_REQUEST', `Invalid adapter contract: ${message}`);
}
