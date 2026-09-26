import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

const hostVsix = resolve(process.argv[2] ?? 'artifacts/remotish.vsix');
const providerVsixes = (
  process.argv.length > 3
    ? process.argv.slice(3)
    : [
        'artifacts/remotish-fixture-provider.vsix',
        'artifacts/remotish-browser-rpc-provider.vsix',
        'artifacts/remotish-git-http-provider.vsix',
      ]
).map(resolve);
const smokeRoot = resolve('artifacts/vsix-smoke');
const extensionRoot = resolve(smokeRoot, 'extension');
const providersRoot = resolve(smokeRoot, 'providers');
const testBundle = resolve('apps/demo-web/dist/test/suite/vsix.js');
const bootstrapTestBundle = resolve('apps/demo-web/dist/test/suite/bootstrap.js');

function extractVsix(archive, destination) {
  const windows = process.platform === 'win32';
  execFileSync(
    windows ? 'tar' : 'unzip',
    windows ? ['-xf', archive, '-C', destination] : ['-q', archive, '-d', destination],
    { stdio: 'inherit' },
  );
}

function unpackProviderVsix(vsix, destination) {
  const archiveRoot = resolve(smokeRoot, `.unpack-${basename(vsix, '.vsix')}`);
  mkdirSync(archiveRoot, { recursive: true });
  extractVsix(vsix, archiveRoot);
  cpSync(resolve(archiveRoot, 'extension'), destination, { recursive: true });
  rmSync(archiveRoot, { recursive: true, force: true });
}

rmSync(smokeRoot, { recursive: true, force: true });
mkdirSync(smokeRoot, { recursive: true });
extractVsix(hostVsix, smokeRoot);
mkdirSync(dirname(resolve(extensionRoot, 'dist/test/suite/vsix.js')), { recursive: true });
cpSync(testBundle, resolve(extensionRoot, 'dist/test/suite/vsix.js'));
cpSync(bootstrapTestBundle, resolve(extensionRoot, 'dist/test/suite/bootstrap.js'));

mkdirSync(providersRoot, { recursive: true });
for (const providerVsix of providerVsixes) {
  unpackProviderVsix(providerVsix, resolve(providersRoot, basename(providerVsix, '.vsix')));
}

console.log(`Prepared packaged host extension at ${extensionRoot}.`);
console.log(`Prepared ${providerVsixes.length} packaged provider extensions at ${providersRoot}.`);
