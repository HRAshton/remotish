import type { CommitInfo, RevisionId } from '@remotish/adapter-sdk';
import { cloneFiles } from './files.js';
import type { FixtureRepository, StoredCommit } from './model.js';

const encoder = new TextEncoder();

/** Creates the canonical deterministic commit graph used by framework and adapter tests. */
export function createFixtureRepository(): FixtureRepository {
  const commits = new Map<RevisionId, StoredCommit>();

  const c1Files = new Map<string, Uint8Array>([
    ['README.md', encoder.encode('# Fixture repository\n')],
    ['src/index.ts', encoder.encode("export const greeting = 'hello';\n")],
    ['assets/sample.bin', new Uint8Array([0, 1, 2, 127, 128, 255])],
  ]);
  const c1 = seedCommit('C1', [], 'Initial commit', c1Files);
  commits.set(c1.info.revision, c1);

  const c2Files = cloneFiles(c1Files);
  c2Files.set('package.json', encoder.encode('{"name":"fixture"}\n'));
  const c2 = seedCommit('C2', ['C1'], 'Add package metadata', c2Files);
  commits.set(c2.info.revision, c2);

  const c3Files = cloneFiles(c2Files);
  c3Files.set('README.md', encoder.encode('# Fixture repository\n\nMain branch.\n'));
  c3Files.set(
    'src/util.ts',
    encoder.encode('export const twice = (value: number) => value * 2;\n'),
  );
  const c3 = seedCommit('C3', ['C2'], 'Update README and add utility', c3Files);
  commits.set(c3.info.revision, c3);

  const f1Files = cloneFiles(c2Files);
  f1Files.set('src/index.ts', encoder.encode("export const greeting = 'feature';\n"));
  const f1 = seedCommit('F1', ['C2'], 'Start feature', f1Files);
  commits.set(f1.info.revision, f1);

  const f2Files = cloneFiles(f1Files);
  f2Files.set('src/feature.ts', encoder.encode('export const enabled = true;\n'));
  const f2 = seedCommit('F2', ['F1'], 'Finish feature', f2Files);
  commits.set(f2.info.revision, f2);

  return {
    info: {
      id: 'fixture/demo',
      name: 'Fixture Demo',
      description: 'Deterministic repository used by Remotish tests.',
      defaultBranch: 'main',
    },
    commits,
    branches: new Map([
      ['main', 'C3'],
      ['feature/test', 'F2'],
    ]),
  };
}

function seedCommit(
  revision: RevisionId,
  parents: readonly RevisionId[],
  message: string,
  files: Map<string, Uint8Array>,
): StoredCommit {
  const info: CommitInfo = {
    revision,
    parents: [...parents],
    message,
    author: { name: 'Fixture User', email: 'fixture@example.invalid' },
    authoredAt: `2026-01-${String(revision.length + parents.length + 1).padStart(2, '0')}T00:00:00.000Z`,
  };
  return { info, files };
}
