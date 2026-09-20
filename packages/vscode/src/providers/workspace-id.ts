import { RemotishError } from '@remotish/adapter-sdk';
import { normalizeProviderId } from './provider-registry.js';

const encoder = new TextEncoder();

/**
 * Derives a branch-independent workspace authority from provider identity and stable repository ID.
 *
 * The repository ID is hashed so workspace authorities do not expose provider-specific identifiers.
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
