export interface RepositoryRoute {
  readonly serverBase: string;
  readonly projectKey: string;
  readonly slug: string;
  readonly target: string;
}

/** Derive one canonical repository route from a Data Center page URL. */
export function repositoryRoute(
  value: string,
  expectedOrigin: string,
): RepositoryRoute | undefined {
  let page: URL;
  let configuredOrigin: URL;
  try {
    page = new URL(value);
    configuredOrigin = new URL(expectedOrigin);
  } catch {
    return undefined;
  }
  if (
    page.username ||
    page.password ||
    !supportedProtocol(page) ||
    configuredOrigin.origin !== expectedOrigin ||
    configuredOrigin.username ||
    configuredOrigin.password ||
    !supportedProtocol(configuredOrigin) ||
    page.origin !== configuredOrigin.origin
  ) {
    return undefined;
  }
  const raw = page.pathname.split('/').filter(Boolean);
  const decoded: string[] = [];
  try {
    for (const part of raw) {
      const result = decodeURIComponent(part);
      if (!safeSegment(result)) {
        return undefined;
      }
      decoded.push(result);
    }
  } catch {
    return undefined;
  }
  const matches = findRepositoryMarkers(decoded);
  const match = matches[0];
  if (!match || matches.length !== 1) {
    return undefined;
  }

  const context = raw.slice(0, match.marker).join('/');
  const serverBase = `${page.origin}/${context ? `${context}/` : ''}`;
  const routeKind = match.personal ? 'users' : 'projects';
  const routeOwner = match.personal ? match.projectKey.slice(1) : match.projectKey;
  const target =
    `${serverBase}${routeKind}/${encodeURIComponent(routeOwner)}` +
    `/repos/${encodeURIComponent(match.slug)}`;
  return { serverBase, projectKey: match.projectKey, slug: match.slug, target };
}

function findRepositoryMarkers(decoded: readonly string[]): Array<{
  readonly marker: number;
  readonly projectKey: string;
  readonly slug: string;
  readonly personal: boolean;
}> {
  const matches = [];
  for (let index = 0; index + 3 < decoded.length; index += 1) {
    const kind = decoded[index]?.toLowerCase();
    const owner = decoded[index + 1];
    const slug = decoded[index + 3];
    if (
      (kind === 'projects' || kind === 'users') &&
      decoded[index + 2]?.toLowerCase() === 'repos' &&
      owner !== undefined &&
      slug !== undefined
    ) {
      matches.push({
        marker: index,
        projectKey: kind === 'users' ? `~${owner}` : owner,
        slug,
        personal: kind === 'users',
      });
    }
  }
  return matches;
}

function supportedProtocol(url: URL): boolean {
  return (
    url.protocol === 'https:' ||
    (url.protocol === 'http:' &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'))
  );
}

function safeSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 255 &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\') &&
    wellFormed(value) &&
    ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  );
}

function wellFormed(value: string): boolean {
  try {
    encodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
}
