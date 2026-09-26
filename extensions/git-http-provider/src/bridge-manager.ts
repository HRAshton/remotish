import { GitHttpNotDispatchedError } from '@remotish/adapter-git-http';
import type * as vscode from 'vscode';
import { PAIRING_SECRET, readSettings } from './repository-config.js';
import { GitHttpWebBridge } from './web-bridge.js';

/** Owns Web bridge lifecycle and credential-generation invalidation. */
export class GitHttpBridgeManager implements vscode.Disposable {
  private bridge: GitHttpWebBridge | undefined;
  private bridgePairing: string | undefined;
  private bridgeUrl: string | undefined;
  private connecting: Promise<GitHttpWebBridge> | undefined;
  private generation = 0;

  constructor(private readonly context: vscode.ExtensionContext) {}

  async get(url: string): Promise<GitHttpWebBridge> {
    this.requireConfiguredUrl(url);
    const startingGeneration = this.generation;
    const pairing = await this.context.secrets.get(PAIRING_SECRET);
    if (!pairing) {
      throw new GitHttpNotDispatchedError(
        'UNAUTHORIZED',
        'Configure the Git HTTP bridge pairing key.',
      );
    }
    if (this.generation !== startingGeneration) {
      throw new GitHttpNotDispatchedError('FORBIDDEN', 'Git repository configuration changed.');
    }
    this.requireConfiguredUrl(url);
    this.invalidateChangedBridge(pairing, url);
    if (this.bridge) {
      return this.bridge;
    }
    return this.connect(pairing, url);
  }

  invalidate(): void {
    this.bridge?.dispose();
    this.bridge = undefined;
    this.bridgePairing = undefined;
    this.bridgeUrl = undefined;
    this.connecting = undefined;
    this.generation += 1;
  }

  dispose(): void {
    this.invalidate();
  }

  private async connect(pairing: string, url: string): Promise<GitHttpWebBridge> {
    const currentGeneration = this.generation;
    const pending = this.connecting ?? GitHttpWebBridge.connect(pairing, url);
    this.connecting = pending;
    let candidate: GitHttpWebBridge;
    try {
      candidate = await pending;
    } catch (error) {
      throw new GitHttpNotDispatchedError('OFFLINE', 'Git HTTP userscript is unavailable.', {
        cause: error,
      });
    } finally {
      if (this.connecting === pending) {
        this.connecting = undefined;
      }
    }
    if (this.generation !== currentGeneration) {
      candidate.dispose();
      throw new GitHttpNotDispatchedError('FORBIDDEN', 'Git repository configuration changed.');
    }
    try {
      this.requireConfiguredUrl(url);
    } catch (error) {
      candidate.dispose();
      throw error;
    }
    this.bridge = candidate;
    this.bridgePairing = pairing;
    this.bridgeUrl = url;
    return candidate;
  }

  private invalidateChangedBridge(pairing: string, url: string): void {
    if (this.bridge && (this.bridgePairing !== pairing || this.bridgeUrl !== url)) {
      this.invalidate();
    }
  }

  private requireConfiguredUrl(url: string): void {
    if (readSettings().url !== url) {
      throw new GitHttpNotDispatchedError('FORBIDDEN', 'Git repository configuration changed.');
    }
  }
}
