import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const vsixPath = resolve(process.argv[2] ?? 'artifacts/remotish-demo.vsix');
const smokeRoot = resolve('artifacts/vsix-smoke');
const extensionRoot = resolve(smokeRoot, 'extension');
const testBundle = resolve('apps/demo-web/dist/test/suite/index.js');
const packagedTestBundle = resolve(extensionRoot, 'dist/test/suite/index.js');

rmSync(smokeRoot, { recursive: true, force: true });
mkdirSync(smokeRoot, { recursive: true });
execFileSync('unzip', ['-q', vsixPath, '-d', smokeRoot], { stdio: 'inherit' });
mkdirSync(dirname(packagedTestBundle), { recursive: true });
cpSync(testBundle, packagedTestBundle);

console.log(`Prepared packaged-extension smoke tree at ${extensionRoot}.`);
