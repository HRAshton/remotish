/** Features an adapter exposes to the Remotish framework. */
export interface RemotishCapabilities {
  /** Whether the remote accepts commit-and-publish operations. */
  readonly commits: boolean;

  /**
   * Whether the local working overlay may be edited when publication is unavailable.
   *
   * Commit-capable adapters are always editable, so this is only needed to opt a
   * `commits: false` adapter into local-only working-tree mutations.
   */
  readonly localEdits?: boolean;

  /** Whether non-fast-forward publication is supported with an explicit lease. Requires commits. */
  readonly forceWithLease?: boolean;

  /** Whether the current remote commit can be amended using force-with-lease. Requires forceWithLease. */
  readonly amend?: boolean;

  /** Whether the adapter can create remote branches. */
  readonly createBranch?: boolean;

  /** Whether the adapter can delete remote branches. */
  readonly deleteBranch?: boolean;
}
