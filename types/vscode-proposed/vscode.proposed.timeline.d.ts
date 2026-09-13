/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

declare module 'vscode' {
  // https://github.com/microsoft/vscode/issues/84297

  export class TimelineItem {
    /** A timestamp (in milliseconds since 1 January 1970 00:00:00) for when the timeline item occurred. */
    timestamp: number;
    /** A human-readable string describing the timeline item. */
    label: string;
    /** Optional id for the timeline item. It must be unique across all the timeline items provided by this source. */
    id?: string;
    /** The icon path or ThemeIcon for the timeline item. */
    iconPath?: Uri | { light: Uri; dark: Uri } | ThemeIcon;
    /** A human readable string describing less prominent details of the timeline item. */
    description?: string;
    /** The tooltip text when you hover over the timeline item. */
    tooltip?: string | MarkdownString | undefined;
    /** The command that should be executed when the timeline item is selected. */
    command?: Command;
    /** Context value of the timeline item. */
    contextValue?: string;
    /** Accessibility information used when screen reader interacts with the timeline item. */
    accessibilityInformation?: AccessibilityInformation;
    constructor(label: string, timestamp: number);
  }

  export interface TimelineChangeEvent {
    /** The URI of the resource for which the timeline changed. */
    uri: Uri;
    /** A flag which indicates whether the entire timeline should be reset. */
    reset?: boolean;
  }

  export interface Timeline {
    readonly paging?: {
      /** Provider-defined cursor specifying the starting point after returned items. */
      readonly cursor: string | undefined;
    };
    readonly items: readonly TimelineItem[];
  }

  export interface TimelineOptions {
    cursor?: string;
    limit?: number | { timestamp: number; id?: string };
  }

  export interface TimelineProvider {
    readonly onDidChange?: Event<TimelineChangeEvent | undefined>;
    readonly id: string;
    readonly label: string;
    provideTimeline(
      uri: Uri,
      options: TimelineOptions,
      token: CancellationToken,
    ): ProviderResult<Timeline>;
  }

  export namespace workspace {
    export function registerTimelineProvider(
      scheme: string | string[],
      provider: TimelineProvider,
    ): Disposable;
  }
}
