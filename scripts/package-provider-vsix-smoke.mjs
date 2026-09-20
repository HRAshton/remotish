import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createVSIX } from '@vscode/vsce';

const fixtureRoot = resolve('tests/fixtures/provider-extension');
const output = resolve(process.argv[2] ?? 'artifacts/remotish-fixture-provider.vsix');

await mkdir(resolve('artifacts'), { recursive: true });
await createVSIX({
  cwd: fixtureRoot,
  packagePath: output,
  dependencies: false,
  allowMissingRepository: true,
});

console.log(`Packaged fixture provider VSIX at ${output}.`);
