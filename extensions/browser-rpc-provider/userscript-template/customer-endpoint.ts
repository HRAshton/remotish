import type { UserscriptEndpoint } from '../src/transport/userscript.js';

/** Replace this with a bundled, SCM-specific handler. Never obtain it from page globals. */
export function createEndpoint(): UserscriptEndpoint | undefined {
  return undefined;
}
