/** Features an adapter exposes to the Remotish framework. */
export interface RemotishCapabilities {
  /** Whether the remote accepts commit-and-publish operations. False makes the workspace read-only. */
  readonly commits: boolean;

  /** Whether non-fast-forward publication is supported with an explicit lease. Requires commits. */
  readonly forceWithLease?: boolean;

  /** Whether the current remote commit can be amended using force-with-lease. Requires forceWithLease. */
  readonly amend?: boolean;

  /** Whether the adapter can create remote branches. */
  readonly createBranch?: boolean;

  /** Whether the adapter can delete remote branches. */
  readonly deleteBranch?: boolean;
}
