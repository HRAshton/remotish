import {
  REMOTISH_ADAPTER_PROVIDER_API_VERSION,
  type RemotishAdapterProviderV1,
  RemotishError,
} from '@remotish/adapter-sdk';
import * as vscode from 'vscode';
import {
  normalizeProviderId,
  type ProviderRegistry,
  type RegisteredProvider,
} from './provider-registry.js';

export type ProviderDiscoveryState = 'available' | 'unsupported' | 'malformed';

/** Manifest-only provider information available without activating the extension. */
export interface DiscoveredProvider {
  readonly id?: string;
  readonly displayName?: string;
  readonly extensionId: string;
  readonly apiVersion?: number;
  readonly state: ProviderDiscoveryState;
  readonly message?: string;
}

interface ProviderDescriptor {
  readonly id: string;
  readonly displayName: string;
  readonly extensionId: string;
  readonly apiVersion: number;
  readonly extension: vscode.Extension<unknown>;
}

/** Discovers marked extensions without activation and activates one provider only when requested. */
export class ProviderDiscovery {
  private readonly descriptors = new Map<string, ProviderDescriptor>();
  private readonly diagnostics = new Map<string, DiscoveredProvider>();
  private readonly activations = new Map<string, Promise<RegisteredProvider>>();

  constructor(private readonly registry: ProviderRegistry) {}

  refresh(): readonly DiscoveredProvider[] {
    const next = new Map<string, ProviderDescriptor>();
    const diagnostics = new Map<string, DiscoveredProvider>();

    for (const extension of vscode.extensions.all) {
      const raw = readManifestObject(extension);
      if (!raw) {
        continue;
      }

      const extensionId = extension.id.toLowerCase();
      if (
        typeof raw.id !== 'string' ||
        typeof raw.displayName !== 'string' ||
        !raw.displayName.trim()
      ) {
        diagnostics.set(extensionId, {
          extensionId,
          state: 'malformed',
          message: `Provider extension ${extension.id} has malformed Remotish discovery metadata.`,
        });
        continue;
      }

      let id: string;
      try {
        id = normalizeProviderId(raw.id);
      } catch (error) {
        diagnostics.set(extensionId, {
          extensionId,
          state: 'malformed',
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      const apiVersion = typeof raw.apiVersion === 'number' ? raw.apiVersion : Number.NaN;
      const descriptor: ProviderDescriptor = {
        id,
        displayName: raw.displayName.trim(),
        extensionId,
        apiVersion,
        extension,
      };
      const existing = next.get(id);
      if (existing) {
        throw new RemotishError(
          'INVALID_REQUEST',
          `Provider id ${id} is claimed by both ${existing.extensionId} and ${extensionId}.`,
        );
      }
      next.set(id, descriptor);
      diagnostics.set(extensionId, {
        id,
        displayName: descriptor.displayName,
        extensionId,
        apiVersion,
        state: apiVersion === REMOTISH_ADAPTER_PROVIDER_API_VERSION ? 'available' : 'unsupported',
        ...(apiVersion === REMOTISH_ADAPTER_PROVIDER_API_VERSION
          ? {}
          : {
              message: `Provider ${id} declares unsupported API version ${String(raw.apiVersion)}.`,
            }),
      });
    }

    this.descriptors.clear();
    for (const [id, descriptor] of next) {
      this.descriptors.set(id, descriptor);
    }
    this.diagnostics.clear();
    for (const [extensionId, diagnostic] of diagnostics) {
      this.diagnostics.set(extensionId, diagnostic);
    }
    return this.list();
  }

  list(): readonly DiscoveredProvider[] {
    return [...this.diagnostics.values()].sort((left, right) =>
      (left.id ?? left.extensionId).localeCompare(right.id ?? right.extensionId),
    );
  }

  get(id: string): DiscoveredProvider | undefined {
    const descriptor = this.descriptors.get(normalizeProviderId(id));
    if (!descriptor) {
      return undefined;
    }
    return this.diagnostics.get(descriptor.extensionId);
  }

  async activate(id: string): Promise<RegisteredProvider> {
    const normalized = normalizeProviderId(id);
    const registered = this.registry.get(normalized);
    if (registered) {
      return registered;
    }

    const pending = this.activations.get(normalized);
    if (pending !== undefined) {
      return pending;
    }

    const descriptor = this.descriptors.get(normalized);
    if (!descriptor) {
      throw new RemotishError(
        'UNSUPPORTED',
        `Remotish provider ${normalized} is not installed or enabled.`,
      );
    }
    if (descriptor.apiVersion !== REMOTISH_ADAPTER_PROVIDER_API_VERSION) {
      throw new RemotishError(
        'UNSUPPORTED',
        `Provider ${normalized} uses unsupported API version ${String(descriptor.apiVersion)}.`,
      );
    }

    const activation = this.activateDescriptor(descriptor);
    this.activations.set(normalized, activation);
    try {
      return await activation;
    } finally {
      if (this.activations.get(normalized) === activation) {
        this.activations.delete(normalized);
      }
    }
  }

  private async activateDescriptor(descriptor: ProviderDescriptor): Promise<RegisteredProvider> {
    let exported: unknown;
    try {
      exported = await descriptor.extension.activate();
    } catch (error) {
      throw new RemotishError(
        'UNKNOWN',
        `Provider extension ${descriptor.extensionId} failed to activate.`,
        { cause: error },
      );
    }

    const provider = validateProviderExport(exported, descriptor);
    this.registry.register(provider, descriptor.extensionId);
    return this.registry.require(provider.id);
  }
}

function readManifestObject(
  extension: vscode.Extension<unknown>,
): Record<string, unknown> | undefined {
  const raw = (extension.packageJSON as Record<string, unknown> | undefined)?.remotish;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const marker = raw as Record<string, unknown>;
  return marker.provider === true ? marker : undefined;
}

function validateProviderExport(
  value: unknown,
  descriptor: ProviderDescriptor,
): RemotishAdapterProviderV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw malformed(descriptor, 'activation result must be an object');
  }
  const provider = value as Partial<RemotishAdapterProviderV1>;
  if (provider.apiVersion !== REMOTISH_ADAPTER_PROVIDER_API_VERSION) {
    throw malformed(descriptor, 'activation result has an unsupported apiVersion');
  }
  if (typeof provider.id !== 'string' || normalizeProviderId(provider.id) !== descriptor.id) {
    throw malformed(descriptor, `activation result must identify provider ${descriptor.id}`);
  }
  if (typeof provider.displayName !== 'string' || !provider.displayName.trim()) {
    throw malformed(descriptor, 'activation result requires displayName');
  }
  if (typeof provider.validateRepository !== 'function') {
    throw malformed(descriptor, 'activation result requires validateRepository()');
  }
  if (typeof provider.createAdapter !== 'function') {
    throw malformed(descriptor, 'activation result requires createAdapter()');
  }
  if (provider.restoreWorkspace !== undefined && typeof provider.restoreWorkspace !== 'function') {
    throw malformed(descriptor, 'restoreWorkspace must be a function');
  }
  return provider as RemotishAdapterProviderV1;
}

function malformed(descriptor: ProviderDescriptor, detail: string): RemotishError {
  return new RemotishError(
    'INVALID_REQUEST',
    `Provider extension ${descriptor.extensionId} is malformed: ${detail}.`,
  );
}
