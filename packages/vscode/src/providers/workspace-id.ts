import { RemotishError } from '@remotish/adapter-sdk';
import { normalizeProviderId } from './provider-registry.js';

const encoder = new TextEncoder();

/** Persisted format version for stable Remotish workspace authorities. */
export const REMOTISH_WORKSPACE_ID_FORMAT_VERSION = 1 as const;

/**
 * Stable workspace-ID format v1.
 * Input: normalized provider id, NUL separator, exact trimmed stable repository id.
 * Digest: SHA-256. Authority: <provider>-<first 32 lowercase hex digest characters>.
 */
export async function createStableWorkspaceId(
  providerId: string,
  repositoryId: string,
): Promise<string> {
  const provider = normalizeProviderId(providerId);
  const repository = repositoryId.trim();
  if (!repository) {
    throw new RemotishError('INVALID_REQUEST', 'Stable repository id is required.');
  }

  const input = encoder.encode(`${provider}\0${repository}`);
  const digest = await crypto.subtle.digest('SHA-256', input);
  const hash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `${provider}-${hash.slice(0, 32)}`;
}

/** Verifies that a restored adapter still resolves to the persisted canonical authority. */
export async function verifyStableWorkspaceId(
  providerId: string,
  repositoryId: string,
  expectedWorkspaceId: string,
): Promise<void> {
  const actual = await createStableWorkspaceId(providerId, repositoryId);
  if (actual !== expectedWorkspaceId.trim().toLowerCase()) {
    throw new RemotishError(
      'INVALID_REQUEST',
      `Repository identity does not match restored workspace ${expectedWorkspaceId}.`,
    );
  }
}
