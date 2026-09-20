import { FixtureAdapter } from '@remotish/adapter-fixture';
import { RemotishWorkspace } from '@remotish/core';
import {
  createStableWorkspaceId,
  createWorkingUri,
  ProviderRegistry,
  RemotishVsCodeHost,
  StorageUriWorkspaceStorage,
  verifyStableWorkspaceId,
} from '@remotish/vscode';
import {
  REMOTISH_EXTENSION_API_VERSION,
  type RemotishExtensionApiV1,
  type RemotishOpenRequest,
  type RemotishOpenResult,
} from '@remotish/vscode/provider-api';
import { RemotishHistoryHost } from '@remotish/vscode-history';
import * as vscode from 'vscode';

const WORKSPACE_ID = 'fixture-demo';
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
  readonly extensionId: string;
}

export async function activate(context: vscode.ExtensionContext): Promise<RemotishExtensionApiV1> {
  const storageRoot = context.storageUri ?? context.globalStorageUri;
  const hostStorage = new StorageUriWorkspaceStorage(storageRoot, 'host');
  const demoStorage = new StorageUriWorkspaceStorage(storageRoot, 'demo-fixture');
  const providers = new ProviderRegistry();
  const pendingPreparations = new Map<string, Promise<RemotishOpenResult>>();

  const host = new RemotishVsCodeHost({
    restoreWorkspace: async (workspaceId) => {
      const metadata = context.globalState.get<HostRestoreMetadataV1>(
        `${HOST_RESTORE_PREFIX}${workspaceId}`,
      );
      if (metadata?.version !== 1) {
        throw new Error(`No provider restoration metadata exists for ${workspaceId}.`);
      }

      const extension = vscode.extensions.getExtension(metadata.extensionId);
      if (!extension) {
        throw new Error(
          `Provider extension ${metadata.extensionId} for ${workspaceId} is not installed.`,
        );
      }

      if (!extension.isActive) {
        await extension.activate();
      }

      if (!providers.get(metadata.provider)) {
        throw new Error(
          `Provider ${metadata.provider} did not register after activating ${metadata.extensionId}.`,
        );
      }

      // The provider wrapper owns the descriptor and, on activation, must restore the canonical
      // workspace by calling ensureRepository() with expectedWorkspaceId set to workspaceId.
    },
  });
  const history = new RemotishHistoryHost(host);
  context.subscriptions.push(host, history);

  const ensureRepository = (request: RemotishOpenRequest): Promise<RemotishOpenResult> => {
    validateOpenRequest(request);
    const key = preparationKey(request);
    const pending = pendingPreparations.get(key);

    if (pending !== undefined) {
      return pending;
    }

    const preparation = prepareRepository(request).finally(() => {
      if (pendingPreparations.get(key) === preparation) {
        pendingPreparations.delete(key);
      }
    });

    pendingPreparations.set(key, preparation);
    return preparation;
  };

  const prepareRepository = async (request: RemotishOpenRequest): Promise<RemotishOpenResult> => {
    const provider = providers.require(request.provider);
    provider.validateRepository(request.repository);

    const adapter = await provider.createAdapter(request.repository);
    const candidate = await RemotishWorkspace.open(adapter, hostStorage);
    const workspaceId = await createStableWorkspaceId(provider.id, candidate.repositoryInfo.id);

    if (request.expectedWorkspaceId) {
      await verifyStableWorkspaceId(
        provider.id,
        candidate.repositoryInfo.id,
        request.expectedWorkspaceId,
      );
    }

    const requestedBranch = request.branch?.trim();
    const existing = host.registry.get(workspaceId);
    let workspace = existing?.workspace;

    if (workspace) {
      if (requestedBranch && workspace.branch !== requestedBranch) {
        await workspace.switchBranch(requestedBranch);
      }
    } else {
      if (requestedBranch && candidate.branch !== requestedBranch) {
        await candidate.switchBranch(requestedBranch);
      }
      const unregister = host.registry.register(workspaceId, candidate);
      context.subscriptions.push(unregister);
      workspace = candidate;
    }

    await context.globalState.update(`${HOST_RESTORE_PREFIX}${workspaceId}`, {
      version: 1,
      provider: provider.id,
      extensionId: provider.extensionId,
    } satisfies HostRestoreMetadataV1);

    const uri = createWorkingUri(workspaceId);
    const requestedPath = request.path?.trim();
    const resourceUri = requestedPath ? createWorkingUri(workspaceId, requestedPath) : undefined;

    return {
      workspaceId,
      repositoryId: workspace.repositoryInfo.id,
      branch: workspace.branch,
      uri: uri.toString(),
      ...(resourceUri ? { resourceUri: resourceUri.toString() } : {}),
    };
  };

  const api: RemotishExtensionApiV1 = {
    version: REMOTISH_EXTENSION_API_VERSION,

    registerProvider(provider) {
      const registration = providers.register(provider);
      context.subscriptions.push(registration);
      return registration;
    },

    ensureRepository,

    async openRepository(request) {
      const result = await ensureRepository(request);
      await vscode.commands.executeCommand(
        'vscode.openFolder',
        createWorkingUri(result.workspaceId),
        false,
      );
      return result;
    },
  };

  const demoWorkspace = await RemotishWorkspace.open(new FixtureAdapter(), demoStorage);
  const unregisterDemo = host.registry.register(WORKSPACE_ID, demoWorkspace);
  const openFixture = vscode.commands.registerCommand('remotish.demo.openFixture', () =>
    vscode.commands.executeCommand('vscode.openFolder', createWorkingUri(WORKSPACE_ID), false),
  );
  context.subscriptions.push(unregisterDemo, openFixture);

  return api;
}

function validateOpenRequest(request: RemotishOpenRequest): void {
  if (!request.provider.trim()) {
    throw new Error('Remotish open request requires a provider id.');
  }
  if (
    !request.repository ||
    typeof request.repository !== 'object' ||
    Array.isArray(request.repository)
  ) {
    throw new Error('Remotish open request requires a repository descriptor object.');
  }

  const entries = Object.entries(request.repository);
  if (entries.length === 0) {
    throw new Error('Remotish repository descriptor must not be empty.');
  }

  for (const [key, value] of entries) {
    const normalizedKey = key.trim().toLowerCase().replace(/[-\s]/gu, '_');
    if (!key.trim() || typeof value !== 'string' || !value.trim()) {
      throw new Error('Remotish repository descriptor keys and values must be non-empty strings.');
    }
    if (SECRET_DESCRIPTOR_KEYS.has(normalizedKey)) {
      throw new Error(`Remotish repository descriptor must not contain secret field "${key}".`);
    }
  }

  if (request.branch !== undefined && !request.branch.trim()) {
    throw new Error('Requested branch must not be empty.');
  }
  if (request.expectedWorkspaceId !== undefined && !request.expectedWorkspaceId.trim()) {
    throw new Error('Expected workspace id must not be empty.');
  }
}

function preparationKey(request: RemotishOpenRequest): string {
  return JSON.stringify({
    provider: request.provider.trim().toLowerCase(),
    repository: Object.entries(request.repository)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, value.trim()]),
    branch: request.branch?.trim() ?? '',
    expectedWorkspaceId: request.expectedWorkspaceId?.trim().toLowerCase() ?? '',
  });
}
