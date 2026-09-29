import * as vscode from 'vscode';
import type { RemotishProviderHost } from './providers/provider-host.js';

export const REMOTISH_EXPORT_DIAGNOSTICS_COMMAND = 'remotish.exportDiagnostics';

export interface RemotishProviderDiagnosticV1 {
  readonly id?: string;
  readonly displayName?: string;
  readonly extensionId: string;
  readonly extensionVersion?: string;
  readonly apiVersion?: number;
  readonly state: 'available' | 'unsupported' | 'malformed';
  readonly active: boolean;
}

export interface RemotishDiagnosticReportV1 {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly host: {
    readonly remotishVersion: string;
    readonly vscodeVersion: string;
    readonly appName: string;
    readonly appHost: string;
    readonly uiKind: 'desktop' | 'web' | 'unknown';
    readonly workspaceTrusted: boolean;
  };
  readonly providers: readonly RemotishProviderDiagnosticV1[];
  readonly workspaces: {
    readonly active: number;
    readonly pendingPreparations: number;
  };
  readonly storage: {
    readonly backend: 'storageUri';
    readonly available: boolean;
    readonly workspaceCount: number;
    readonly manifestCount: number;
    readonly blobCount: number;
    readonly totalBytes: number;
  };
}

/**
 * Collects a deliberately content-free support snapshot and exposes a local JSON export command.
 *
 * Repository descriptors, repository/workspace ids, branches, paths, file contents, commit
 * messages, credentials, URLs, headers and exception messages are intentionally not accepted by
 * this API.
 */
export class RemotishDiagnostics implements vscode.Disposable {
  private readonly command: vscode.Disposable;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly providers: RemotishProviderHost,
  ) {
    this.command = vscode.commands.registerCommand(REMOTISH_EXPORT_DIAGNOSTICS_COMMAND, () =>
      this.export(),
    );
  }

  async collect(): Promise<RemotishDiagnosticReportV1> {
    const host = this.providers.getDiagnostics();
    const extensionPackage = this.context.extension?.packageJSON as
      | Record<string, unknown>
      | undefined;

    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      host: {
        remotishVersion: stringValue(extensionPackage?.version, 'unknown'),
        vscodeVersion: stringValue(vscode.version, 'unknown'),
        appName: stringValue(vscode.env.appName, 'unknown'),
        appHost: stringValue(vscode.env.appHost, 'unknown'),
        uiKind:
          vscode.env.uiKind === vscode.UIKind.Web
            ? 'web'
            : vscode.env.uiKind === vscode.UIKind.Desktop
              ? 'desktop'
              : 'unknown',
        workspaceTrusted: vscode.workspace.isTrusted,
      },
      providers: this.providers.listProviders().map((provider) => {
        const extension = vscode.extensions.getExtension(provider.extensionId);
        const packageJson = extension?.packageJSON as Record<string, unknown> | undefined;
        return {
          ...(provider.id ? { id: provider.id } : {}),
          ...(provider.displayName ? { displayName: provider.displayName } : {}),
          extensionId: provider.extensionId,
          ...(typeof packageJson?.version === 'string'
            ? { extensionVersion: packageJson.version }
            : {}),
          ...(provider.apiVersion !== undefined ? { apiVersion: provider.apiVersion } : {}),
          state: provider.state,
          active: provider.id ? this.providers.providers.get(provider.id) !== undefined : false,
        };
      }),
      workspaces: {
        active: host.activeWorkspaceCount,
        pendingPreparations: host.pendingPreparationCount,
      },
      storage: await this.providers.getStorageDiagnostics(),
    };
  }

  async export(): Promise<void> {
    const target = await vscode.window.showSaveDialog({
      title: 'Export Remotish Diagnostics',
      saveLabel: 'Export',
      filters: { JSON: ['json'] },
    });
    if (!target) {
      return;
    }

    const report = await this.collect();
    const content = new TextEncoder().encode(`${JSON.stringify(report, null, 2)}\n`);
    await vscode.workspace.fs.writeFile(target, content);
    await vscode.window.showInformationMessage('Remotish diagnostics exported.');
  }

  dispose(): void {
    this.command.dispose();
  }
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}
