import type { Disposable as CoreDisposable } from '@remotish/core';
import {
  createRevisionUri,
  parseRepositoryUri,
  type WorkspaceRegistry,
} from '@remotish/vscode/model';
import * as vscode from 'vscode';
import type { FileTimelineEntry } from './timeline-query-service.js';
import { FileTimelineQueryService } from './timeline-query-service.js';

const DEFAULT_LIMIT = 50;

export class RemotishTimelineProvider implements vscode.TimelineProvider, vscode.Disposable {
  readonly id = 'remotish';
  readonly label = 'Remotish';

  private readonly changed = new vscode.EventEmitter<vscode.TimelineChangeEvent | undefined>();
  private readonly registrySubscription: CoreDisposable;
  private readonly workspaceSubscription: CoreDisposable;

  readonly onDidChange = this.changed.event;

  constructor(private readonly registry: WorkspaceRegistry) {
    this.registrySubscription = registry.onDidChange(() => this.changed.fire(undefined));
    this.workspaceSubscription = registry.onDidWorkspaceChange(() => this.changed.fire(undefined));
  }

  async provideTimeline(
    uri: vscode.Uri,
    options: vscode.TimelineOptions,
    token: vscode.CancellationToken,
  ): Promise<vscode.Timeline> {
    const resource = parseRepositoryUri(uri);
    if (resource.view !== 'working' || !resource.path) {
      return { items: [] };
    }

    const registration = this.registry.get(resource.workspaceId);
    if (!registration) {
      return { items: [] };
    }

    const query = new FileTimelineQueryService(registration.workspace);
    const limit =
      typeof options.limit === 'number' ? Math.max(1, Math.trunc(options.limit)) : DEFAULT_LIMIT;
    const minimumTimestamp =
      typeof options.limit === 'object' ? options.limit.timestamp : undefined;
    const page = await query.load(resource.path, options.cursor, limit, minimumTimestamp, token);

    return {
      items: page.entries.map((entry) => toTimelineItem(resource.workspaceId, entry)),
      ...(page.nextCursor ? { paging: { cursor: page.nextCursor } } : {}),
    };
  }

  dispose(): void {
    this.registrySubscription.dispose();
    this.workspaceSubscription.dispose();
    this.changed.dispose();
  }
}

function toTimelineItem(workspaceId: string, entry: FileTimelineEntry): vscode.TimelineItem {
  const { commit, change, timestamp } = entry;
  const subject = commit.message.split(/\r?\n/, 1)[0] || commit.revision;
  const item = new vscode.TimelineItem(subject, timestamp);
  const parent = commit.parents[0];
  const originalPath = change.type === 'renamed' ? change.previousPath : change.path;
  const originalUri =
    parent && change.type !== 'added' && originalPath
      ? createRevisionUri(workspaceId, parent, originalPath)
      : undefined;
  const modifiedUri =
    change.type === 'deleted'
      ? undefined
      : createRevisionUri(workspaceId, commit.revision, change.path);

  item.id = commit.revision;
  item.contextValue = 'remotish.commit';
  item.description = [commit.revision.slice(0, 12), commit.author?.name]
    .filter(Boolean)
    .join(' • ');
  item.tooltip = timelineTooltip(entry);

  const command = timelineCommand(subject, originalUri, modifiedUri);
  if (command) {
    item.command = command;
  }

  return item;
}

function timelineCommand(
  subject: string,
  originalUri: vscode.Uri | undefined,
  modifiedUri: vscode.Uri | undefined,
): vscode.Command | undefined {
  if (originalUri && modifiedUri) {
    return {
      command: 'vscode.diff',
      title: 'Open Commit Changes',
      arguments: [originalUri, modifiedUri, subject],
    };
  }

  const uri = modifiedUri ?? originalUri;
  return uri
    ? {
        command: 'vscode.open',
        title: 'Open Revision',
        arguments: [uri],
      }
    : undefined;
}

function timelineTooltip(entry: FileTimelineEntry): string {
  const author = entry.commit.author
    ? `\n${entry.commit.author.name}${entry.commit.author.email ? ` <${entry.commit.author.email}>` : ''}`
    : '';
  return `${entry.commit.message}${author}\n${entry.commit.revision}`;
}
