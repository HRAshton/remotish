import { RemotishError } from '@remotish/adapter-sdk';
import { parseRepositoryUri, type RepositoryUriLike } from '../filesystem/uri.js';

/** Identifies one working-tree resource passed to a Remotish SCM command by VS Code. */
export interface ScmResourceArgument {
  readonly workspaceId: string;
  readonly path: string;
}

/**
 * Extracts a working-tree resource from the argument shapes VS Code uses for SCM rows and groups.
 * Returns `undefined` for unrelated commands, immutable revision URIs, and malformed values.
 */
export function parseScmResourceArgument(value: unknown): ScmResourceArgument | undefined {
  const uri = findResourceUri(value);
  if (!uri) {
    return undefined;
  }

  try {
    const resource = parseRepositoryUri(uri);
    if (resource.view !== 'working') {
      return undefined;
    }
    return { workspaceId: resource.workspaceId, path: resource.path };
  } catch {
    return undefined;
  }
}

/**
 * Resolves either the explicit `(workspaceId, path)` command form or a VS Code SCM resource value.
 * Throws a user-facing error when the command was invoked without a working-tree resource.
 */
export function requireScmResourceArgument(
  value: unknown,
  explicitPath?: string,
): ScmResourceArgument {
  if (typeof value === 'string' && explicitPath !== undefined) {
    return { workspaceId: value, path: explicitPath };
  }

  const resource = parseScmResourceArgument(value);
  if (!resource) {
    throw new RemotishError('INVALID_REQUEST', 'Select a Remotish working-tree change first.');
  }
  return resource;
}

/** Resolves the workspace identifier carried by either an SCM group or an SCM resource argument. */
export function requireScmWorkspaceId(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  const workspaceId = parseScmResourceArgument(value)?.workspaceId;
  if (!workspaceId) {
    throw new RemotishError('INVALID_REQUEST', 'Select a Remotish source-control group first.');
  }
  return workspaceId;
}

function findResourceUri(value: unknown): RepositoryUriLike | undefined {
  if (isUriLike(value)) {
    return value;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  if (isUriLike(value.resourceUri)) {
    return value.resourceUri;
  }
  if (Array.isArray(value.resourceStates)) {
    for (const state of value.resourceStates) {
      const uri = findResourceUri(state);
      if (uri) {
        return uri;
      }
    }
  }
  return undefined;
}

function isUriLike(value: unknown): value is RepositoryUriLike {
  return (
    isRecord(value) &&
    typeof value.scheme === 'string' &&
    typeof value.authority === 'string' &&
    typeof value.path === 'string' &&
    typeof value.query === 'string'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
