import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const wrapperStatement = 'export const Button = (props) => <SourceButton {...props} />;';
const decoyFile = 'packages/app/src/a/Decoy.tsx';
const decoyText = [
  "import { Button as SourceButton } from '@otherx/a';",
  `export const Unrelated = () => <span />; ${wrapperStatement}`,
  '',
].join('\n');

export async function createWrapperInvestigationFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhubase-wrapper-investigations-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (relative, content) => {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
    return file;
  };

  await write('package.json', JSON.stringify({
    name: 'wrapper-investigation-fixture', private: true, workspaces: ['packages/*'], packageManager: 'npm@10.9.0',
  }, null, 2));
  await write('package-lock.json', JSON.stringify({
    name: 'wrapper-investigation-fixture', lockfileVersion: 3, requires: true,
    packages: {
      '': { name: 'wrapper-investigation-fixture', workspaces: ['packages/*'] },
      'packages/app': { name: '@fixture/app', version: '1.0.0', dependencies: { '@legacy/a': '1.0.0', '@legacy/b': '1.0.0', '@target/ui': '1.0.0' } },
      'packages/legacy-a': { name: '@legacy/a', version: '1.0.0' },
      'packages/legacy-b': { name: '@legacy/b', version: '1.0.0' },
      'packages/target': { name: '@target/ui', version: '1.0.0' },
    },
  }, null, 2));
  await write('CODEOWNERS', '/packages/app/src/** @design-systems\n');

  for (const [directory, name, declaration] of [
    ['legacy-a', '@legacy/a', "export declare function Button(props: { tone?: 'quiet' | 'loud' }): unknown;\n"],
    ['legacy-b', '@legacy/b', 'export declare function Button(props: { selected?: boolean }): unknown;\n'],
  ]) {
    await write(`packages/${directory}/package.json`, JSON.stringify({ name, version: '1.0.0', types: 'index.d.ts' }, null, 2));
    await write(`packages/${directory}/index.d.ts`, declaration);
  }
  await write('packages/target/package.json', JSON.stringify({ name: '@target/ui', version: '1.0.0', types: 'index.d.ts' }, null, 2));
  await write('packages/target/index.d.ts', 'export declare function Action(props: {}): unknown;\n');
  await write('packages/target/MIGRATION.md', '# Migration\nReview each source Button before using `Action`.\n');
  await write('packages/app/package.json', JSON.stringify({
    name: '@fixture/app', version: '1.0.0', private: true,
    dependencies: { '@legacy/a': '1.0.0', '@legacy/b': '1.0.0', '@target/ui': '1.0.0' },
  }, null, 2));

  await write('packages/app/src/a/Button.tsx', [
    "import { Button as SourceButton } from '@legacy/a';",
    `export const Unrelated = () => <span />; ${wrapperStatement}`,
    'export const sameFileA = <Button tone="quiet" />;',
    '',
  ].join('\n'));
  await write(decoyFile, decoyText);
  await write('packages/app/src/b/Button.tsx', [
    "import { Button as SourceButton } from '@legacy/b';",
    'export const Button = (props) => (<SourceButton {...props} />);',
    'export const sameFileB = <Button selected />;',
    '',
  ].join('\n'));
  await write('packages/app/src/a/index.ts', "export { Button as PublicButton } from './Button';\n");
  await write('packages/app/src/b/index.ts', "export { Button as PublicButton } from './Button';\n");
  await write('packages/app/src/DirectSources.tsx', [
    "import { Button as A } from '@legacy/a';",
    "import { Button as B } from '@legacy/b';",
    'export const directA = <A tone="loud" />;',
    'export const directB = <B selected={false} />;',
    '',
  ].join('\n'));
  await write('packages/app/src/DirectWrappers.tsx', [
    "import { Button as AButton } from './a/Button';",
    "import { Button as BButton } from './b/Button';",
    'export const aOne = <AButton tone="quiet" />;',
    'export const aTwo = <AButton tone="loud" />;',
    'export const bOne = <BButton selected />;',
    'export const bTwo = <BButton selected={false} />;',
    '',
  ].join('\n'));
  await write('packages/app/src/Aliases.tsx', [
    "import { Button as Alpha } from './a/Button';",
    "import { Button as Beta } from './b/Button';",
    'export const aliasA = <Alpha />;',
    'export const aliasB = <Beta />;',
    '',
  ].join('\n'));
  await write('packages/app/src/Barrels.tsx', [
    "import { PublicButton as AButton } from './a';",
    "import { PublicButton as BButton } from './b';",
    'export const barrelAOne = <AButton />;',
    'export const barrelATwo = <AButton tone="quiet" />;',
    'export const barrelBOne = <BButton />;',
    'export const barrelBTwo = <BButton selected />;',
    '',
  ].join('\n'));

  return {
    root,
    definitions: ['packages/app/src/a/Button.tsx', 'packages/app/src/b/Button.tsx'],
    decoy: { file: decoyFile, quote: wrapperStatement, sha256: createHash('sha256').update(decoyText).digest('hex'), line: 2 },
    expected: { packets: 2, recognizedUsages: 4, wrapperCalls: 12 },
  };
}

export async function wrapperFixtureDigest(root) {
  const entries = [];
  async function visit(directory, prefix = '') {
    for (const name of (await fs.readdir(directory)).sort()) {
      const file = path.join(directory, name); const relative = prefix + name; const stat = await fs.lstat(file);
      if (stat.isDirectory()) await visit(file, relative + '/');
      else entries.push([relative, stat.mode & 0o777, createHash('sha256').update(await fs.readFile(file)).digest('hex')]);
    }
  }
  await visit(root);
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}
