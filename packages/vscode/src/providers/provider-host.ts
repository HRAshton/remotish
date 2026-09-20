import {
  REMOTISH_ENSURE_REPOSITORY_COMMAND,
  REMOTISH_OPEN_REPOSITORY_COMMAND,
  REMOTISH_REFRESH_PROVIDERS_COMMAND,
  REMOTISH_REPOSITORY_COMMAND_VERSION,
  RemotishError,
  type RemotishAdapterProviderV1,
  type RemotishRepositoryCommandV1,
  type RemotishRepositoryRequest,
  type RemotishRepositoryResultV1,
} from '@remotish/adapter-sdk';
import { type Disposable as CoreDisposable, RemotishWorkspace } from '@remotish/core';
import * as vscode from 'vscode';
import { createWorkingUri } from '../filesystem/provider.js';
import { RemotishVsCodeHost } from '../host.js';
import { StorageUriWorkspaceStorage } from '../persistence/storage-uri-workspace-storage.js';
import { ProviderDiscovery, type DiscoveredProvider } from './provider-discovery.js';
import { normalizeProviderId, ProviderRegistry, type RegisteredProvider } from './provider-registry.js';
import { createStableWorkspaceId, verifyStableWorkspaceId } from './workspace-id.js';

const HOST_RESTORE_PREFIX = 'remotish.restore.v1.';
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

interface HostRestoreMetadataV1 {
  readonly version: 1;
  readonly provider: string;
  readonly providerDisplayName: string;
  readonly extensionId: string;
}

export interface RemotishProviderHostOptions {
  readonly defaultRestoreTimeoutMs?: number;
}

/**
 * Owns provider discovery, repository preparation commands, canonical restoration, and the
 * VS Code host used by those workspaces.
 */
export class RemotishProviderHost implements vscode.Disposable {
  readonly host: RemotishVsCodeHost;
  readonly providers = new ProviderRegistry();
  readonly discovery = new ProviderDiscovery(this.providers);

  private readonly storage: StorageUriWorkspaceStorage;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly workspaceRegistrations: CoreDisposable[] = [];
  private readonly preparationTails = new Map<string, Promise<void>>();
  private disposed = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    options: RemotishProviderHostOptions = {},
  ) {
    // Canonical repository state must survive bootstrap-workspace -> remotish:// navigation.
    this.storage = new StorageUriWorkspaceStorage(context.globalStorageUri, 'provider-workspaces');
    this.host = new RemotishVsCodeHost({
      ...(options.defaultRestoreTimeoutMs !== undefined
        ? { defaultRestoreTimeoutMs: options.defaultRestoreTimeoutMs }
        : {}),
      restoreWorkspace: (workspaceId) => this.restoreWorkspace(workspaceId),
    });

    this.discovery.refresh();
    this.disposables.push(
      vscode.commands.registerCommand(REMOTISH_ENSURE_REPOSITORY_COMMAND, (value: unknown) =>
        this.ensureRepository(requireCommand(value)),
      ),
      vscode.commands.registerCommand(REMOTISH_OPEN_REPOSITORY_COMMAND, async (value: unknown) => {
        const result = await this.ensureRepository(requireCommand(value));
        await vscode.commands.executeCommand(
          'vscode.openFolder',
          createWorkingUri(result.workspaceId),
          false,
        );
        return result;
      }),
      vscode.commands.registerCommand(REMOTISH_REFRESH_PROVIDERS_COMMAND, () =>
        this.discovery.refresh(),
      ),
    );
  }

  /** Manifest-only provider information; reading it never activates providers. */
  listProviders(): readonly DiscoveredProvider[] {
    return this.discovery.list();
  }

  /** Internal/embedded registration path; ordinary provider extensions use discovery instead. */
  registerProvider(provider: RemotishAdapterProviderV1, extensionId: string): CoreDisposable {
    return this.providers.register(provider, extensionId);
  }

  async ensureRepository(
    request: RemotishRepositoryCommandV1,
  ): Promise<RemotishRepositoryResultV1> {
    return this.prepareRepository(request);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const disposable of [...this.disposables].reverse()) {
      disposable.dispose();
    }
    for (const registration of [...this.workspaceRegistrations].reverse()) {
      registration.dispose();
    }
    this.host.dispose();
  }

  private async prepareRepository(
    request: RemotishRepositoryRequest,
    expectedWorkspaceId?: string,
  ): Promise<RemotishRepositoryResultV1> {
    const provider = await this.resolveProvider(request.provider);
    validateRepositoryDescriptor(request.repository);
    provider.validateRepository(request.repository);

    // Opening a candidate is intentionally outside the workspace-ID critical section. It only
    // reads remote/persisted state. Branch mutation and persistence happen after serialization.
    const adapter = await provider.createAdapter(request.repository);
    const candidate = await RemotishWorkspace.open(adapter, this.storage);
    const workspaceId = await createStableWorkspaceId(provider.id, candidate.repositoryInfo.id);
    if (expectedWorkspaceId !== undefined) {
      await verifyStableWorkspaceId(provider.id, candidate.repositoryInfo.id, expectedWorkspaceId);
    }

    const requestedBranch = request.branch?.trim();
    const workspace = await this.serializeWorkspace(workspaceId, async () => {
      const existing = this.host.registry.get(workspaceId)?.workspace;
      if (existing) {
        if (requestedBranch && existing.branch !== requestedBranch) {
          await existing.switchBranch(requestedBranch);
        }
        return existing;
      }

      if (requestedBranch && candidate.branch !== requestedBranch) {
        await candidate.switchBranch(requestedBranch);
      }
      const registration = this.host.registry.register(workspaceId, candidate);
      this.workspaceRegistrations.push(registration);
      return candidate;
    });

    await this.context.globalState.update(`${HOST_RESTORE_PREFIX}${workspaceId}`, {
      version: 1,
      provider: provider.id,
      providerDisplayName: provider.displayName,
      extensionId: provider.extensionId,
    } satisfies HostRestoreMetadataV1);

    const uri = createWorkingUri(workspaceId);
    // Path is caller-specific and is never part of shared workspace preparation.
    const resourceUri = request.path ? createWorkingUri(workspaceId, request.path) : undefined;
    return {
      version: REMOTISH_REPOSITORY_COMMAND_VERSION,
      workspaceId,
      repositoryId: workspace.repositoryInfo.id,
      branch: workspace.branch,
      uri: uri.toString(),
      ...(resourceUri ? { resourceUri: resourceUri.toString() } : {}),
    };
  }

  private async restoreWorkspace(workspaceId: string): Promise<void> {
    const metadata = this.context.globalState.get<HostRestoreMetadataV1>(
      `${HOST_RESTORE_PREFIX}${workspaceId}`,
    );
    if (metadata?.version !== 1) {
      throw new RemotishError(
        'INVALID_REQUEST',
        `No provider restoration metadata exists for ${workspaceId}.`,
      );
    }

    let discovered = this.discovery.get(metadata.provider);
    if (!discovered) {
      this.discovery.refresh();
      discovered = this.discovery.get(metadata.provider);
    }
    if (!discovered) {
      throw new RemotishError(
        'UNSUPPORTED',
        `${metadata.providerDisplayName} provider is not installed or enabled.`,
      );
    }
    if (discovered.extensionId !== metadata.extensionId.toLowerCase()) {
      throw new RemotishError(
        'INVALID_REQUEST',
        `Provider ${metadata.provider} is installed as ${discovered.extensionId}, not persisted extension ${metadata.extensionId}.`,
      );
    }

    const provider = await this.discovery.activate(metadata.provider);
    if (!provider.restoreWorkspace) {
      throw new RemotishError(
        'UNSUPPORTED',
        `Provider ${provider.displayName} does not support workspace restoration.`,
      );
    }

    const request = await provider.restoreWorkspace(workspaceId);
    if (!request) {
      throw new RemotishError(
        'INVALID_REQUEST',
        `Provider ${provider.displayName} has no restoration record for ${workspaceId}.`,
      );
    }
    if (normalizeProviderId(request.provider) !== provider.id) {
      throw new RemotishError(
        'INVALID_REQUEST',
        `Provider ${provider.id} returned restoration data for ${request.provider}.`,
      );
    }

    await this.prepareRepository(request, workspaceId);
  }

  private async resolveProvider(providerId: string): Promise<RegisteredProvider> {
    const normalized = normalizeProviderId(providerId);
    return this.providers.get(normalized) ?? this.discovery.activate(normalized);
  }

  private async serializeWorkspace<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.preparationTails.get(workspaceId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const settled = current.then(
      () => undefined,
      () => undefined,
    );
    this.preparationTails.set(workspaceId, settled);
    try {
      return await current;
    } finally {
      if (this.preparationTails.get(workspaceId) === settled) {
        this.preparationTails.delete(workspaceId);
      }
    }
  }
}

function requireCommand(value: unknown): RemotishRepositoryCommandV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RemotishError('INVALID_REQUEST', 'Remotish repository command requires an object.');
  }
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!['version', 'provider', 'repository', 'branch', 'path'].includes(key)) {
      throw new RemotishError('INVALID_REQUEST', `Unknown Remotish repository command field: ${key}.`);
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
  if (!input.repository || typeof input.repository !== 'object' || Array.isArray(input.repository)) {
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

function validateRepositoryDescriptor(repository: Readonly<Record<string, string>>): void {
  for (const key of Object.keys(repository)) {
    const normalizedKey = key.trim().toLowerCase().replace(/[-\s]/gu, '_');
    if (SECRET_DESCRIPTOR_KEYS.has(normalizedKey)) {
      throw new RemotishError(
        'INVALID_REQUEST',
        `Repository descriptor must not contain secret field "${key}".`,
      );
    }
  }
}
