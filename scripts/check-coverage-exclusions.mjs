import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const config = JSON.parse(await readFile('.c8rc.json', 'utf8'));

for (const path of config.exclude ?? []) {
  if (!path.endsWith('.ts')) {
    continue;
  }

  const source = await readFile(path, 'utf8');

  const { outputText } = ts.transpileModule(source, {
    fileName: path,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      verbatimModuleSyntax: true,
      removeComments: true,
    },
  });

  const emitted = outputText.replace(/\s+/gu, '').replace(/^export\{\};?$/u, '');

  assert.equal(emitted, '', `${path} now emits runtime code; remove it from coverage exclusions.`);
}
