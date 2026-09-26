import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const [entryArg, metadataArg, outputArg] = process.argv.slice(2);
if (!entryArg || !metadataArg || !outputArg) {
  throw new Error(
    'Usage: node scripts/build-git-http-userscript.mjs <entry.ts> <metadata.txt> <output.user.js>',
  );
}
const entry = await readFile(resolve(entryArg), 'utf8');
const metadata = await readFile(resolve(metadataArg), 'utf8');
const literal = (name) => {
  const value = [...entry.matchAll(new RegExp(`^const ${name} = '([^']+)';$`, 'gmu'))][0]?.[1];
  if (!value) {
    throw new Error(`Configure ${name} as a string literal.`);
  }
  return value;
};
const code = new URL(literal('codeOrigin'));
const git = new URL(literal('gitUrl'));
const probe = new URL(literal('redirectProbeUrl'));
const key = literal('pairingKey');
const lines = metadata.split(/\r?\n/u);
const directives = (name) =>
  lines
    .filter((line) => line.startsWith(`// @${name} `))
    .map((line) => line.slice(`// @${name} `.length).trim());
const grants = new Set(directives('grant'));
const connects = new Set(directives('connect'));
if (
  !metadata.startsWith('// ==UserScript==\n') ||
  !metadata.includes('// ==/UserScript==') ||
  code.protocol !== 'https:' ||
  code.href !== `${code.origin}/` ||
  git.protocol !== 'https:' ||
  !git.pathname.endsWith('.git') ||
  git.username ||
  git.password ||
  git.search ||
  git.hash ||
  probe.origin !== code.origin ||
  probe.href === code.href ||
  !/^[A-Za-z0-9_-]{43}$/u.test(key) ||
  directives('sandbox').join(',') !== 'DOM' ||
  directives('match').join(',') !== `${code.origin}/*` ||
  connects.size !== 2 ||
  !connects.has(code.hostname) ||
  !connects.has(git.hostname) ||
  ['GM_info', 'GM_getValue', 'GM_setValue', 'GM_registerMenuCommand', 'GM_xmlhttpRequest'].some(
    (grant) => !grants.has(grant),
  ) ||
  entry.includes('.invalid') ||
  metadata.includes('.invalid')
) {
  throw new Error(
    'Configure exact Code-OSS and Git origins, redirect probe, pairing key, sandbox and GM grants.',
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
