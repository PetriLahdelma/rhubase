import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWrapperInvestigationFixture, wrapperFixtureDigest } from '../assessment/wrapper-fixture.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = path.join(repository, 'Cargo.toml');
const trustedCompiler = process.env.SHIFT_TYPESCRIPT_PATH;
const binary = path.join(repository, 'target/release/ctrl-shift');
let scratch;

before(async () => {
  assert.ok(trustedCompiler && path.isAbsolute(trustedCompiler), 'SHIFT_TYPESCRIPT_PATH must be an absolute trusted TypeScript path');
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'rhubase-wrapper-blackbox-'));
  await fs.mkdir(path.join(scratch, 'workers'));
  if (process.env.RHUBASE_SKIP_TEST_BUILD !== '1') {
    const build = spawnSync('cargo', ['build', '--locked', '--release', '--manifest-path', manifest, '--bin', 'ctrl-shift'], {
      cwd: scratch, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(build.status, 0, build.stdout + build.stderr);
  }
});
after(async () => { if (scratch) await fs.rm(scratch, { recursive: true, force: true }); });

function assess(fixture, output, extra = []) {
  return spawnSync(binary, [
    'assess', fixture.root,
    '--source', '@legacy/a', '--source', '@legacy/b',
    '--target', '@target/ui', '--out', output,
    '--compiler', trustedCompiler, '--node', process.execPath,
    ...extra,
  ], { cwd: scratch, env: { ...process.env }, encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
}

async function readAssessment(output) {
  return JSON.parse(await fs.readFile(path.join(output, 'assessment.json'), 'utf8'));
}

function wrapperUnknowns(assessment) {
  return assessment.usageInventory.unsupported.filter((item) => ['wrapper-usage', 'local-reexport-resolution'].includes(item.kind));
}

async function writeFixtureFile(fixture, relative, content) {
  const file = path.join(fixture.root, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content);
}

test('two same-named wrappers remain source-qualified and retain all recognized and unresolved sites', async (t) => {
  const fixture = await createWrapperInvestigationFixture(t); const beforeDigest = await wrapperFixtureDigest(fixture.root);
  const output = path.join(scratch, `positive-${Date.now()}`); const result = assess(fixture, output);
  assert.equal(result.status, 0, result.stderr);
  const assessment = await readAssessment(output); const packets = assessment.wrapperInvestigations;
  assert.equal(packets.length, fixture.expected.packets);
  assert.equal(assessment.usageInventory.usages.length, fixture.expected.recognizedUsages);
  assert.equal(wrapperUnknowns(assessment).length, fixture.expected.wrapperCalls);
  assert.equal(packets.flatMap((packet) => packet.unknownIds).length, fixture.expected.wrapperCalls);
  assert.equal(new Set(packets.flatMap((packet) => packet.unknownIds)).size, fixture.expected.wrapperCalls);
  assert.deepEqual(new Set(packets.map((packet) => packet.sourceExport)), new Set(['Button']));
  assert.equal(new Set(packets.map((packet) => packet.sourceId)).size, 2);
  const sourceNames = new Map(assessment.sources.map((source) => [source.id, source.importName]));
  assert.equal(sourceNames.get(packets.find((packet) => packet.definition.file.includes('/a/')).sourceId), '@legacy/a');
  assert.equal(sourceNames.get(packets.find((packet) => packet.definition.file.includes('/b/')).sourceId), '@legacy/b');
  const unknownById = new Map(assessment.usageInventory.unsupported.map((item) => [item.id, item]));
  const usageById = new Map(assessment.usageInventory.usages.map((item) => [item.id, item]));
  for (const packet of packets) {
    assert.deepEqual(Object.keys(packet).sort(), ['bindingEvidence', 'definition', 'executable', 'id', 'innerUsageIds', 'revision', 'sourceExport', 'sourceId', 'status', 'unknownIds']);
    assert.deepEqual(Object.keys(packet.definition).sort(), ['evidence', 'file', 'name']);
    assert.match(packet.id, /^wrapper:[a-f0-9]{20}$/);
    assert.match(packet.revision, /^[a-f0-9]{64}$/);
    assert.equal(packet.definition.name, 'Button');
    assert.equal(packet.innerUsageIds.length, 1);
    assert.equal(packet.unknownIds.length, 6);
    assert.equal(usageById.get(packet.innerUsageIds[0]).sourceId, packet.sourceId);
    assert.ok(packet.unknownIds.every((id) => ['wrapper-usage', 'local-reexport-resolution'].includes(unknownById.get(id)?.kind)));
    assert.equal(packet.definition.evidence.length, 1);
    assert.ok(packet.bindingEvidence.length >= 1);
    assert.equal(packet.status, 'needs-review');
    assert.equal(packet.executable, false);
  }
  assert.equal(await wrapperFixtureDigest(fixture.root), beforeDigest);
});

test('definition-only drift changes one revision without changing call-site warning identities', async (t) => {
  const fixture = await createWrapperInvestigationFixture(t); const firstOutput = path.join(scratch, `drift-a-${Date.now()}`);
  assert.equal(assess(fixture, firstOutput).status, 0); const first = await readAssessment(firstOutput);
  const changedDefinition = path.join(fixture.root, 'packages/app/src/a/Button.tsx');
  const original = await fs.readFile(changedDefinition, 'utf8');
  await fs.writeFile(changedDefinition, original.replace('(props)', '(attrs)').replace('{...props}', '{...attrs}'));
  const secondOutput = path.join(scratch, `drift-b-${Date.now()}`); const rerun = assess(fixture, secondOutput);
  assert.equal(rerun.status, 0, rerun.stderr); const second = await readAssessment(secondOutput);
  const byDefinition = (assessment) => new Map(assessment.wrapperInvestigations.map((packet) => [packet.definition.file, packet]));
  const before = byDefinition(first); const after = byDefinition(second);
  assert.notEqual(after.get('packages/app/src/a/Button.tsx').revision, before.get('packages/app/src/a/Button.tsx').revision);
  assert.equal(after.get('packages/app/src/b/Button.tsx').revision, before.get('packages/app/src/b/Button.tsx').revision);
  assert.deepEqual(after.get('packages/app/src/a/Button.tsx').unknownIds, before.get('packages/app/src/a/Button.tsx').unknownIds);
  assert.deepEqual(after.get('packages/app/src/b/Button.tsx').unknownIds, before.get('packages/app/src/b/Button.tsx').unknownIds);
});

test('Markdown reports every wrapper definition and unresolved call-site location with review limitations', async (t) => {
  const fixture = await createWrapperInvestigationFixture(t); const output = path.join(scratch, `markdown-${Date.now()}`);
  const result = assess(fixture, output); assert.equal(result.status, 0, result.stderr);
  const assessment = await readAssessment(output); const markdown = await fs.readFile(path.join(output, 'assessment.md'), 'utf8');
  assert.match(markdown, /wrapper investigations/i);
  for (const packet of assessment.wrapperInvestigations) {
    assert.match(markdown, new RegExp(packet.definition.file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    for (const id of packet.unknownIds) {
      const unknown = assessment.usageInventory.unsupported.find((item) => item.id === id);
      assert.ok(unknown); assert.match(markdown, new RegExp(`${unknown.file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[:#]${unknown.line}`));
    }
  }
  assert.match(markdown, /effective props/i);
  assert.match(markdown, /accessibility/i);
  assert.match(markdown, /providers?/i);
  assert.match(markdown, /behavio[u]?r/i);
});

for (const [name, files] of [
  ['shadowed JSX bindings', {
    'packages/app/src/unsupported/Shadowed.tsx': "import { Button as SourceButton } from '@legacy/a';\nexport const Shadowed = (SourceButton) => <SourceButton />;\n",
  }],
  ['ambiguous source meanings', {
    'packages/app/src/unsupported/Ambiguous.tsx': "import { Button as A } from '@legacy/a';\nimport { Button as B } from '@legacy/b';\nexport const Ambiguous = (props) => flag ? <A {...props} /> : <B {...props} />;\n",
  }],
  ['mutable wrapper bindings', {
    'packages/app/src/unsupported/Mutable.tsx': "import { Button as SourceButton } from '@legacy/a';\nexport let Mutable = (props) => <SourceButton {...props} />;\nMutable = replacement;\nexport const useMutable = <Mutable />;\n",
  }],
  ['wrapper factories', {
    'packages/app/src/unsupported/Factory.tsx': "import { Button as SourceButton } from '@legacy/a';\nexport const Factory = styled(SourceButton);\nexport const useFactory = <Factory />;\n",
  }],
  ['star re-export paths', {
    'packages/app/src/unsupported/star.ts': "export * from '../a/Button';\n",
    'packages/app/src/unsupported/StarUse.tsx': "import { Button } from './star';\nexport const starUse = <Button />;\n",
  }],
  ['cyclic re-export paths', {
    'packages/app/src/unsupported/cycle-a.ts': "export { Button } from './cycle-b';\n",
    'packages/app/src/unsupported/cycle-b.ts': "export { Button } from './cycle-a';\n",
    'packages/app/src/unsupported/CycleUse.tsx': "import { Button } from './cycle-a';\nexport const cycleUse = <Button />;\n",
  }],
]) {
  test(`${name} remain outside wrapper investigation packets`, async (t) => {
    const fixture = await createWrapperInvestigationFixture(t);
    for (const [relative, content] of Object.entries(files)) await writeFixtureFile(fixture, relative, content);
    const output = path.join(scratch, `unsupported-${name.replaceAll(' ', '-')}-${Date.now()}`); const result = assess(fixture, output);
    assert.equal(result.status, 0, result.stderr); const assessment = await readAssessment(output);
    assert.equal(assessment.wrapperInvestigations.length, fixture.expected.packets);
    assert.ok(assessment.wrapperInvestigations.every((packet) => fixture.definitions.includes(packet.definition.file)));
    const linked = new Set(assessment.wrapperInvestigations.flatMap((packet) => packet.unknownIds));
    const unsupportedFiles = new Set(Object.keys(files));
    assert.ok(assessment.usageInventory.unsupported.filter((item) => unsupportedFiles.has(item.file)).every((item) => !linked.has(item.id)));
  });
}

test('trusted worker proxy accepts an unchanged valid wrapper assessment', async (t) => {
  const fixture = await createWrapperInvestigationFixture(t); const worker = path.join(scratch, 'workers', `worker-baseline-${Date.now()}.mjs`);
  const proxyUrl = new URL('./workers/_assessment-proxy.mjs', import.meta.url).href;
  await fs.writeFile(worker, `import { proxyAssessment } from ${JSON.stringify(proxyUrl)};\nawait proxyAssessment(() => {});\n`);
  const output = path.join(scratch, `worker-baseline-output-${Date.now()}`); const result = assess(fixture, output, ['--worker', worker]);
  assert.equal(result.status, 0, result.stderr); assert.equal((await readAssessment(output)).wrapperInvestigations.length, fixture.expected.packets);
});

test('wrapper packet forging fails closed without publishing or changing inputs', async (t) => {
  const revisionCode = (definitionEvidence = 'packet.definition.evidence[0]') => [
    "const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');",
    "const tuple = (item) => [item.file, item.sha256, item.startLine, item.endLine, item.quote];",
    "const compare = (left, right) => JSON.stringify(left) < JSON.stringify(right) ? -1 : JSON.stringify(left) > JSON.stringify(right) ? 1 : 0;",
    "const sourceDigest = assessment.sources.find((source) => source.id === packet.sourceId).identity.digest;",
    "const bindingTuples = packet.bindingEvidence.map(tuple).sort(compare);",
    "const unknownIds = [...packet.unknownIds].sort();",
    "const callTuples = assessment.usageInventory.unsupported.filter((item) => unknownIds.includes(item.id)).flatMap((item) => item.evidence.map(tuple)).sort(compare);",
    `packet.revision = digest([sourceDigest, tuple(${definitionEvidence}), bindingTuples, unknownIds, callTuples]);`,
  ].join(' ');
  const sameLineDefinitionForgery = [
    "const evidence = { ...packet.definition.evidence[0], quote: 'export const Unrelated = () => <span />;' };",
    "packet.definition = { file: packet.definition.file, name: 'Unrelated', evidence: [evidence] };",
    revisionCode('evidence'),
    "packet.id = 'wrapper:' + digest([packet.sourceId, packet.sourceExport, packet.definition.file, packet.definition.name]).slice(0, 20);",
  ].join(' ');
  const cases = [
    ['approved-status', "packet.status = 'approved';"],
    ['executable', 'packet.executable = true;'],
    ['revision', "packet.revision = '0'.repeat(64);"],
    ['source-mismatch', 'packet.sourceId = assessment.sources.find((source) => source.id !== packet.sourceId).id;'],
    ['foreign-inner', 'packet.innerUsageIds = [assessment.usageInventory.usages.find((usage) => usage.sourceId !== packet.sourceId).id];'],
    ['unknown-id', "packet.unknownIds = ['unknown:00000000000000000000'];"],
    ['duplicate-unknown', 'assessment.wrapperInvestigations[1].unknownIds.push(packet.unknownIds[0]);'],
    ['definition-coordinate', "packet.definition.file = 'packages/app/src/DirectSources.tsx';"],
    ['corrupt-definition-evidence', "packet.definition.evidence[0].sha256 = '0'.repeat(64);"],
    ['corrupt-binding-evidence', "packet.bindingEvidence[0].quote += ' forged';"],
    ['same-line-foreign-definition', sameLineDefinitionForgery],
    ['different-file-definition', (fixture) => [
      `const evidence = { ...packet.definition.evidence[0], file: ${JSON.stringify(fixture.decoy.file)}, sha256: ${JSON.stringify(fixture.decoy.sha256)}, startLine: ${fixture.decoy.line}, endLine: ${fixture.decoy.line}, quote: ${JSON.stringify(fixture.decoy.quote)} };`,
      "packet.definition = { file: evidence.file, name: 'Button', evidence: [evidence] };",
      revisionCode('evidence'),
      "packet.id = 'wrapper:' + digest([packet.sourceId, packet.sourceExport, packet.definition.file, packet.definition.name]).slice(0, 20);",
    ].join(' ')],
    ['locationless-linked-unknown', [
      "const linked = assessment.usageInventory.unsupported.find((item) => item.id === packet.unknownIds[0]);",
      "delete linked.file; delete linked.line; delete linked.column; delete linked.start; delete linked.end; linked.evidence = [];",
      revisionCode(),
    ].join(' ')],
  ];
  for (const [name, mutation] of cases) await t.test(`rejects ${name}`, async (st) => {
    const fixture = await createWrapperInvestigationFixture(st); const beforeDigest = await wrapperFixtureDigest(fixture.root);
    const mutationCode = typeof mutation === 'function' ? mutation(fixture) : mutation;
    const worker = path.join(scratch, 'workers', `worker-${name}-${Date.now()}.mjs`);
    const proxyUrl = new URL('./workers/_assessment-proxy.mjs', import.meta.url).href;
    await fs.writeFile(worker, `import { createHash } from 'node:crypto';\nimport { proxyAssessment } from ${JSON.stringify(proxyUrl)};\nawait proxyAssessment((assessment) => { const packet = assessment.wrapperInvestigations[0]; ${mutationCode} });\n`);
    const output = path.join(scratch, `forged-${name}-${Date.now()}`); const result = assess(fixture, output, ['--worker', worker]);
    assert.equal(result.status, 1, result.stderr); await assert.rejects(fs.lstat(output), { code: 'ENOENT' });
    assert.equal(await wrapperFixtureDigest(fixture.root), beforeDigest);
  });
});
