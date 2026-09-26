import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const [entryArg, metadataArg, outputArg] = process.argv.slice(2);
if (!entryArg || !metadataArg || !outputArg) {
  throw new Error(
    'Usage: node scripts/build-git-http-userscript.mjs <entry.ts> <metadata.txt> <output.user.js>',
  );
}
const metadata = await readFile(resolve(metadataArg), 'utf8');
const entry = await readFile(resolve(entryArg), 'utf8');
const headerEnd = metadata.indexOf('// ==/UserScript==');
const header = headerEnd < 0 ? '' : metadata.slice(0, headerEnd);
const matches = [...header.matchAll(/^\/\/ @match\s+(\S+)\s*$/gmu)].map((match) => match[1]);
const grants = new Set(
  [...header.matchAll(/^\/\/ @grant\s+(\S+)\s*$/gmu)].map((match) => match[1]),
);
const connects = [...header.matchAll(/^\/\/ @connect\s+(\S+)\s*$/gmu)].map((match) => match[1]);
const sandboxes = header.match(/^\/\/\s*@sandbox\b.*$/gmu) ?? [];
const exactHttpsOrigin = (match) => {
  if (!/^https:\/\/[^/*@?#]+\/\*$/u.test(match)) {
    return false;
  }
  const origin = match.slice(0, -2);
  if (origin.includes('.invalid')) {
    return false;
  }
  try {
    return new URL(origin).origin === origin;
  } catch {
    return false;
  }
};
if (
  !/^\/\/ ==UserScript==\r?\n/u.test(metadata) ||
  headerEnd < 0 ||
  matches.length !== 1 ||
  !exactHttpsOrigin(matches[0]) ||
  sandboxes.length !== 1 ||
  !/^\/\/ @sandbox\s+DOM\s*$/u.test(sandboxes[0]) ||
  ['GM_info', 'GM_getValue', 'GM_setValue', 'GM_registerMenuCommand', 'GM_xmlhttpRequest'].some(
    (grant) => !grants.has(grant),
  ) ||
  connects.length !== 2 ||
  new Set(connects).size !== 2 ||
  connects.some((host) => !/^[a-z0-9.-]+$/u.test(host) || host.includes('.invalid')) ||
  !connects.includes(new URL(matches[0].slice(0, -2)).hostname) ||
  entry.includes('REPLACE_WITH_YOUR_OWN_43_CHARACTER_BASE64URL_KEY') ||
  entry.includes('.invalid')
) {
  throw new Error(
    'Configure exact origins, @sandbox DOM, pairing key, Git @connect host, and GM grants before building.',
  );
}
await build({
  entryPoints: [resolve(entryArg)],
  outfile: resolve(outputArg),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  banner: { js: metadata },
});
