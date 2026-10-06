import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  discoverDesignSystemCandidates, inventoryConsumerRepository, resolvePackageReference,
  validatePackageSelection, verifyConsumerInventory,
} from '../../src/consumer-discovery.mjs';

async function fixture(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shift-consumer-discovery-'));
  for (const [file, contents] of Object.entries(files)) {
    const target = path.join(root, file); await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2));
  }
  return root;
}

test('inventories workspace metadata without exposing script bodies or credential specs', async (t) => {
  const root = await fixture({
    'package.json': { name: '@demo/root', version: '1.0.0', private: true, packageManager: 'npm@11.0.0', workspaces: ['apps/*', 'packages/*'], scripts: { test: 'secret-command --token hidden', build: 'build-private' }, dependencies: { '@demo/legacy': 'workspace:*', private: 'git+ssh://secret/repo' } },
    'package-lock.json': '{}',
    'apps/web/package.json': { name: '@demo/web', version: '1.0.0', dependencies: { '@demo/legacy': '^1.0.0' }, scripts: { typecheck: 'tsc --private' } },
    'apps/web/src/App.tsx': 'export const App = () => <main />;',
    'packages/legacy/package.json': { name: '@demo/legacy', version: '1.0.0', designSystem: true },
    'packages/legacy/index.ts': 'export const Button = 1;',
    '.github/workflows/ci.yml': 'jobs: {}',
    '.github/CODEOWNERS': '/apps/web @frontend # primary owner\n/generated # explicitly unowned\n![invalid] @wrong\n/bad not-an-owner\n',
    'CODEOWNERS': '* @fallback\n',
    '.ENV': 'TOKEN=hidden',
    '.SSH/id_rsa': 'hidden',
    'pnpm-workspace.yaml': 'packages:\n  - apps/*\n',
  });
  const irrelevant = await fs.open(path.join(root, 'large-video.bin'), 'w');
  await irrelevant.truncate(101 * 1024 * 1024); await irrelevant.close();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const inventory = await inventoryConsumerRepository(root);
  assert.equal(inventory.root, await fs.realpath(root));
  assert.match(inventory.digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(inventory.workspaces.map((item) => item.name), ['@demo/web', '@demo/legacy']);
  assert.equal(inventory.packageManager.declared, 'npm@11.0.0');
  assert.equal(inventory.packageManager.lockfiles.length, 1);
  assert.deepEqual(inventory.declaredScripts.map((item) => item.name), ['build', 'test', 'typecheck']);
  assert.equal(JSON.stringify(inventory).includes('secret-command'), false);
  assert.equal(JSON.stringify(inventory).includes('git+ssh'), false);
  assert.equal(inventory.ciEvidence.length, 1);
  assert.equal(inventory.codeowners.find((item) => item.file === '.github/CODEOWNERS').active, true);
  assert.equal(inventory.codeowners.find((item) => item.file === 'CODEOWNERS').active, false);
  assert.deepEqual(inventory.codeowners.find((item) => item.active).rules, [
    { pattern: '/apps/web', owners: ['@frontend'], line: 1 },
    { pattern: '/generated', owners: [], line: 2 },
  ]);
  assert.ok(inventory.coverage.excluded.some((item) => item.path === '.ENV' && /sensitive/.test(item.reason)));
  assert.ok(inventory.coverage.excluded.some((item) => item.path === '.SSH' && /sensitive/.test(item.reason)));
  assert.ok(inventory.coverage.unsupported.some((item) => item.kind === 'workspace-format'));
  assert.equal(inventory.coverage.unsupported.filter((item) => item.kind === 'codeowners-pattern').length, 2);
  assert.ok(inventory.coverage.excluded.some((item) => item.path === 'large-video.bin'));
  assert.equal(await verifyConsumerInventory(inventory), true);
  const candidates = discoverDesignSystemCandidates(inventory, [{ package: '@demo/legacy', evidence: [{ file: 'apps/web/src/App.tsx' }] }]);
  assert.deepEqual(candidates[0].bases, ['design-system-metadata', 'direct-jsx-import']);
  await fs.appendFile(path.join(root, 'apps/web/src/App.tsx'), '\n// drift');
  assert.equal(await verifyConsumerInventory(inventory), false);
});

test('resolves explicit workspace, installed, and outside local packages but rejects registry acquisition', async (t) => {
  const root = await fixture({
    'package.json': { name: 'root', version: '1.0.0', workspaces: ['packages/*'] },
    'packages/source/package.json': { name: '@demo/source', version: '1.0.0' },
    'packages/target/package.json': { name: '@demo/target', version: '2.0.0' },
    'node_modules/@demo/installed/package.json': { name: '@demo/installed', version: '3.0.0' },
  });
  const outside = await fixture({ 'package.json': { name: '@demo/outside', version: '4.0.0' } });
  t.after(() => Promise.all([fs.rm(root, { recursive: true, force: true }), fs.rm(outside, { recursive: true, force: true })]));
  const inventory = await inventoryConsumerRepository(root);
  await fs.symlink(path.join(root, 'packages/source'), path.join(root, 'node_modules/@demo/source'), 'dir');
  const source = await resolvePackageReference(inventory, '@demo/source', 'source');
  const installed = await resolvePackageReference(inventory, '@demo/installed', 'source');
  const target = await resolvePackageReference(inventory, './packages/target', 'target');
  const outsideTarget = await resolvePackageReference(inventory, outside, 'target');
  assert.equal(source.resolution, 'workspace'); assert.equal(installed.resolution, 'installed');
  assert.equal(target.resolution, 'local'); assert.equal(outsideTarget.identity.name, '@demo/outside');
  assert.doesNotThrow(() => validatePackageSelection([source, installed], target));
  assert.throws(() => validatePackageSelection([source], { ...target, root: source.root }), /distinct/);
  await assert.rejects(resolvePackageReference(inventory, '@demo/source@1.0.0', 'source'), /Registry package versions are unsupported/);
  await fs.unlink(path.join(root, 'node_modules/@demo/source'));
  await fs.mkdir(path.join(root, 'node_modules/@demo/source'));
  await fs.writeFile(path.join(root, 'node_modules/@demo/source/package.json'), JSON.stringify({ name: '@demo/source', version: '0.5.0' }));
  await assert.rejects(resolvePackageReference(inventory, '@demo/source', 'source'), /roots conflict/);
});

test('rejects installed package links into protected repository metadata', async (t) => {
  const root = await fixture({
    'package.json': { name: 'root', version: '1.0.0' },
    '.git/pkg/package.json': { name: '@demo/evil', version: '1.0.0' },
  });
  await fs.mkdir(path.join(root, 'node_modules/@demo'), { recursive: true });
  await fs.symlink(path.join(root, '.git/pkg'), path.join(root, 'node_modules/@demo/evil'), 'dir');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const inventory = await inventoryConsumerRepository(root);
  await assert.rejects(resolvePackageReference(inventory, '@demo/evil', 'source'), /protected repository metadata/);
  await assert.rejects(resolvePackageReference(inventory, './.git/pkg', 'source'), /protected repository metadata/);
});
