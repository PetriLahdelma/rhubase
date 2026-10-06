import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { inventoryConsumerRepository, resolvePackageReference } from '../../src/consumer-discovery.mjs';
import { discoverConsumerUsages, discoverJsxImportCandidates } from '../../src/consumer-usages.mjs';

async function fixture(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shift-consumer-usages-'));
  for (const [file, contents] of Object.entries(files)) {
    const target = path.join(root, file); await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2));
  }
  return root;
}

test('discovers two workspace design systems through imports, barrels, namespaces, aliases, and explicit gaps', async (t) => {
  const root = await fixture({
    'package.json': { name: '@demo/root', version: '1.0.0', workspaces: ['apps/*', 'packages/*'] },
    'apps/web/package.json': { name: '@demo/web', version: '1.0.0', dependencies: { '@legacy/a': 'workspace:*', '@legacy/b': 'workspace:*' } },
    'apps/web/src/barrel.ts': `export { Button as LegacyButton } from '@legacy/a';\nexport { default as Card } from '@legacy/b';`,
    'apps/web/src/barrel2.ts': `export { LegacyButton, Card } from './barrel';`,
    'apps/web/src/ambiguous.ts': `export { Button } from '@legacy/a'; export { default as Button } from '@legacy/b';`,
    'apps/web/src/App.tsx': `
      import { LegacyButton as Action, Card } from './barrel2';
      import { Button as Ambiguous } from './ambiguous';
      import * as Legacy from '@legacy/a/subpath';
      import '@legacy/a/theme.css';
      import '@legacy/a/styles';
      import '@unrelated/ui/runtime';
      const Alias = Action;
      const Wrapped = (props) => <Action {...props} />;
      const FactoryAlias = makeComponent(Action);
      const lazy = () => import('@legacy/b');
      function Shadowed(){ const Action = () => <i/>; return <Action/>; }
      export const App = () => <><Alias tone="quiet"/><Legacy.Button count={2} label="2"/><Card/><Wrapped/><FactoryAlias/><Ambiguous/></>;
    `,
    'packages/a/package.json': { name: '@legacy/a', version: '1.0.0' },
    'packages/a/index.tsx': 'export const Button = () => <button />;',
    'packages/b/package.json': { name: '@legacy/b', version: '1.0.0' },
    'packages/b/index.tsx': 'export default function Card(){ return <section/> }',
    'packages/target/package.json': { name: '@target/ui', version: '2.0.0' },
    'packages/target/index.tsx': 'export const Action = () => <button />;',
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const inventory = await inventoryConsumerRepository(root);
  const sourceA = await resolvePackageReference(inventory, '@legacy/a', 'source');
  const sourceB = await resolvePackageReference(inventory, '@legacy/b', 'source');
  const target = await resolvePackageReference(inventory, '@target/ui', 'target');
  const candidates = await discoverJsxImportCandidates({ root, inventory, ts });
  assert.ok(candidates.some((item) => item.package === '@legacy/a' && item.module === '@legacy/a/subpath'));
  const result = await discoverConsumerUsages({ root, inventory, sourcePackages: [sourceA, sourceB], targetPackage: target, ts });
  assert.equal(result.usages.length, 4);
  assert.deepEqual(result.usages.map((item) => item.sourcePackage).sort(), ['@legacy/a', '@legacy/a', '@legacy/a', '@legacy/b']);
  assert.ok(result.usages.every((item) => item.consumerPackage === '@demo/web' && item.evidence[0].scope === 'consumer'));
  const subpath = result.usages.find((item) => item.module === '@legacy/a/subpath');
  assert.equal(subpath.export, './subpath#Button');
  assert.equal(subpath.props.find((item) => item.name === 'count').value, 2);
  assert.equal(subpath.props.find((item) => item.name === 'label').value, '2');
  assert.ok(result.usages.some((item) => item.module === '@legacy/b' && item.export === 'default'));
  assert.ok(result.usages.some((item) => item.hasSpread));
  assert.ok(result.unsupported.some((item) => item.kind === 'wrapper-usage'));
  assert.ok(result.unsupported.some((item) => item.kind === 'factory-or-alias'));
  assert.ok(result.unsupported.some((item) => item.kind === 'local-reexport-resolution'));
  assert.ok(result.unsupported.some((item) => item.kind === 'spread-props'));
  assert.ok(result.unsupported.some((item) => item.kind === 'style-import'));
  const sideEffect = result.unsupported.find((item) => item.kind === 'non-jsx-reference' && /Side-effect import/.test(item.reason));
  assert.equal(sideEffect.evidence[0].quote, `import '@legacy/a/styles';`);
  assert.equal(result.unsupported.some((item) => item.evidence?.[0]?.quote?.includes('@unrelated/ui/runtime')), false);
  assert.ok(result.unsupported.some((item) => item.kind === 'dynamic-module-binding'));
  assert.ok(result.unsupported.some((item) => item.kind === 'undeclared-package-subpath'));
  assert.ok(result.unsupported.some((item) => item.kind === 'excluded-source-library'));
  assert.equal(result.coverage.status, 'partial');
  assert.equal(result.coverage.recognizedUsages, 4);
  assert.equal(new Set(result.usages.map((item) => item.id)).size, result.usages.length);
});

test('does not attribute a nested different installed version to the selected source root', async (t) => {
  const root = await fixture({
    'package.json': { name: 'root', version: '1.0.0', workspaces: ['apps/*', 'packages/*'] },
    'apps/web/package.json': { name: 'web', version: '1.0.0', dependencies: { '@legacy/a': 'workspace:*' } },
    'apps/web/src/App.tsx': `import {Button} from '@legacy/a'; export const App=()=> <Button/>;`,
    'apps/web/node_modules/@legacy/a/package.json': { name: '@legacy/a', version: '0.5.0' },
    'packages/a/package.json': { name: '@legacy/a', version: '1.0.0' },
    'packages/a/index.ts': 'export const Button = 1;',
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const inventory = await inventoryConsumerRepository(root); const source = await resolvePackageReference(inventory, '@legacy/a', 'source');
  const result = await discoverConsumerUsages({ root, inventory, sourcePackages: [source], ts });
  assert.equal(result.usages.length, 0);
  assert.ok(result.unsupported.some((item) => item.kind === 'unsupported-version-scope' && /different/.test(item.reason)));
  assert.equal(result.coverage.status, 'partial');
});
