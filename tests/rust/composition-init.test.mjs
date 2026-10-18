import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCompositionFixture, treeDigest } from '../composition/fixture.mjs';

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

function bindings(fixture, ids = ['a', 'b']) {
  return ids.flatMap((id) => ['--source', `${id}=${fixture.sources[id].root}`]);
}

function run(args, cwd, env = process.env) {
  return spawnSync(binary, args, {
    cwd, env: { ...env }, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024,
  });
}

function initArgs(fixture, output, extra = []) {
  return ['compose', '--init', '--target', '@fixture/foundation', ...bindings(fixture),
    '--out', output, '--compiler', compiler, '--node', process.execPath, ...extra];
}

test('compose help documents both project and initialization forms', () => {
  const result = run(['compose', '--help'], repository);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /compose --project PROJECT\.json/);
  assert.match(result.stdout, /compose --init --target PACKAGE/);
  assert.match(result.stdout, /Use either --project or --init/);
});

test('compose init creates, pins, and round trips the minimal baseline project', async (t) => {
  const fixture = await createCompositionFixture(t);
  const first = path.join(fixture.root, 'initialized');
  const beforeSources = await Promise.all(['a', 'b'].map((id) => treeDigest(fixture.sources[id].root)));

  const initialized = run(initArgs(fixture, first), fixture.root);
  assert.equal(initialized.status, 0, initialized.stderr);

  const exported = JSON.parse(await fs.readFile(path.join(first, 'project.json'), 'utf8'));
  assert.deepEqual({ schemaVersion: exported.schemaVersion, kind: exported.kind }, {
    schemaVersion: 1, kind: 'rhubase-composition-project',
  });
  assert.equal(exported.title, 'Shared foundation');
  assert.deepEqual(exported.sources.map(({ id, declaredModes }) => ({ id, declaredModes })), [
    { id: 'a', declaredModes: [] }, { id: 'b', declaredModes: [] },
  ]);
  assert.ok(exported.sources.every((source) => /^[a-f0-9]{64}$/.test(source.digest)));
  assert.deepEqual(exported.scenarios, [{
    id: 'baseline',
    title: 'Baseline',
    includedSources: ['a', 'b'],
    target: { name: '@fixture/foundation', mode: 'new', baseSource: null },
    selections: [],
    dependencies: [],
    architecture: {
      layout: 'colocated', topology: 'single-package', delivery: 'minimal', deliverySource: null,
    },
  }]);

  const blueprint = JSON.parse(await fs.readFile(path.join(first, 'blueprint.json'), 'utf8'));
  assert.deepEqual(blueprint.sources.map((source) => ({ id: source.id, identity: source.identity })), [
    { id: 'a', identity: { name: '@fixture/a', version: '1.0.0' } },
    { id: 'b', identity: { name: '@fixture/b', version: '1.0.0' } },
  ]);
  assert.deepEqual(await Promise.all(['a', 'b'].map((id) => treeDigest(fixture.sources[id].root))), beforeSources);
  for (const id of ['a', 'b']) await assert.rejects(fs.lstat(fixture.sources[id].marker), { code: 'ENOENT' });

  const second = path.join(fixture.root, 'round-trip');
  const roundTrip = run(['compose', '--project', path.join(first, 'project.json'), ...bindings(fixture),
    '--out', second, '--compiler', compiler, '--node', process.execPath], fixture.root);
  assert.equal(roundTrip.status, 0, roundTrip.stderr);
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(second, 'project.json'), 'utf8')),
    exported,
  );
});

test('compose init enforces project, target, and source binding modes', async (t) => {
  const fixture = await createCompositionFixture(t);
  const cases = [
    ['project and init', ['compose', '--init', '--project', fixture.projectFile, '--target', '@fixture/foundation', ...bindings(fixture)]],
    ['target without init', ['compose', '--project', fixture.projectFile, '--target', '@fixture/foundation', ...bindings(fixture)]],
    ['init without target', ['compose', '--init', ...bindings(fixture)]],
    ['neither project nor init', ['compose', ...bindings(fixture)]],
  ];
  for (const [label, prefix] of cases) {
    const output = path.join(fixture.root, `invalid-${label.replaceAll(' ', '-')}`);
    const result = run([...prefix, '--out', output, '--compiler', compiler, '--node', process.execPath], fixture.root);
    assert.equal(result.status, 2, `${label}: ${result.stderr}`);
    await assert.rejects(fs.lstat(output), { code: 'ENOENT' });
  }
});

test('compose init rejects malformed and duplicate source IDs before publication', async (t) => {
  const fixture = await createCompositionFixture(t);
  const invalidBindings = [
    ['malformed', ['--source', `1a=${fixture.sources.a.root}`, '--source', `b=${fixture.sources.b.root}`]],
    ['duplicate', ['--source', `a=${fixture.sources.a.root}`, '--source', `a=${fixture.sources.b.root}`]],
  ];
  for (const [label, sourceArgs] of invalidBindings) {
    const output = path.join(fixture.root, `invalid-id-${label}`);
    const result = run(['compose', '--init', '--target', '@fixture/foundation', ...sourceArgs,
      '--out', output, '--compiler', compiler, '--node', process.execPath], fixture.root);
    assert.notEqual(result.status, 0, result.stderr);
    await assert.rejects(fs.lstat(output), { code: 'ENOENT' });
  }
});

test('compose init validates the target through the closed project contract', async (t) => {
  const fixture = await createCompositionFixture(t);
  const output = path.join(fixture.root, 'invalid-target');
  const result = run(['compose', '--init', '--target', '@Fixture/Uppercase', ...bindings(fixture),
    '--out', output, '--compiler', compiler, '--node', process.execPath], fixture.root);
  assert.notEqual(result.status, 0, result.stderr);
  assert.match(result.stderr, /lowercase npm-style package identity/i);
  await assert.rejects(fs.lstat(output), { code: 'ENOENT' });
});
