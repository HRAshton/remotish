import * as vscode from 'vscode';
import { run as runWebSmoke } from './index.js';

const EXPECTED_PROPOSALS = ['scmHistoryProvider', 'timeline'];

export async function run(): Promise<void> {
  const host = vscode.extensions.getExtension('hrashton.remotish');
  if (!host) {
    throw new Error('Controlled-host Remotish VSIX was not loaded into Code-OSS Web.');
  }

  const manifest = host.packageJSON as Record<string, unknown>;
  const proposals = manifest.enabledApiProposals;
  if (
    !Array.isArray(proposals) ||
    proposals.length !== EXPECTED_PROPOSALS.length ||
    !EXPECTED_PROPOSALS.every((proposal, index) => proposals[index] === proposal)
  ) {
    throw new Error('Controlled-host Remotish VSIX has an unexpected proposed-API declaration.');
  }

  const dependencies = manifest.dependencies as Record<string, unknown> | undefined;
  if (dependencies?.['@remotish/vscode-history'] !== 'workspace:*') {
    throw new Error('Controlled-host Remotish VSIX does not retain the history integration.');
  }

  await host.activate();
  if (!host.isActive) {
    throw new Error('Controlled-host Remotish VSIX did not activate.');
  }

  const prepared = await runWebSmoke();
  if (!prepared.uri.startsWith('remotish://fixture-provider-')) {
    throw new Error('Controlled-host Remotish VSIX did not prepare the deterministic fixture.');
  }
}
