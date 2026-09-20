import { RemotishError } from '@remotish/adapter-sdk';
import type { RemotishDisposable, RemotishProviderRegistration } from '../provider-api.js';

const PROVIDER_ID_MAX_LENGTH = 64;
const EXTENSION_ID_PATTERN = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9.-]*$/u;

/** Tracks provider wrapper registrations exposed through the installed Remotish host. */
export class ProviderRegistry {
  private readonly providers = new Map<string, RemotishProviderRegistration>();

  register(provider: RemotishProviderRegistration): RemotishDisposable {
    const id = normalizeProviderId(provider.id);
    const displayName = provider.displayName.trim();
    const extensionId = provider.extensionId.trim().toLowerCase();
    if (!displayName) {
      throw new RemotishError('INVALID_REQUEST', 'Provider displayName is required.');
    }
    if (!EXTENSION_ID_PATTERN.test(extensionId)) {
      throw new RemotishError(
        'INVALID_REQUEST',
        `Provider ${id} must declare a valid VS Code extensionId.`,
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
    if (this.providers.has(id)) {
      throw new RemotishError('INVALID_REQUEST', `Provider ${id} is already registered.`);
    }

    const registration: RemotishProviderRegistration = {
      id,
      displayName,
      extensionId,
      validateRepository: (repository) => provider.validateRepository(repository),
      createAdapter: (repository) => provider.createAdapter(repository),
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

  get(id: string): RemotishProviderRegistration | undefined {
    return this.providers.get(normalizeProviderId(id));
  }

  require(id: string): RemotishProviderRegistration {
    const provider = this.get(id);
    if (!provider) {
      throw new RemotishError('NOT_FOUND', `Remotish provider ${id} is not registered.`);
    }
    return provider;
  }

  list(): readonly RemotishProviderRegistration[] {
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
