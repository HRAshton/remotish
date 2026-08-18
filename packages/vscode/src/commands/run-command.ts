import { RemotishError } from '@remotish/adapter-sdk';
import * as vscode from 'vscode';

/** Minimal structured logger used at VS Code command boundaries. */
export interface CommandLogger {
  error(message: string, error: unknown): void;
}

/** Runs a VS Code command boundary with consistent Remotish error presentation. */
export async function runCommand(
  logger: CommandLogger,
  action: () => Promise<void>,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (error instanceof RemotishError) {
      if (error.code === 'CANCELLED') {
        return;
      }

      void vscode.window.showErrorMessage(messageForRemotishError(error));
      if (error.code === 'UNKNOWN') {
        logger.error('Remotish command failed.', error);
      }
      return;
    }

    logger.error('Unexpected Remotish command failure.', error);
    const detail = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`Remotish operation failed: ${detail}`);
  }
}

function messageForRemotishError(error: RemotishError): string {
  switch (error.code) {
    case 'INVALID_REQUEST':
      return error.message;
    case 'UNAUTHORIZED':
      return `Authentication required: ${error.message}`;
    case 'FORBIDDEN':
      return `Permission denied: ${error.message}`;
    case 'RATE_LIMITED':
      return `Remote service rate limit reached: ${error.message}`;
    case 'OFFLINE':
      return `Remote service is unavailable: ${error.message}`;
    case 'NOT_FOUND':
      return `Remote resource was not found: ${error.message}`;
    case 'UNSUPPORTED':
      return `Operation is not supported: ${error.message}`;
    case 'UNKNOWN':
      return `Remotish operation failed: ${error.message}`;
    case 'CANCELLED':
      return error.message;
  }
  return error.message;
}
