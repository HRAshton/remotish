import { RemotishError } from '@remotish/adapter-sdk';

export const GITHUB_PROVIDER_ID = 'github';

export interface GitHubRepositoryDescriptor {
  readonly owner: string;
  readonly repository: string;
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
const REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/u;

/** Decode the credential-free GitHub repository identity accepted by the provider. */
export function decodeGitHubRepository(value: unknown): GitHubRepositoryDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidRepository();
  }
  const data = value as Record<string, unknown>;
  const keys = Object.keys(data).sort();
  if (keys.length !== 2 || keys[0] !== 'owner' || keys[1] !== 'repository') {
    throw invalidRepository();
  }
  if (typeof data.owner !== 'string' || !OWNER.test(data.owner) || data.owner !== data.owner.trim()) {
    throw invalidRepository();
  }
  if (
    typeof data.repository !== 'string' ||
    !REPOSITORY.test(data.repository) ||
    data.repository !== data.repository.trim() ||
    data.repository === '.' ||
    data.repository === '..'
  ) {
    throw invalidRepository();
  }
  return { owner: data.owner, repository: data.repository };
}

function invalidRepository(): RemotishError {
  return new RemotishError(
    'INVALID_REQUEST',
    'GitHub provider expects a public GitHub owner and repository only.',
  );
}
