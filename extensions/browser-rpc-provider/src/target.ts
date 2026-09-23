import { RemotishError } from '@remotish/adapter-sdk';

/** Canonical, credential-free HTTPS target; HTTP is limited to loopback development. */
export function normalizeBrowserRpcTarget(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.includes('\\') ||
    value.includes('?') ||
    value.includes('#') ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 32 || code === 127;
    })
  ) {
    throw invalidTarget();
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidTarget();
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    (url.protocol === 'http:' && !isLoopback(url.hostname)) ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    !url.hostname
  ) {
    throw invalidTarget();
  }
  return url.href;
}

/** Only the target field may cross into a repository descriptor. */
export function decodeBrowserRpcRepository(repository: unknown): string {
  if (!repository || typeof repository !== 'object' || Array.isArray(repository)) {
    throw new RemotishError('INVALID_REQUEST', 'Browser RPC repository requires target only.');
  }
  const keys = Object.keys(repository);
  if (keys.length !== 1 || keys[0] !== 'target') {
    throw new RemotishError('INVALID_REQUEST', 'Browser RPC repository requires target only.');
  }
  const target = Object.getOwnPropertyDescriptor(repository, 'target');
  if (!target || !('value' in target)) {
    throw new RemotishError('INVALID_REQUEST', 'Browser RPC repository requires target only.');
  }
  return normalizeBrowserRpcTarget(target.value);
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function invalidTarget(): RemotishError {
  return new RemotishError('INVALID_REQUEST', 'Invalid Browser RPC target URL.');
}
