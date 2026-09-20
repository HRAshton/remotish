import {
  REMOTISH_ADAPTER_PROVIDER_API_VERSION,
  type RemotishAdapterProviderV1,
  RemotishError,
} from '@remotish/adapter-sdk';
import type { Disposable } from '@remotish/core';

const PROVIDER_ID_MAX_LENGTH = 64;
const EXTENSION_ID_PATTERN = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9.-]*$/u;

/** Validated provider implementation associated with the extension that owns it. */
export interface RegisteredProvider extends RemotishAdapterProviderV1 {
  readonly extensionId: string;
}

/** Tracks validated provider implementations for the current extension-host lifetime. */
export class ProviderRegistry {
  private readonly providers = new Map<string, RegisteredProvider>();

  register(provider: RemotishAdapterProviderV1, extensionIdValue: string): Disposable {
    const id = normalizeProviderId(provider.id);
    const displayName = provider.displayName.trim();
    const extensionId = extensionIdValue.trim().toLowerCase();

    if (!displayName) {
      throw new RemotishError('INVALID_REQUEST', `Provider ${id} requires a displayName.`);
    }
    if (!EXTENSION_ID_PATTERN.test(extensionId)) {
      throw new RemotishError(
        'INVALID_REQUEST',
        `Provider ${id} must be associated with a valid VS Code extension id.`,
      );
    }
    if (provider.apiVersion !== REMOTISH_ADAPTER_PROVIDER_API_VERSION) {
      throw new RemotishError(
        'UNSUPPORTED',
        `Provider ${id} uses unsupported API version ${String(provider.apiVersion)}.`,
      );
    }
    if (typeof provider.validateRepository !== 'function') {
      throw new RemotishError(
        'INVALID_REQUEST',
        `Provider ${id} must define validateRepository().`,
      );
    }
    if (typeof provider.createAdapter !== 'function') {
      throw new RemotishError('INVALID_REQUEST', `Provider ${id} must define createAdapter().`);
    }
    if (
      provider.restoreWorkspace !== undefined &&
      typeof provider.restoreWorkspace !== 'function'
    ) {
      throw new RemotishError(
        'INVALID_REQUEST',
        `Provider ${id} restoreWorkspace must be a function.`,
      );
    }
    if (this.providers.has(id)) {
      throw new RemotishError('INVALID_REQUEST', `Provider ${id} is already registered.`);
    }

    const restoreWorkspace = provider.restoreWorkspace;
    const registration: RegisteredProvider = {
      apiVersion: REMOTISH_ADAPTER_PROVIDER_API_VERSION,
      id,
      displayName,
      extensionId,
      validateRepository: (repository) => provider.validateRepository.call(provider, repository),
      createAdapter: (repository) => provider.createAdapter.call(provider, repository),
      ...(restoreWorkspace
        ? {
            restoreWorkspace: (workspaceId) => restoreWorkspace.call(provider, workspaceId),
          }
        : {}),
    };
    this.providers.set(id, registration);

    let disposed = false;
    return {
      dispose: () => {
        if (disposed) {
          return;
        }
        disposed = true;
        if (this.providers.get(id) === registration) {
          this.providers.delete(id);
        }
      },
    };
  }

  get(id: string): RegisteredProvider | undefined {
    return this.providers.get(normalizeProviderId(id));
  }

  require(id: string): RegisteredProvider {
    const provider = this.get(id);
    if (!provider) {
      throw new RemotishError('UNSUPPORTED', `Remotish provider ${id} is not available.`);
    }
    return provider;
  }

  list(): readonly RegisteredProvider[] {
    return [...this.providers.values()];
  }
}

export function normalizeProviderId(id: string): string {
  const normalized = id.trim().toLowerCase();
  if (
    normalized.length === 0 ||
    normalized.length > PROVIDER_ID_MAX_LENGTH ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(normalized)
  ) {
    throw new RemotishError('INVALID_REQUEST', `Invalid provider id: ${id}`);
  }
  return normalized;
}
