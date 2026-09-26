import {
  REMOTISH_REPOSITORY_COMMAND_VERSION,
  REMOTISH_SELECT_PREPARED_BRANCH_VERSION,
  RemotishError,
  type RemotishRepositoryCommandV1,
  type RemotishSelectPreparedBranchCommandV1,
} from '@remotish/adapter-sdk';

const SECRET_DESCRIPTOR_KEYS = new Set([
  'access_token',
  'api_token',
  'authorization',
  'client_secret',
  'credential',
  'credentials',
  'oauth_token',
  'password',
  'private_key',
  'publisher_token',
  'refresh_token',
  'secret',
  'session',
  'session_id',
  'token',
]);

export function requirePreparedBranchCommand(
  value: unknown,
): RemotishSelectPreparedBranchCommandV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RemotishError('INVALID_REQUEST', 'Prepared branch command requires an object.');
  }
  const input = value as Record<string, unknown>;
  if (input.version !== REMOTISH_SELECT_PREPARED_BRANCH_VERSION) {
    throw new RemotishError('UNSUPPORTED', 'Unsupported prepared branch command version.');
  }
  if (input.operation === 'check') {
    if (Object.keys(input).some((key) => key !== 'version' && key !== 'operation')) {
      throw new RemotishError('INVALID_REQUEST', 'Unknown prepared branch command field.');
    }
    return { version: REMOTISH_SELECT_PREPARED_BRANCH_VERSION, operation: 'check' };
  }
  if (input.operation !== 'select') {
    throw new RemotishError('INVALID_REQUEST', 'Unknown prepared branch operation.');
  }
  if (
    Object.keys(input).some(
      (key) => !['version', 'operation', 'workspaceId', 'branch'].includes(key),
    ) ||
    typeof input.workspaceId !== 'string' ||
    !input.workspaceId.trim() ||
    typeof input.branch !== 'string' ||
    !input.branch.trim()
  ) {
    throw new RemotishError('INVALID_REQUEST', 'Invalid prepared branch selection.');
  }
  return {
    version: REMOTISH_SELECT_PREPARED_BRANCH_VERSION,
    operation: 'select',
    workspaceId: input.workspaceId,
    branch: input.branch,
  };
}

export function requireRepositoryCommand(value: unknown): RemotishRepositoryCommandV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RemotishError('INVALID_REQUEST', 'Remotish repository command requires an object.');
  }
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!['version', 'provider', 'repository', 'branch', 'path'].includes(key)) {
      throw new RemotishError(
        'INVALID_REQUEST',
        `Unknown Remotish repository command field: ${key}.`,
      );
    }
  }
  if (input.version !== REMOTISH_REPOSITORY_COMMAND_VERSION) {
    throw new RemotishError(
      'UNSUPPORTED',
      `Unsupported Remotish repository command version: ${String(input.version)}.`,
    );
  }
  if (typeof input.provider !== 'string' || !input.provider.trim()) {
    throw new RemotishError('INVALID_REQUEST', 'Remotish repository command requires provider.');
  }
  if (
    !input.repository ||
    typeof input.repository !== 'object' ||
    Array.isArray(input.repository)
  ) {
    throw new RemotishError(
      'INVALID_REQUEST',
      'Remotish repository command requires a repository descriptor object.',
    );
  }
  if (input.branch !== undefined && (typeof input.branch !== 'string' || !input.branch.trim())) {
    throw new RemotishError('INVALID_REQUEST', 'Requested branch must be a non-empty string.');
  }
  if (input.path !== undefined && typeof input.path !== 'string') {
    throw new RemotishError('INVALID_REQUEST', 'Requested path must be a string.');
  }

  const repository = snapshotRepositoryDescriptor(input.repository as Record<string, unknown>);
  return {
    version: REMOTISH_REPOSITORY_COMMAND_VERSION,
    provider: input.provider,
    repository,
    ...(input.branch !== undefined ? { branch: input.branch } : {}),
    ...(input.path !== undefined ? { path: input.path } : {}),
  };
}

export function validateRepositoryDescriptor(repository: Readonly<Record<string, string>>): void {
  for (const key of Object.keys(repository)) {
    if (SECRET_DESCRIPTOR_KEYS.has(normalizeDescriptorKey(key))) {
      throw new RemotishError(
        'INVALID_REQUEST',
        `Repository descriptor must not contain secret field "${key}".`,
      );
    }
  }
}

export function preparationKey(
  providerId: string,
  repository: Readonly<Record<string, string>>,
  branch: string | undefined,
  expectedWorkspaceId: string | undefined,
): string {
  const entries = Object.entries(repository).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return JSON.stringify([providerId, entries, branch ?? '', expectedWorkspaceId ?? '']);
}

function snapshotRepositoryDescriptor(
  value: Record<string, unknown>,
): Readonly<Record<string, string>> {
  const entries = Object.entries(value);
  if (entries.length === 0) {
    throw new RemotishError('INVALID_REQUEST', 'Repository descriptor must not be empty.');
  }
  const snapshot: Record<string, string> = {};
  for (const [key, entryValue] of entries) {
    if (!key.trim() || typeof entryValue !== 'string' || !entryValue.trim()) {
      throw new RemotishError(
        'INVALID_REQUEST',
        'Repository descriptor keys and values must be non-empty strings.',
      );
    }
    snapshot[key] = entryValue;
  }
  return snapshot;
}

function normalizeDescriptorKey(key: string): string {
  return key
    .trim()
    .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .toLowerCase()
    .replace(/[-\s]+/gu, '_');
}
