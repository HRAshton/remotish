import * as vscode from 'vscode';
import { run as runWebSmoke } from '../suite/index.js';

export async function run(): Promise<void> {
  const host = vscode.extensions.getExtension('hrashton.remotish-stable-smoke');
  if (!host) {
    throw new Error('Proposal-free Remotish smoke host was not loaded into Code-OSS Web.');
  }
  if ((host.packageJSON as Record<string, unknown>).enabledApiProposals !== undefined) {
    throw new Error('Proposal-free Remotish smoke host unexpectedly enables proposed APIs.');
  }

  await runWebSmoke();

  if (!host.isActive) {
    throw new Error('Proposal-free Remotish smoke host did not activate for framework commands.');
  }
}
