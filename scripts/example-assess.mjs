#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wrapper = path.join(checkout, 'bin', 'rhubase');
const base = await fs.mkdtemp(path.join(os.tmpdir(), 'rhubase-example-'));
const repository = path.join(base, 'consumer');
const output = path.join(base, 'assessment');

async function write(relative, contents) {
  const file = path.join(repository, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents);
}

await write('package.json', JSON.stringify({
  name: 'rhubase-example-consumer',
  private: true,
  workspaces: ['packages/*'],
}, null, 2));
await write('package-lock.json', JSON.stringify({
  name: 'rhubase-example-consumer',
  lockfileVersion: 3,
  requires: true,
  packages: {
    '': { name: 'rhubase-example-consumer', workspaces: ['packages/*'] },
    'packages/app': { name: '@example/app', version: '1.0.0', dependencies: { '@example/legacy-web': '1.0.0', '@example/legacy-admin': '1.0.0', '@example/foundation': '2.0.0' } },
    'packages/legacy-web': { name: '@example/legacy-web', version: '1.0.0' },
    'packages/legacy-admin': { name: '@example/legacy-admin', version: '1.0.0' },
    'packages/foundation': { name: '@example/foundation', version: '2.0.0' },
  },
}, null, 2));
await write('packages/app/package.json', JSON.stringify({
  name: '@example/app',
  version: '1.0.0',
  private: true,
  dependencies: { '@example/legacy-web': '1.0.0', '@example/legacy-admin': '1.0.0', '@example/foundation': '2.0.0' },
}, null, 2));
await write('packages/app/src/App.tsx', `import { PrimaryButton } from '@example/legacy-web';
import { AdminButton } from '@example/legacy-admin';

export const App = () => <main>
  <PrimaryButton tone="brand">Continue</PrimaryButton>
  <AdminButton compact>Save</AdminButton>
</main>;
`);
await write('packages/legacy-web/package.json', JSON.stringify({ name: '@example/legacy-web', version: '1.0.0', types: 'index.d.ts' }, null, 2));
await write('packages/legacy-web/index.d.ts', `export declare function PrimaryButton(props: { tone?: 'brand' | 'danger'; children?: unknown }): unknown;
`);
await write('packages/legacy-admin/package.json', JSON.stringify({ name: '@example/legacy-admin', version: '1.0.0', types: 'index.d.ts' }, null, 2));
await write('packages/legacy-admin/index.d.ts', `export declare function AdminButton(props: { compact?: boolean; children?: unknown }): unknown;
`);
await write('packages/foundation/package.json', JSON.stringify({ name: '@example/foundation', version: '2.0.0', types: 'index.d.ts' }, null, 2));
await write('packages/foundation/index.d.ts', `export declare function Button(props: { emphasis?: 'default' | 'danger'; size?: 'sm' | 'md'; children?: unknown }): unknown;
`);
await write('packages/foundation/MIGRATION.md', `# Consolidation guide

Replace \`PrimaryButton\` from \`@example/legacy-web\` with \`Button\`. Rename the \`tone\` prop to \`emphasis\`.
Replace \`AdminButton\` from \`@example/legacy-admin\` with \`Button\`. Replace the \`compact\` prop with the \`size\` prop.
`);

const result = spawnSync(wrapper, [
  'assess', repository,
  '--source', '@example/legacy-web',
  '--source', '@example/legacy-admin',
  '--target', '@example/foundation',
  '--out', output,
], {
  cwd: process.cwd(),
  env: process.env,
  shell: false,
  stdio: 'inherit',
});
if (result.error) throw result.error;
if (result.status !== 0) {
  await fs.rm(base, { recursive: true, force: true });
  process.exit(result.status ?? 1);
}

process.stdout.write(`\nExample complete.\nReview: ${path.join(output, 'assessment.md')}\nMachine report: ${path.join(output, 'assessment.json')}\nScratch workspace: ${base}\n`);
