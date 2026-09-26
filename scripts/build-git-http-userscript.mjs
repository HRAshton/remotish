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
const literal = (name) => {
  const values = [...entry.matchAll(new RegExp(`^const ${name} = '([^'\r\n]*)';$`, 'gmu'))];
  if (values.length !== 1 || !values[0][1]) {
    throw new Error(`Configure ${name} as one string literal.`);
  }
  return values[0][1];
};
const codeOrigin = literal('codeOrigin');
const gitUrl = literal('gitUrl');
const redirectProbeUrl = literal('redirectProbeUrl');
const pairingKey = literal('pairingKey');
const code = new URL(codeOrigin);
const git = new URL(gitUrl);
const probe = new URL(redirectProbeUrl);
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
  code.protocol !== 'https:' ||
  code.href !== `${code.origin}/` ||
  git.protocol !== 'https:' ||
  git.username ||
  git.password ||
  git.search ||
  git.hash ||
  !git.pathname.endsWith('.git') ||
  probe.origin !== code.origin ||
  probe.href === code.href ||
  probe.username ||
  probe.password ||
  probe.hash ||
  !/^[A-Za-z0-9_-]{43}$/u.test(pairingKey) ||
  matches[0] !== `${code.origin}/*` ||
  sandboxes.length !== 1 ||
  !/^\/\/ @sandbox\s+DOM\s*$/u.test(sandboxes[0]) ||
  ['GM_info', 'GM_getValue', 'GM_setValue', 'GM_registerMenuCommand', 'GM_xmlhttpRequest'].some(
    (grant) => !grants.has(grant),
  ) ||
  connects.length !== 2 ||
  new Set(connects).size !== 2 ||
  connects.some((host) => !/^[a-z0-9.-]+$/u.test(host) || host.includes('.invalid')) ||
  !connects.includes(code.hostname) ||
  !connects.includes(git.hostname) ||
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
