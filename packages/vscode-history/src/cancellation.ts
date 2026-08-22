import type { RemoteRequestOptions } from '@remotish/adapter-sdk';
import type * as vscode from 'vscode';

export async function withCancellation<T>(
  token: vscode.CancellationToken,
  action: (options: RemoteRequestOptions) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  if (token.isCancellationRequested) {
    controller.abort();
  }
  const subscription = token.onCancellationRequested(() => controller.abort());
  try {
    return await action({ signal: controller.signal });
  } finally {
    subscription.dispose();
  }
}
