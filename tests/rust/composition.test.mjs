import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createCompositionFixture, createSource, fileMap, project, scenario, selection, treeDigest,
} from '../composition/fixture.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = path.join(repository, 'Cargo.toml');
const compiler = path.join(repository, 'node_modules/typescript/lib/typescript.js');
let binary;

before(() => {
  const build = spawnSync('cargo', ['build', '--locked', '--release', '--manifest-path', manifest, '--bin', 'ctrl-shift'], {
    cwd: os.tmpdir(), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(build.status, 0, build.stdout + build.stderr);
  binary = path.join(repository, 'target/release/ctrl-shift');
});

function bindings(fixture, ids = Object.keys(fixture.sources)) {
  return ids.flatMap((id) => ['--source', `${id}=${fixture.sources[id].root}`]);
}

function run(fixture, output, options = {}) {
  const args = ['compose', '--project', options.projectFile ?? fixture.projectFile,
    ...bindings(fixture, options.sourceIds ?? fixture.project.sources.map((source) => source.id)), '--out', output, '--compiler', compiler, '--node', process.execPath,
    ...(options.extra ?? [])];
  const env = { ...process.env, ...(options.env ?? {}) };
  for (const key of options.unsetEnv ?? []) delete env[key];
  return spawnSync(binary, args, { cwd: options.cwd ?? fixture.root, env, encoding: 'utf8', timeout: options.timeout ?? 30000, maxBuffer: 8 * 1024 * 1024 });
}

function composeArgv(fixture, output, projectFile = fixture.projectFile) {
  return ['compose', '--project', projectFile, ...bindings(fixture, fixture.project.sources.map((source) => source.id)),
    '--out', output, '--compiler', compiler, '--node', process.execPath];
}

function completion(child, timeoutMs = 10000) {
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return Promise.race([
    new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal, stderr }))),
    new Promise((_, reject) => setTimeout(() => reject(new Error('compose process did not exit')), timeoutMs)),
  ]);
}

async function saveProject(fixture, value, name = 'case-project.json') {
  const file = path.join(fixture.root, name);
  await fs.writeFile(file, JSON.stringify(value, null, 2));
  return file;
}

async function successfulRun(t, value, name = 'result') {
  const fixture = await createCompositionFixture(t);
  const projectFile = await saveProject(fixture, value);
  const output = path.join(fixture.root, name);
  const beforeSources = await Promise.all(Object.values(fixture.sources).map((item) => treeDigest(item.root)));
  const result = run(fixture, output, { projectFile, sourceIds: value.sources.map((source) => source.id) });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await Promise.all(Object.values(fixture.sources).map((item) => treeDigest(item.root))), beforeSources);
  for (const source of Object.values(fixture.sources)) await assert.rejects(fs.lstat(source.marker), { code: 'ENOENT' });
  return { fixture, output, blueprint: JSON.parse(await fs.readFile(path.join(output, 'blueprint.json'), 'utf8')) };
}

test('compose publishes a bounded non-executable A+B blueprint without a consumer or target package', async (t) => {
  const fixture = await createCompositionFixture(t);
  const beforeSources = await Promise.all(['a', 'b'].map((id) => treeDigest(fixture.sources[id].root)));
  const output = path.join(fixture.root, 'ab-output');
  const result = run(fixture, output);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual((await fs.readdir(output)).sort(), ['blueprint.json', 'manifest.json', 'project.json', 'review.md', 'workspace.html']);
  const blueprint = JSON.parse(await fs.readFile(path.join(output, 'blueprint.json'), 'utf8'));
  assert.deepEqual({ kind: blueprint.kind, schemaVersion: blueprint.schemaVersion, status: blueprint.status, executable: blueprint.executable, consumerImpact: blueprint.consumerImpact }, {
    kind: 'rhubase-composition-blueprint', schemaVersion: 1, status: 'draft-review', executable: false, consumerImpact: 'unmeasured',
  });
  assert.match(blueprint.projectRevision, /^[a-f0-9]{64}$/);
  assert.deepEqual(blueprint.sources.map((source) => source.id), ['a', 'b']);
  assert.equal(blueprint.scenarios[0].compatibility, 'unverified');
  assert.ok(blueprint.scenarios[0].checks.every((check) => check.status === 'not-run'));
  assert.ok(blueprint.limitations.some((item) => /consumer.*unmeasured/i.test(item)));
  assert.ok(blueprint.limitations.some((item) => /runtime|accessibility/i.test(item)));
  assert.doesNotMatch(JSON.stringify(blueprint), new RegExp(fixture.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const review = await fs.readFile(path.join(output, 'review.md'), 'utf8');
  assert.match(review, /Review a\/Button for the shared foundation\./);
  assert.match(review, /colocated/i);
  assert.match(review, /single-package/i);
  assert.match(review, /minimal/i);
  assert.deepEqual(await Promise.all(['a', 'b'].map((id) => treeDigest(fixture.sources[id].root))), beforeSources);
  for (const id of ['a', 'b']) await assert.rejects(fs.lstat(fixture.sources[id].marker), { code: 'ENOENT' });
});

test('compose exports bounded provenance for static facts and human-declared modes', async (t) => {
  const fixture = await createCompositionFixture(t);
  const output = path.join(fixture.root, 'provenance-output');
  const result = run(fixture, output); assert.equal(result.status, 0, result.stderr);
  const blueprint = JSON.parse(await fs.readFile(path.join(output, 'blueprint.json'), 'utf8'));
  const selections = Object.fromEntries(blueprint.scenarios[0].selections.map((item) => [item.id, item]));
  for (const id of ['a-button', 'b-color']) {
    assert.ok(selections[id].evidenceRefs.length > 0);
    for (const ref of selections[id].evidenceRefs) {
      assert.equal(ref.kind, 'static-source');
      assert.match(ref.sha256, /^[a-f0-9]{64}$/);
      assert.equal(path.isAbsolute(ref.file), false);
      assert.ok(ref.startLine >= 1 && ref.endLine >= ref.startLine);
      assert.deepEqual(Object.keys(ref).sort(), ['endLine', 'file', 'kind', 'sha256', 'sourceId', 'startLine']);
    }
  }
  assert.deepEqual(selections['b-dark'].evidenceRefs, [{
    kind: 'human-declaration', sourceId: 'b', projectRevision: blueprint.projectRevision,
  }]);
  assert.doesNotMatch(JSON.stringify(blueprint.scenarios[0].selections), /quote|sourceRoot|\/var\/|\/Users\//i);
});

test('compose keeps an excluded catalog source out of an A+B scenario while admitting an A+B+C scenario', async (t) => {
  const value = project(['a', 'b', 'c'], [
    scenario('ab', ['a', 'b'], [selection('a-button', 'a', 'component', 'Button'), selection('b-color', 'b', 'token', 'color.action')]),
    scenario('abc', ['a', 'b', 'c'], [selection('a-button-2', 'a', 'component', 'Button'), selection('b-color-2', 'b', 'token', 'color.action'), selection('c-card', 'c', 'component', 'Card')]),
  ]);
  const { blueprint } = await successfulRun(t, value);
  const ab = blueprint.scenarios.find((item) => item.id === 'ab');
  const abc = blueprint.scenarios.find((item) => item.id === 'abc');
  assert.deepEqual(ab.includedSources, ['a', 'b']);
  assert.equal(ab.selections.some((item) => item.source === 'c'), false);
  assert.deepEqual(abc.includedSources, ['a', 'b', 'c']);
  assert.ok(abc.selections.some((item) => item.source === 'c' && item.name === 'Card'));
});

test('compose evolves an included base source without claiming that a target was materialized', async (t) => {
  const value = project(['a', 'b'], [scenario('evolve', ['a', 'b'], [selection('a-button', 'a', 'component', 'Button')], {
    target: { name: '@fixture/foundation', mode: 'evolve', baseSource: 'a' },
  })]);
  const { blueprint } = await successfulRun(t, value);
  assert.deepEqual(blueprint.scenarios[0].target, { name: '@fixture/foundation', mode: 'evolve', baseSource: 'a' });
  assert.equal(blueprint.executable, false);
  assert.equal(blueprint.scenarios[0].checks.every((item) => item.status === 'not-run'), true);
});

test('compose reports same-kind target-name collisions without merging source identities', async (t) => {
  const fixture = await createCompositionFixture(t);
  const value = project(['a', 'b'], [scenario('collision', ['a', 'b'], [
    selection('a-button', 'a', 'component', 'Button', { targetName: 'Action' }),
    selection('b-button', 'b', 'component', 'Button', { targetName: 'Action' }),
  ])]);
  const projectFile = await saveProject(fixture, value);
  const output = path.join(fixture.root, 'collision-output');
  const result = run(fixture, output, { projectFile, sourceIds: ['a', 'b'], extra: ['--json'] });
  assert.equal(result.status, 0, result.stderr);
  const blueprint = JSON.parse(await fs.readFile(path.join(output, 'blueprint.json'), 'utf8'));
  assert.deepEqual(blueprint.scenarios[0].selections.map((item) => [item.source, item.name]), [['a', 'Button'], ['b', 'Button']]);
  assert.ok(blueprint.scenarios[0].blockers.some((item) => item.kind === 'target-name-conflict' && item.selectionIds.includes('a-button') && item.selectionIds.includes('b-button')));
  assert.ok(blueprint.scenarios[0].unresolvedManualWork.some((item) => /target|conflict|blocker/i.test(item)));
  const summary = JSON.parse(result.stdout);
  assert.ok(summary.counts.blockers >= 1);
  const review = await fs.readFile(path.join(output, 'review.md'), 'utf8');
  assert.match(review, /Blockers:\s*[1-9]/i);
  assert.match(review, /target name|Action|conflict/i);
});

test('compose source coverage counts distinct selected capabilities across scenarios', async (t) => {
  const value = project(['a', 'b', 'c'], [
    scenario('ab', ['a', 'b'], [
      selection('ab-button', 'a', 'component', 'Button'),
      selection('ab-color', 'a', 'token', 'color.action'),
    ]),
    scenario('abc', ['a', 'b', 'c'], [
      selection('abc-button', 'a', 'component', 'Button'),
      selection('abc-color', 'a', 'token', 'color.action'),
    ]),
  ]);
  const { blueprint } = await successfulRun(t, value);
  const coverage = blueprint.sources.find((source) => source.id === 'a').coverage;
  assert.equal(coverage.components.selected, 1);
  assert.ok(coverage.components.selected <= coverage.components.eligible);
  assert.equal(coverage.tokens.selected, 1);
  assert.ok(coverage.tokens.selected <= coverage.tokens.eligible);
});

test('compose source coverage does not count requested capabilities absent from established facts', async (t) => {
  const value = project(['a', 'b'], [scenario('missing-facts', ['a', 'b'], [
    selection('missing-component', 'a', 'component', 'MissingComponent'),
    selection('missing-token', 'a', 'token', 'missing.token'),
  ])]);
  const { blueprint } = await successfulRun(t, value);
  const source = blueprint.sources.find((item) => item.id === 'a');
  assert.equal(source.coverage.components.selected, 0);
  assert.equal(source.coverage.tokens.selected, 0);
  assert.equal(blueprint.scenarios[0].retainedCounts.components, 0);
  assert.equal(blueprint.scenarios[0].retainedCounts.tokens, 0);
  assert.ok(blueprint.scenarios[0].blockers.filter((item) => item.kind === 'unsupported-selection').length >= 2);
});

test('compose reports malformed token files as unsupported and blocks requested token facts', async (t) => {
  const fixture = await createCompositionFixture(t);
  await fs.writeFile(path.join(fixture.sources.a.root, 'tokens.json'), '{ malformed');
  const value = project(['a', 'b'], [scenario('malformed-token', ['a', 'b'], [
    selection('a-color', 'a', 'token', 'color.action'),
  ])]);
  const projectFile = await saveProject(fixture, value);
  const output = path.join(fixture.root, 'malformed-token-output');
  const result = run(fixture, output, { projectFile }); assert.equal(result.status, 0, result.stderr);
  const blueprint = JSON.parse(await fs.readFile(path.join(output, 'blueprint.json'), 'utf8'));
  const source = blueprint.sources.find((item) => item.id === 'a');
  assert.ok(source.coverage.tokens.unsupported > 0);
  assert.equal(source.coverage.tokens.selected, 0);
  assert.ok(blueprint.scenarios[0].blockers.some((item) => item.kind === 'unsupported-selection' && item.selectionIds.includes('a-color')));
});

test('compose treats an evidence-named property inside a token value as raw token data', async (t) => {
  const fixture = await createCompositionFixture(t);
  await fs.writeFile(path.join(fixture.sources.a.root, 'tokens.json'), JSON.stringify({
    semantic: { visual: { $type: 'custom', $value: { evidence: 'visual', palette: 'red' } } },
  }, null, 2));
  const value = project(['a', 'b'], [scenario('raw-token-data', ['a', 'b'], [
    selection('visual', 'a', 'token', 'semantic.visual'),
  ])]);
  const projectFile = await saveProject(fixture, value);
  const output = path.join(fixture.root, 'raw-token-data-output');
  const result = run(fixture, output, { projectFile }); assert.equal(result.status, 0, result.stderr);
  const blueprint = JSON.parse(await fs.readFile(path.join(output, 'blueprint.json'), 'utf8'));
  assert.equal(blueprint.scenarios[0].retainedCounts.tokens, 1);
  assert.equal(blueprint.scenarios[0].blockers.some((item) => item.selectionIds.includes('visual')), false);
  assert.ok(blueprint.scenarios[0].selections[0].evidenceRefs.some((ref) => ref.kind === 'static-source'));
});

test('compose includes unsupported entrypoint shapes in component coverage without false selection', async (t) => {
  const fixture = await createCompositionFixture(t);
  const manifestFile = path.join(fixture.sources.a.root, 'package.json');
  const manifestValue = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  manifestValue.exports = { '.': { types: './index.d.ts' }, './ambiguous': [{ types: './missing.d.ts' }] };
  await fs.writeFile(manifestFile, JSON.stringify(manifestValue, null, 2));
  const value = project(['a', 'b'], [scenario('unsupported-entrypoint', ['a', 'b'], [
    selection('unknown-component', 'a', 'component', 'UnknownComponent'),
  ])]);
  const projectFile = await saveProject(fixture, value);
  const output = path.join(fixture.root, 'unsupported-entrypoint-output');
  const result = run(fixture, output, { projectFile }); assert.equal(result.status, 0, result.stderr);
  const blueprint = JSON.parse(await fs.readFile(path.join(output, 'blueprint.json'), 'utf8'));
  const source = blueprint.sources.find((item) => item.id === 'a');
  assert.ok(source.coverage.components.unsupported > 0);
  assert.equal(source.coverage.components.selected, 0);
  assert.ok(blueprint.scenarios[0].blockers.some((item) => item.kind === 'unsupported-selection' && item.selectionIds.includes('unknown-component')));
});

test('compose reports dependencies whose target is excluded as blockers', async (t) => {
  const value = project(['a', 'b'], [scenario('dependency', ['a', 'b'], [
    selection('consumer', 'a', 'component', 'Button'),
    selection('primitive', 'b', 'token', 'color.action', { disposition: 'exclude' }),
  ], { dependencies: [{ from: 'consumer', to: 'primitive', rationale: 'Button requires the selected action color.' }] })]);
  const { blueprint } = await successfulRun(t, value);
  assert.ok(blueprint.scenarios[0].blockers.some((item) => item.kind === 'dependency-target-unavailable' && item.selectionIds.includes('primitive')));
  assert.deepEqual(blueprint.scenarios[0].retainedCounts, { components: 1, tokens: 0, modes: 0 });
});

test('compose reports declared dependency cycles as unresolved ordering blockers', async (t) => {
  const value = project(['a', 'b'], [scenario('cycle', ['a', 'b'], [
    selection('one', 'a', 'component', 'Button'), selection('two', 'b', 'component', 'Button'),
  ], { dependencies: [
    { from: 'one', to: 'two', rationale: 'One needs two.' },
    { from: 'two', to: 'one', rationale: 'Two needs one.' },
  ] })]);
  const { blueprint } = await successfulRun(t, value);
  assert.ok(blueprint.scenarios[0].blockers.some((item) => item.kind === 'dependency-cycle'));
  assert.equal(blueprint.scenarios[0].compatibility, 'unverified');
});

test('compose reports unresolved and cyclic same-source token aliases without cross-source resolution', async (t) => {
  const fixture = await createCompositionFixture(t);
  await fs.writeFile(path.join(fixture.sources.a.root, 'tokens.json'), JSON.stringify({
    missing: { $value: '{color.absent}', $type: 'color' },
    loop: { one: { $value: '{loop.two}' }, two: { $value: '{loop.one}' } },
  }, null, 2));
  const value = project(['a', 'b'], [scenario('aliases', ['a', 'b'], [
    selection('missing', 'a', 'token', 'missing'),
    selection('one', 'a', 'token', 'loop.one'),
    selection('two', 'a', 'token', 'loop.two'),
    selection('other-source', 'b', 'token', 'color.action'),
  ])]);
  const projectFile = await saveProject(fixture, value);
  const output = path.join(fixture.root, 'aliases-output');
  const result = run(fixture, output, { projectFile, sourceIds: value.sources.map((source) => source.id) });
  assert.equal(result.status, 0, result.stderr);
  const blueprint = JSON.parse(await fs.readFile(path.join(output, 'blueprint.json'), 'utf8'));
  assert.ok(blueprint.scenarios[0].blockers.some((item) => item.kind === 'token-alias-unresolved' && item.selectionIds.includes('missing')));
  assert.ok(blueprint.scenarios[0].blockers.some((item) => item.kind === 'token-alias-cycle'));
});

test('compose labels declared modes as human declarations and never verified theme support', async (t) => {
  const fixture = await createCompositionFixture(t);
  const output = path.join(fixture.root, 'modes-output');
  const result = run(fixture, output);
  assert.equal(result.status, 0, result.stderr);
  const blueprint = JSON.parse(await fs.readFile(path.join(output, 'blueprint.json'), 'utf8'));
  const b = blueprint.sources.find((source) => source.id === 'b');
  assert.deepEqual(b.coverage.modes, { declared: ['light', 'dark'], selected: ['dark'], verified: false });
  assert.ok(blueprint.limitations.some((item) => /mode.*human.*declar|declar.*mode.*unverif/i.test(item)));
});

for (const layout of ['colocated', 'by-kind']) for (const topology of ['single-package', 'workspace']) for (const delivery of ['minimal', 'preserve']) {
  test(`compose previews ${layout}, ${topology}, ${delivery} independently with checks not run`, async (t) => {
    const architecture = { layout, topology, delivery, deliverySource: delivery === 'preserve' ? 'a' : null };
    const value = project(['a', 'b'], [scenario('architecture', ['a', 'b'], [selection('a-button', 'a', 'component', 'Button')], { architecture })]);
    const { blueprint } = await successfulRun(t, value, `${layout}-${topology}-${delivery}`);
    const result = blueprint.scenarios[0].architecture;
    assert.deepEqual(result.selection, architecture);
    assert.equal(result.preview.layout.kind, layout);
    assert.equal(result.preview.topology.kind, topology);
    assert.equal(result.preview.delivery.kind, delivery);
    assert.equal(result.preview.delivery.verificationRequired, true);
    assert.ok(result.preview.obligations.length > 0);
    assert.ok(result.preview.obligations.every((item) => item.status === 'not-run'));
  });
}

test('compose derives valid sibling package IDs for a scoped workspace target', async (t) => {
  const value = project(['a', 'b'], [scenario('scoped-workspace', ['a', 'b'], [selection('a-button', 'a', 'component', 'Button')], {
    target: { name: '@fixture/foundation', mode: 'new', baseSource: null },
    architecture: { layout: 'by-kind', topology: 'workspace', delivery: 'minimal', deliverySource: null },
  })]);
  const { blueprint } = await successfulRun(t, value);
  assert.deepEqual(blueprint.scenarios[0].architecture.preview.topology.packages, [
    '@fixture/foundation-components', '@fixture/foundation-tokens', '@fixture/foundation-themes',
  ]);
});

test('compose derives valid sibling package IDs for an unscoped workspace target', async (t) => {
  const value = project(['a', 'b'], [scenario('unscoped-workspace', ['a', 'b'], [selection('a-button', 'a', 'component', 'Button')], {
    target: { name: 'foundation', mode: 'new', baseSource: null },
    architecture: { layout: 'by-kind', topology: 'workspace', delivery: 'minimal', deliverySource: null },
  })]);
  const { blueprint } = await successfulRun(t, value);
  assert.deepEqual(blueprint.scenarios[0].architecture.preview.topology.packages, [
    'foundation-components', 'foundation-tokens', 'foundation-themes',
  ]);
});

for (const targetName of ['Foundation', '@fixture/Foundation', '@fixture', 'fixture/name']) {
  test(`compose rejects target package name ${targetName} outside the supported profile`, async (t) => {
    const fixture = await createCompositionFixture(t);
    const value = project(['a', 'b'], [scenario('invalid-target', ['a', 'b'], [selection('a-button', 'a', 'component', 'Button')], {
      target: { name: targetName, mode: 'new', baseSource: null },
    })]);
    const projectFile = await saveProject(fixture, value);
    const output = path.join(fixture.root, 'invalid-target-output');
    const result = run(fixture, output, { projectFile });
    assert.notEqual(result.status, 0);
    await assert.rejects(fs.lstat(output), { code: 'ENOENT' });
  });
}

test('compose is canonical across output directories and exported pinned project round trips', async (t) => {
  const fixture = await createCompositionFixture(t);
  const first = path.join(fixture.root, 'canonical-one');
  const firstRun = run(fixture, first); assert.equal(firstRun.status, 0, firstRun.stderr);
  const second = path.join(fixture.root, 'canonical-two');
  const secondRun = run(fixture, second, { projectFile: path.join(first, 'project.json') }); assert.equal(secondRun.status, 0, secondRun.stderr);
  assert.deepEqual(await fileMap(second), await fileMap(first));
  const exported = JSON.parse(await fs.readFile(path.join(first, 'project.json'), 'utf8'));
  assert.ok(exported.sources.every((source) => /^[a-f0-9]{64}$/.test(source.digest)));
  assert.doesNotMatch(JSON.stringify(exported), new RegExp(fixture.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('compose rejects stale exported source pins without publishing', async (t) => {
  const fixture = await createCompositionFixture(t);
  const first = path.join(fixture.root, 'pin-source');
  assert.equal(run(fixture, first).status, 0);
  await fs.appendFile(path.join(fixture.sources.a.root, 'index.d.ts'), 'export declare function Added(): unknown;\n');
  const output = path.join(fixture.root, 'stale-output');
  const result = run(fixture, output, { projectFile: path.join(first, 'project.json') });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /stale|digest|pin/i);
  await assert.rejects(fs.lstat(output), { code: 'ENOENT' });
});

for (const [label, mutate] of [
  ['unknown project fields', (value) => { value.unexpected = true; }],
  ['forged approval fields', (value) => { value.scenarios[0].selections[0].approved = true; }],
  ['unsupported combine dispositions', (value) => { value.scenarios[0].selections[0].disposition = 'combine'; }],
  ['too many declared modes', (value) => { value.sources[1].declaredModes = Array.from({ length: 17 }, (_, index) => `mode-${index}`); }],
]) {
  test(`compose rejects ${label} under the closed bounded schema`, async (t) => {
    const fixture = await createCompositionFixture(t);
    const value = structuredClone(fixture.project); mutate(value);
    const projectFile = await saveProject(fixture, value);
    const output = path.join(fixture.root, `rejected-${label.replaceAll(' ', '-')}`);
    const result = run(fixture, output, { projectFile });
    assert.notEqual(result.status, 0);
    await assert.rejects(fs.lstat(output), { code: 'ENOENT' });
  });
}

for (const [label, omit] of [
  ['source digest', (value) => { delete value.sources[0].digest; }],
  ['target baseSource', (value) => { delete value.scenarios[0].target.baseSource; }],
  ['architecture deliverySource', (value) => { delete value.scenarios[0].architecture.deliverySource; }],
]) {
  test(`compose rejects an omitted mandatory nullable ${label} field`, async (t) => {
    const fixture = await createCompositionFixture(t);
    const value = structuredClone(fixture.project); omit(value);
    const projectFile = await saveProject(fixture, value, `missing-${label.replaceAll(' ', '-')}.json`);
    const output = path.join(fixture.root, `missing-${label.replaceAll(' ', '-')}-output`);
    const result = run(fixture, output, { projectFile });
    assert.notEqual(result.status, 0);
    await assert.rejects(fs.lstat(output), { code: 'ENOENT' });
  });
}

test('compose refuses existing, source-contained, project-overwrite and compiler-contained outputs', async (t) => {
  const fixture = await createCompositionFixture(t);
  const existing = path.join(fixture.root, 'existing'); await fs.mkdir(existing); await fs.writeFile(path.join(existing, 'owner'), 'owner');
  assert.notEqual(run(fixture, existing).status, 0); assert.equal(await fs.readFile(path.join(existing, 'owner'), 'utf8'), 'owner');
  const sourceContained = path.join(fixture.sources.a.root, 'out'); assert.notEqual(run(fixture, sourceContained).status, 0); await assert.rejects(fs.lstat(sourceContained), { code: 'ENOENT' });
  assert.notEqual(run(fixture, fixture.projectFile).status, 0); assert.equal(JSON.parse(await fs.readFile(fixture.projectFile, 'utf8')).kind, 'rhubase-composition-project');
  const compilerContained = path.join(path.dirname(compiler), 'composition-output'); assert.notEqual(run(fixture, compilerContained).status, 0); await assert.rejects(fs.lstat(compilerContained), { code: 'ENOENT' });
});

test('compose rejects symlink source roots and outputs that traverse a source alias', async (t) => {
  const fixture = await createCompositionFixture(t);
  const alias = path.join(fixture.root, 'source-a-alias');
  try { await fs.symlink(fixture.sources.a.root, alias, 'dir'); } catch (error) { if (error.code === 'EPERM') return t.skip('directory symlinks unavailable'); throw error; }
  const original = fixture.sources.a.root; fixture.sources.a.root = alias;
  const rejectedSource = path.join(fixture.root, 'alias-source-output'); assert.notEqual(run(fixture, rejectedSource).status, 0); await assert.rejects(fs.lstat(rejectedSource), { code: 'ENOENT' });
  fixture.sources.a.root = original;
  const aliasedOutput = path.join(alias, 'nested-output'); assert.notEqual(run(fixture, aliasedOutput).status, 0); await assert.rejects(fs.lstat(path.join(original, 'nested-output')), { code: 'ENOENT' });
});

test('compose publishes nothing when a source changes during extraction', { skip: process.platform === 'win32' }, async (t) => {
  const fixture = await createCompositionFixture(t);
  const output = path.join(fixture.root, 'source-race-output');
  const child = spawn(binary, composeArgv(fixture, output), { cwd: fixture.root, env: { ...process.env }, stdio: ['ignore', 'ignore', 'pipe'] });
  let counter = 0;
  const timer = setInterval(() => { fs.appendFile(path.join(fixture.sources.a.root, 'index.d.ts'), `// race ${counter++}\n`).catch(() => {}); }, 5);
  const result = await completion(child); clearInterval(timer);
  assert.notEqual(result.code, 0, result.stderr);
  await assert.rejects(fs.lstat(output), { code: 'ENOENT' });
});

test('compose publishes nothing when the project changes during extraction', { skip: process.platform === 'win32' }, async (t) => {
  const fixture = await createCompositionFixture(t);
  const output = path.join(fixture.root, 'project-race-output');
  const child = spawn(binary, composeArgv(fixture, output), { cwd: fixture.root, env: { ...process.env }, stdio: ['ignore', 'ignore', 'pipe'] });
  let counter = 0;
  const timer = setInterval(() => {
    const changed = { ...fixture.project, title: `Changed while running ${counter++}` };
    fs.writeFile(fixture.projectFile, JSON.stringify(changed)).catch(() => {});
  }, 5);
  const result = await completion(child); clearInterval(timer);
  assert.notEqual(result.code, 0, result.stderr);
  await assert.rejects(fs.lstat(output), { code: 'ENOENT' });
});

test('compose handles SIGINT without publishing a partial directory', { skip: process.platform === 'win32' }, async (t) => {
  const fixture = await createCompositionFixture(t);
  const output = path.join(fixture.root, 'cancelled-output');
  const child = spawn(binary, composeArgv(fixture, output), { cwd: fixture.root, env: { ...process.env }, stdio: ['ignore', 'ignore', 'pipe'] });
  setTimeout(() => child.kill('SIGINT'), 100);
  const result = await completion(child);
  assert.equal(result.code, 130, result.stderr);
  await assert.rejects(fs.lstat(output), { code: 'ENOENT' });
});

test('compose rejects custom workers and hostile NODE_OPTIONS before inspecting sources', async (t) => {
  const fixture = await createCompositionFixture(t);
  const workerOutput = path.join(fixture.root, 'worker-output');
  const customWorker = run(fixture, workerOutput, { extra: ['--worker', path.join(repository, 'src/infer-worker.mjs')] });
  assert.equal(customWorker.status, 2); await assert.rejects(fs.lstat(workerOutput), { code: 'ENOENT' });
  const envOutput = path.join(fixture.root, 'env-output');
  const hostileEnv = run(fixture, envOutput, { env: { NODE_OPTIONS: '--require=/definitely/missing.js' } });
  assert.notEqual(hostileEnv.status, 0); await assert.rejects(fs.lstat(envOutput), { code: 'ENOENT' });
});

test('compose requires one explicit binding for every catalog source', async (t) => {
  const fixture = await createCompositionFixture(t);
  const missingOutput = path.join(fixture.root, 'missing-binding');
  const missing = run(fixture, missingOutput, { sourceIds: ['a'] });
  assert.notEqual(missing.status, 0); await assert.rejects(fs.lstat(missingOutput), { code: 'ENOENT' });
  const duplicateOutput = path.join(fixture.root, 'duplicate-binding');
  const duplicate = spawnSync(binary, ['compose', '--project', fixture.projectFile,
    '--source', `a=${fixture.sources.a.root}`, '--source', `a=${fixture.sources.a.root}`, '--source', `b=${fixture.sources.b.root}`,
    '--out', duplicateOutput, '--compiler', compiler, '--node', process.execPath], {
    cwd: fixture.root, env: { ...process.env }, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024,
  });
  assert.notEqual(duplicate.status, 0); await assert.rejects(fs.lstat(duplicateOutput), { code: 'ENOENT' });
});

test('compose rejects distinct source IDs bound to the same real directory', async (t) => {
  const fixture = await createCompositionFixture(t);
  const output = path.join(fixture.root, 'same-root');
  const result = spawnSync(binary, ['compose', '--project', fixture.projectFile,
    '--source', `a=${fixture.sources.a.root}`, '--source', `b=${fixture.sources.a.root}`,
    '--out', output, '--compiler', compiler, '--node', process.execPath], {
    cwd: fixture.root, env: { ...process.env }, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024,
  });
  assert.notEqual(result.status, 0); await assert.rejects(fs.lstat(output), { code: 'ENOENT' });
});

test('compose rejects selections for excluded sources and evolve targets with invalid bases', async (t) => {
  const fixture = await createCompositionFixture(t);
  const excluded = project(['a', 'b', 'c'], [scenario('ab', ['a', 'b'], [selection('c-card', 'c', 'component', 'Card')])]);
  let projectFile = await saveProject(fixture, excluded, 'excluded-selection.json');
  let output = path.join(fixture.root, 'excluded-selection-output');
  assert.notEqual(run(fixture, output, { projectFile, sourceIds: ['a', 'b', 'c'] }).status, 0); await assert.rejects(fs.lstat(output), { code: 'ENOENT' });
  const invalidBase = project(['a', 'b', 'c'], [scenario('bad-base', ['a', 'b'], [selection('a-button', 'a', 'component', 'Button')], {
    target: { name: '@fixture/foundation', mode: 'evolve', baseSource: 'c' },
  })]);
  projectFile = await saveProject(fixture, invalidBase, 'invalid-base.json');
  output = path.join(fixture.root, 'invalid-base-output');
  assert.notEqual(run(fixture, output, { projectFile, sourceIds: ['a', 'b', 'c'] }).status, 0); await assert.rejects(fs.lstat(output), { code: 'ENOENT' });
});

test('compose enforces the eight-source catalog bound', async (t) => {
  const fixture = await createCompositionFixture(t);
  for (const id of ['d', 'e', 'f', 'g', 'h', 'i']) fixture.sources[id] = await createSource(fixture.root, id);
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
  const value = project(ids, [scenario('ab', ['a', 'b'], [selection('a-button', 'a', 'component', 'Button')])]);
  const projectFile = await saveProject(fixture, value, 'too-many-sources.json');
  const output = path.join(fixture.root, 'too-many-sources-output');
  const result = run(fixture, output, { projectFile, sourceIds: ids });
  assert.notEqual(result.status, 0); await assert.rejects(fs.lstat(output), { code: 'ENOENT' });
});

test('compose manifest authenticates each bounded artifact and excludes source bodies', async (t) => {
  const fixture = await createCompositionFixture(t);
  const output = path.join(fixture.root, 'manifest-output');
  const result = run(fixture, output); assert.equal(result.status, 0, result.stderr);
  const manifestValue = JSON.parse(await fs.readFile(path.join(output, 'manifest.json'), 'utf8'));
  assert.equal(manifestValue.kind, 'rhubase-composition-artifact-manifest');
  assert.deepEqual(manifestValue.files.map((item) => item.path).sort(), ['blueprint.json', 'project.json', 'review.md', 'workspace.html']);
  for (const item of manifestValue.files) {
    const bytes = await fs.readFile(path.join(output, item.path));
    assert.equal(bytes.length, item.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), item.sha256);
  }
  const exported = Buffer.concat(Object.values(await fileMap(output))).toString('utf8');
  assert.doesNotMatch(exported, /RHUBASE_COMPOSITION_SCRIPT_MUST_NOT_RUN/);
  for (const id of ['a', 'b']) {
    for (const name of ['index.d.ts', 'runtime.js']) {
      const body = (await fs.readFile(path.join(fixture.sources[id].root, name), 'utf8')).trim();
      assert.equal(exported.includes(body), false, `must not export the source body ${id}/${name}`);
    }
  }
});
