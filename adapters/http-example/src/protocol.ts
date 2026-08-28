import type {
  AmendCommitRequest,
  Change,
  ForceCommitRequest,
  NormalCommitRequest,
} from '@remotish/adapter-sdk';

/** JSON-safe representation of a working-tree change sent to the example HTTP service. */
export type WireChange =
  | {
      readonly type: 'add' | 'modify';
      readonly path: string;
      readonly contentBase64: string;
    }
  | {
      readonly type: 'delete';
      readonly path: string;
    };

/** JSON-safe commit-and-publish request used by the example HTTP protocol. */
export type WireCommitRequest =
  | WireRequest<NormalCommitRequest>
  | WireRequest<ForceCommitRequest>
  | WireRequest<AmendCommitRequest>;

type WireRequest<T extends { readonly changes: readonly Change[] }> = Omit<T, 'changes'> & {
  readonly changes: readonly WireChange[];
};

/** Encodes binary working-tree content without changing commit/push semantics. */
export function encodeCommitRequest(
  request: NormalCommitRequest | ForceCommitRequest | AmendCommitRequest,
): WireCommitRequest {
  const changes = request.changes.map(encodeChange);

  if (request.type === 'amend') {
    return { ...request, changes };
  }
  if (request.push.mode === 'normal') {
    return { ...request, changes };
  }
  return { ...request, changes };
}

function encodeChange(change: Change): WireChange {
  if (change.type === 'delete') {
    return change;
  }
  return {
    type: change.type,
    path: change.path,
    contentBase64: encodeBase64(change.content),
  };
}

function encodeBase64(content: Uint8Array): string {
  let binary = '';
  for (const byte of content) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
