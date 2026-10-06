import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const sentinelText = 'CTRL_SHIFT_SECRET_SENTINEL_DO_NOT_REPORT';

export async function createAssessmentFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shift-assessment-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const marker = path.join(root, 'EXECUTED-SENTINEL');
  const write = async (relative, content, mode) => {
    const file = path.join(root, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content, mode ? { mode } : undefined); return file;
  };
  await write('package.json', JSON.stringify({
    name: 'assessment-monorepo', private: true, packageManager: 'npm@10.9.0', workspaces: ['packages/*'],
    scripts: {
      test: `node -e "require('fs').writeFileSync(${JSON.stringify(marker)},'root-test')"`,
      build: `node -e "require('fs').writeFileSync(${JSON.stringify(marker)},'root-build')"`,
      lint: 'eslint .'
    }
  }, null, 2));
  await write('package-lock.json', JSON.stringify({ name: 'assessment-monorepo', lockfileVersion: 3, requires: true, packages: {
    '': { name: 'assessment-monorepo', workspaces: ['packages/*'] },
    'packages/app': { name: '@consumer/app', version: '1.0.0', dependencies: { '@legacy/a': '1.0.0', '@legacy/b': '2.0.0', '@target/ui': '3.0.0' } },
    'packages/legacy-a': { name: '@legacy/a', version: '1.0.0' }, 'packages/legacy-b': { name: '@legacy/b', version: '2.0.0' }, 'packages/target': { name: '@target/ui', version: '3.0.0' }
  } }, null, 2));
  await write('.github/workflows/ci.yml', `name: CI\non: [push]\nenv:\n  SECRET_TOKEN: ${sentinelText}\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n`);
  await write('CODEOWNERS', `/packages/app/src/** @unsupported-owner\n/packages/app/src/admin/ @admin-team\n/packages/app/src/shared/* @frontend-team\n/packages/app/src/conflict.tsx @team-a\n/packages/app/src/conflict.tsx @team-b\n`);

  await write('packages/legacy-a/package.json', JSON.stringify({ name: '@legacy/a', version: '1.0.0', types: 'index.d.ts', exports: { '.': { types: './index.d.ts' }, './default': { types: './default.d.ts' }, './styles': './styles.js' }, scripts: { preinstall: `node -e "require('fs').writeFileSync(${JSON.stringify(marker)},'legacy-a')"` } }, null, 2));
  await write('packages/legacy-a/index.d.ts', `export interface ButtonProps { variant?: 'primary' | 'danger'; size?: 'sm' | 'md'; onAction?: () => void; }\nexport declare function Button(props: ButtonProps): unknown;\nexport declare function Card(props: { title?: string }): unknown;\n`);
  await write('packages/legacy-a/default.d.ts', `export default function LegacyDefault(props: { label?: string }): unknown;\n`);
  await write('packages/legacy-a/styles.js', `throw new Error('styles module executed');\n`);
  await write('packages/legacy-a/src/internal.tsx', `import { Button } from '../index'; export const internal = <Button />; throw new Error('package body executed');\n`);

  await write('packages/legacy-b/package.json', JSON.stringify({ name: '@legacy/b', version: '2.0.0', types: 'index.d.ts' }, null, 2));
  await write('packages/legacy-b/index.d.ts', `export declare function Nav(props: { active?: boolean; destination?: string }): unknown;\nexport declare function Button(props: { selected?: boolean }): unknown;\n`);

  await write('packages/target/package.json', JSON.stringify({ name: '@target/ui', version: '3.0.0', types: 'index.d.ts' }, null, 2));
  await write('packages/target/index.d.ts', `export declare function ActionButton(props: { emphasis?: 'default' | 'danger'; size?: 'sm' | 'md'; onClick?: () => void }): unknown;\nexport declare function Surface(props: { title?: string }): unknown;\nexport declare function NavigationItem(props: { active?: boolean; href?: string }): unknown;\nexport declare function ToggleButton(props: { pressed?: boolean }): unknown;\nexport default function DefaultAction(props: { label?: string }): unknown;\n`);
  await write('packages/target/MIGRATION.md', `# Migration\nReplace \`Button\` from \`@legacy/a\` with \`ActionButton\`. Rename \`variant\` to \`emphasis\` and \`onAction\` to \`onClick\`.\nReplace \`Card\` with \`Surface\`.\nReplace \`Nav\` from \`@legacy/b\` with \`NavigationItem\`.\nReplace \`Button\` from \`@legacy/b\` with \`ToggleButton\`.\nReplace \`LegacyDefault\` with \`DefaultAction\`.\n`);

  await write('packages/app/package.json', JSON.stringify({ name: '@consumer/app', version: '1.0.0', private: true, dependencies: { '@legacy/a': '1.0.0', '@legacy/b': '2.0.0', '@target/ui': '3.0.0' }, scripts: { test: `node -e "require('fs').writeFileSync(${JSON.stringify(marker)},'app-test')"`, 'test:e2e': 'playwright test', typecheck: 'tsc --noEmit' } }, null, 2));
  await write('packages/app/src/ui.ts', `export { Button as LegacyButtonFromBarrel } from '@legacy/a';\n`);
  await write('packages/app/src/App.tsx', `
import { Button as LegacyButton, Card } from '@legacy/a';
import LegacyDefault from '@legacy/a/default';
import '@legacy/a/styles';
import * as LegacyB from '@legacy/b';
import { Button as BButton } from '@legacy/b';
import { Button as UnrelatedButton } from '@unrelated/ui';
import type { ButtonProps } from '@legacy/a';
import { LegacyButtonFromBarrel } from './ui';

const one = <LegacyButton variant="primary" label="One" />;
const oneAgain = <LegacyButton variant="primary" label="Two" />;
const two = <Card title="card" />;
const three = <LegacyB.Nav active={selected} destination="/home" />;
const four = <LegacyDefault label="default" />;
const five = <LegacyButton {...spreadProps} variant="danger" />;
const six = <LegacyButtonFromBarrel size="sm" />;
const seven = <BButton selected={selected} />;
const Wrapped = styled(LegacyButton);
const wrapped = <Wrapped />;
const Dynamic = import('@legacy/a');
const Required = require('@legacy/b');
const Computed = LegacyB['Nav'];
function shadow(LegacyButton) { return <LegacyButton />; }
const unrelated = <UnrelatedButton />;
const text = '<LegacyButton />';
// <LegacyButton />
`);
  await write('packages/app/src/admin/Page.tsx', `import { Button as LegacyButton } from '@legacy/a';\nexport const page = <LegacyButton variant="danger" />;\n`);
  await write('packages/app/src/shared/Item.tsx', `import { Nav } from '@legacy/b';\nexport const item = <Nav destination="/shared" />;\n`);
  await write('packages/app/src/conflict.tsx', `import { Card } from '@legacy/a';\nexport const conflict = <Card title="card" />;\n`);
  await write('packages/app/src/sentinel.ts', `throw new Error('consumer module executed');\n`);

  await write('node_modules/@installed/target/package.json', JSON.stringify({ name: '@installed/target', version: '4.0.0', types: 'index.d.ts' }, null, 2));
  await write('node_modules/@installed/target/index.d.ts', `export declare function InstalledTarget(props: {}): unknown;\n`);
  await write('node_modules/typescript/package.json', JSON.stringify({ name: 'typescript', version: '5.9.3', main: 'lib/typescript.js' }));
  await write('node_modules/typescript/lib/typescript.js', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'malicious compiler'); throw new Error('must not execute');\n`);

  return { root, marker, expected: { directUsages: 11, appUsages: 8, adminUsages: 1, sharedUsages: 1, conflictUsages: 1, selectedSources: ['@legacy/a', '@legacy/b'], target: '@target/ui' } };
}

export async function treeDigest(root) {
  const entries = [];
  async function visit(directory, prefix = '') {
    for (const name of (await fs.readdir(directory)).sort()) {
      const file = path.join(directory, name); const relative = prefix + name; const stat = await fs.lstat(file);
      if (stat.isDirectory()) await visit(file, relative + '/');
      else if (stat.isSymbolicLink()) entries.push([relative, 'link', await fs.readlink(file)]);
      else entries.push([relative, stat.mode & 0o777, createHash('sha256').update(await fs.readFile(file)).digest('hex')]);
    }
  }
  await visit(root); return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}
