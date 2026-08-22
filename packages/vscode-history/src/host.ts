import { type RemotishVsCodeHost, WORKING_SCHEME } from '@remotish/vscode';
import * as vscode from 'vscode';
import { HistoryManager } from './manager.js';
import { RemotishTimelineProvider } from './timeline-provider.js';

/** Owns native SCM history and Timeline integrations for a Remotish VS Code host. */
export class RemotishHistoryHost implements vscode.Disposable {
  private readonly manager: HistoryManager;
  private readonly timelineProvider: RemotishTimelineProvider;
  private readonly timelineRegistration: vscode.Disposable;

  constructor(host: RemotishVsCodeHost) {
    this.manager = new HistoryManager(host.registry, host.scm);
    this.timelineProvider = new RemotishTimelineProvider(host.registry);
    this.timelineRegistration = vscode.workspace.registerTimelineProvider(
      WORKING_SCHEME,
      this.timelineProvider,
    );
  }

  dispose(): void {
    this.timelineRegistration.dispose();
    this.timelineProvider.dispose();
    this.manager.dispose();
  }
}
