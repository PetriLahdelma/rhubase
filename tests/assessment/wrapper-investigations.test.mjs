import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { inventoryConsumerRepository, resolvePackageReference } from '../../src/consumer-discovery.mjs';
import { discoverConsumerUsages } from '../../src/consumer-usages.mjs';
import { assessConsumer, resolveAssessment } from '../../src/consumer-assessment.mjs';
import { createWrapperInvestigationFixture } from './wrapper-fixture.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');

async function fixture(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhubase-wrapper-investigations-'));
  for (const [file, contents] of Object.entries(files)) {
    const target = path.join(root, file); await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2));
  }
  return root;
}

async function analyze(root) {
  const inventory = await inventoryConsumerRepository(root);
  const sourceA = await resolvePackageReference(inventory, '@legacy/a', 'source');
  const sourceB = await resolvePackageReference(inventory, '@legacy/b', 'source');
  const sourceDigests = new Map([[sourceA.id, 'a'.repeat(64)], [sourceB.id, 'b'.repeat(64)]]);
  return discoverConsumerUsages({ root, inventory, sourcePackages: [sourceA, sourceB], sourceDigests, ts });
}

function baseFiles(extra = {}) {
  return {
    'package.json': { name: '@demo/root', version: '1.0.0', workspaces: ['apps/*', 'packages/*'] },
    'apps/web/package.json': { name: '@demo/web', version: '1.0.0', dependencies: { '@legacy/a': 'workspace:*', '@legacy/b': 'workspace:*' } },
    'packages/a/package.json': { name: '@legacy/a', version: '1.0.0' },
    'packages/a/index.tsx': 'export const Button = () => <button/>;',
    'packages/b/package.json': { name: '@legacy/b', version: '1.0.0' },
    'packages/b/index.tsx': 'export const Button = () => <button/>;',
    ...extra,
  };
}

test('builds source-qualified packets for same-named wrappers and retains all twelve unknown call sites', async (t) => {
  const root = await fixture(baseFiles({
    'apps/web/src/AButton.tsx': `import { Button as SourceButton } from '@legacy/a';\nexport const Button = () => <SourceButton tone="quiet"/>;\nconst local1=<Button/>; const local2=<Button/>;`,
    'apps/web/src/BButton.tsx': `import { Button as SourceButton } from '@legacy/b';\nexport const Button = () => (<SourceButton selected/>);\nconst local1=<Button/>; const local2=<Button/>;`,
    'apps/web/src/barrel.ts': `export { Button as AButton } from './AButton';\nexport { Button as BButton } from './BButton';`,
    'apps/web/src/direct.tsx': `import { Button as DirectA } from './AButton'; import { Button as DirectB } from './BButton'; import { Button as SourceA } from '@legacy/a'; import { Button as SourceB } from '@legacy/b';\nexport const x=<><DirectA/><DirectA/><DirectB/><DirectB/><SourceA/><SourceB/></>;`,
    'apps/web/src/aliased.tsx': `import { Button as AliasA } from './AButton'; import { Button as AliasB } from './BButton';\nexport const x=<><AliasA/><AliasB/></>;`,
    'apps/web/src/via-barrel.tsx': `import { AButton, BButton } from './barrel';\nexport const x=<><AButton/><BButton/></>;`,
  }));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await analyze(root);
  assert.equal(result.usages.length, 4, 'direct application and inner selected-source sites remain recognized usages');
  assert.equal(result.unsupported.filter((item) => ['wrapper-usage', 'local-reexport-resolution'].includes(item.kind)).length, 12);
  assert.equal(result.wrapperInvestigations.length, 2);
  const sourceById = new Map(result.usages.map((item) => [item.sourceId, item.sourcePackage]));
  assert.deepEqual(result.wrapperInvestigations.map((item) => [sourceById.get(item.sourceId), item.sourceExport, item.unknownIds.length]).sort(), [
    ['@legacy/a', 'Button', 6], ['@legacy/b', 'Button', 6],
  ]);
  for (const packet of result.wrapperInvestigations) {
    assert.match(packet.id, /^wrapper:[0-9a-f]{20}$/); assert.match(packet.revision, /^[0-9a-f]{64}$/);
    assert.equal(packet.definition.evidence.length, 1); assert.equal(packet.innerUsageIds.length, 1);
    assert.ok(packet.bindingEvidence.some((item) => item.quote.includes("from '@legacy/")));
    assert.equal(packet.status, 'needs-review'); assert.equal(packet.executable, false);
  }
  assert.equal(new Set(result.wrapperInvestigations.flatMap((item) => item.unknownIds)).size, 12);
});

test('definition-only drift changes one revision without changing call-site IDs', async (t) => {
  const root = await fixture(baseFiles({
    'apps/web/src/AButton.tsx': `import { Button as SourceButton } from '@legacy/a';\nexport const Button = () => <SourceButton tone="quiet"/>;`,
    'apps/web/src/BButton.tsx': `import { Button as SourceButton } from '@legacy/b';\nexport const Button = () => <SourceButton/>;`,
    'apps/web/src/App.tsx': `import { Button as A } from './AButton'; import { Button as B } from './BButton'; export const x=<><A/><B/></>;`,
  }));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const before = await analyze(root);
  await fs.writeFile(path.join(root, 'apps/web/src/AButton.tsx'), `import { Button as SourceButton } from '@legacy/a';\nexport const Button = () => <SourceButton tone="loud"/>;`);
  const after = await analyze(root);
  const bySource = (value, name) => value.wrapperInvestigations.find((item) => value.usages.find((usage) => usage.id === item.innerUsageIds[0]).sourcePackage === name);
  assert.notEqual(bySource(before, '@legacy/a').revision, bySource(after, '@legacy/a').revision);
  assert.equal(bySource(before, '@legacy/b').revision, bySource(after, '@legacy/b').revision);
  assert.deepEqual(before.unsupported.map((item) => item.id), after.unsupported.map((item) => item.id));
});

test('links calls before and after a strict declaration while leaving a real factory ungrouped', async (t) => {
  const root = await fixture(baseFiles({
    'apps/web/src/ordered.tsx': `import { Button as SourceButton } from '@legacy/a';\nfunction before(){ return <Button/>; }\nexport const Button = () => <SourceButton/>;\nconst after=<Button/>;\nconst Factory=make(SourceButton); const factory=<Factory/>;`,
  }));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await analyze(root); const packet = result.wrapperInvestigations[0];
  assert.equal(packet.unknownIds.length, 2);
  const linkedKinds = packet.unknownIds.map((id) => result.unsupported.find((item) => item.id === id).kind).sort();
  assert.deepEqual(linkedKinds, ['factory-or-alias', 'wrapper-usage']);
  const factory = result.unsupported.find((item) => item.evidence?.[0]?.quote === '<Factory/>');
  assert.equal(factory.kind, 'factory-or-alias'); assert.equal(packet.unknownIds.includes(factory.id), false);
});

test('keeps declared source subpath wrappers outside the initial root-import profile', async (t) => {
  const files = baseFiles({
    'packages/a/package.json': { name: '@legacy/a', version: '1.0.0', exports: { '.': './index.tsx', './subpath': './subpath.tsx' } },
    'packages/a/subpath.tsx': 'export const Button = () => <button/>;',
    'apps/web/src/subpath.tsx': `import { Button as SourceButton } from '@legacy/a/subpath'; export const Button = () => <SourceButton/>; const call=<Button/>;`,
  });
  const root = await fixture(files); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await analyze(root);
  assert.ok(result.usages.some((item) => item.module === '@legacy/a/subpath'));
  assert.equal(result.wrapperInvestigations.length, 0);
  assert.ok(result.unsupported.some((item) => item.evidence?.[0]?.quote === '<Button/>' || item.evidence?.[0]?.quote === '<Button/>'));
});

test('rejects mutable, factory, shadowed, star, cyclic, and ambiguous wrapper paths', async (t) => {
  const root = await fixture(baseFiles({
    'apps/web/src/good.tsx': `import { Button as SourceButton } from '@legacy/a'; export const Good = () => <SourceButton/>;`,
    'apps/web/src/mutable.tsx': `import { Button as SourceButton } from '@legacy/a'; export let Mutable = () => <SourceButton/>;`,
    'apps/web/src/factory.tsx': `import { Button as SourceButton } from '@legacy/a'; export const Factory = make(() => <SourceButton/>);`,
    'apps/web/src/nested.tsx': `import { Button as SourceButton } from '@legacy/a'; import { Button as OtherSourceButton } from '@legacy/b'; export const Nested = () => <SourceButton><OtherSourceButton/></SourceButton>;`,
    'apps/web/src/conflict.tsx': `import { Button as SourceButton } from '@legacy/a'; export const Conflict = () => <SourceButton/>; const Other = () => <i/>; export { Other as Conflict };`,
    'apps/web/src/star.ts': `export * from './good';`,
    'apps/web/src/cycle-a.ts': `export { Cycled } from './cycle-b';`,
    'apps/web/src/cycle-b.ts': `export { Cycled } from './cycle-a';`,
    'apps/web/src/ambiguous.ts': `export { Good } from './good'; export { Good } from './other';`,
    'apps/web/src/mixed.ts': `export { Good } from './good'; export { Missing as Good } from './missing';`,
    'apps/web/src/missing.tsx': `export const Missing = () => <i/>;`,
    'apps/web/src/other.tsx': `import { Button as SourceButton } from '@legacy/b'; export const Good = () => <SourceButton/>;`,
    'apps/web/src/App.tsx': `import { Good } from './good'; import { Good as ViaStar } from './star'; import { Good as Ambiguous } from './ambiguous'; import { Good as Mixed } from './mixed'; import { Cycled } from './cycle-a'; import { Mutable } from './mutable'; import { Factory } from './factory'; import { Nested } from './nested'; import { Conflict } from './conflict';\nconst Shadow=()=>{ const Good=()=> <i/>; return <Good/> }; export const x=<><Good/><ViaStar/><Ambiguous/><Mixed/><Cycled/><Mutable/><Factory/><Nested/><Conflict/><Shadow/></>;`,
  }));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await analyze(root);
  assert.equal(result.wrapperInvestigations.length, 1);
  const packet = result.wrapperInvestigations[0];
  assert.equal(packet.definition.file, 'apps/web/src/good.tsx');
  assert.equal(packet.unknownIds.length, 1, 'only the direct named import is linked');
});

test('composeAssessment defaults wrapperInvestigations to an empty top-level array', async () => {
  const { composeAssessment } = await import('../../src/consumer-assessment.mjs');
  const source = { id: 'source:a', importName: '@legacy/a', resolution: 'workspace', identity: { name: '@legacy/a', version: '1.0.0' } };
  const resolution = { kind: 'assessment-resolution', repository: { digest: 'd', files: [], manifests: [], workspaces: [], packageManager: {}, declaredScripts: [], ciEvidence: [], codeowners: [], coverage: { unsupported: [] } }, sources: [source], target: { id: 'target:t', resolution: 'workspace' } };
  const contract = { from: { name: '@legacy/a', version: '1.0.0', digest: 'a'.repeat(64) }, to: { name: '@target/ui', version: '2.0.0', digest: 'b'.repeat(64) }, changes: [], proposals: [] };
  const assessment = composeAssessment({ resolution, contracts: [{ sourceId: source.id, contract }], usageInventory: { filesScanned: 0, usages: [], unsupported: [], coverage: { status: 'partial', limitations: [] } } });
  assert.deepEqual(assessment.wrapperInvestigations, []);
});

test('full assessment emits the shared two-system wrapper fixture without changing usage coverage', async (t) => {
  const { root, expected } = await createWrapperInvestigationFixture(t);
  const selectors = { repo: root, sources: ['@legacy/a', '@legacy/b'], target: '@target/ui' };
  const resolution = await resolveAssessment(selectors);
  const result = await assessConsumer({ ...selectors, compiler: path.resolve('node_modules/typescript/lib/typescript.js'), expectedResolutionDigest: resolution.digest });
  assert.equal(result.assessment.wrapperInvestigations.length, expected.packets);
  assert.equal(result.assessment.usageInventory.usages.length, expected.recognizedUsages);
  assert.equal(result.assessment.usageInventory.unsupported.filter((item) => ['wrapper-usage', 'local-reexport-resolution'].includes(item.kind)).length, expected.wrapperCalls);
  assert.equal(result.assessment.usageInventory.coverage.recognizedUsages, expected.recognizedUsages);
});
