import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const [entryArg, metadataArg, outputArg] = process.argv.slice(2);
if (!entryArg || !metadataArg || !outputArg) {
  throw new Error(
    'Usage: node scripts/build-browser-rpc-userscript.mjs <entry.ts> <metadata.txt> <output.user.js>',
  );
}
const metadata = await readFile(resolve(metadataArg), 'utf8');
const entry = await readFile(resolve(entryArg), 'utf8');
const matches = [...metadata.matchAll(/^\/\/ @match\s+(\S+)\s*$/gmu)].map((match) => match[1]);
const grants = new Set(
  [...metadata.matchAll(/^\/\/ @grant\s+(\S+)\s*$/gmu)].map((match) => match[1]),
);
const scopedMatch = (match) => {
  const origin = /^https:\/\/[^/*@?#]+\/\*$/u.test(match)
    ? match.slice(0, -2)
    : /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])\/\*$/u.test(match)
      ? match.slice(0, -2)
      : undefined;
  if (!origin || origin.includes('.invalid')) {
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
  !metadata.includes('// ==/UserScript==') ||
  matches.length < 2 ||
  matches.some((match) => !scopedMatch(match)) ||
  [
    'GM_getValue',
    'GM_setValue',
    'GM_deleteValue',
    'GM_listValues',
    'GM_addValueChangeListener',
    'GM_removeValueChangeListener',
  ].some((grant) => !grants.has(grant)) ||
  entry.includes('REPLACE_WITH_YOUR_OWN_43_CHARACTER_BASE64URL_KEY') ||
  entry.includes('.invalid')
) {
  throw new Error('Configure exact origins, pairing key, and all GM grants before building.');
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
