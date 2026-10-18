import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createCompositionFixture, project, scenario, selection,
} from '../composition/fixture.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = path.join(repository, 'Cargo.toml');
const compiler = path.join(repository, 'node_modules/typescript/lib/typescript.js');
let binary;

before(() => {
  binary = path.join(repository, 'target/release/ctrl-shift');
  if (process.env.RHUBASE_TEST_EXISTING_BINARY === '1') return;
  const build = spawnSync('cargo', ['build', '--locked', '--release', '--manifest-path', manifest, '--bin', 'ctrl-shift'], {
    cwd: os.tmpdir(), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(build.status, 0, build.stdout + build.stderr);
});

async function compose(t, value, mutate = async () => {}) {
  const fixture = await createCompositionFixture(t);
  await mutate(fixture);
  const projectFile = path.join(fixture.root, 'workspace-project.json');
  const output = path.join(fixture.root, 'workspace-output');
  await fs.writeFile(projectFile, JSON.stringify(value, null, 2));
  const bindings = value.sources.flatMap(({ id }) => ['--source', `${id}=${fixture.sources[id].root}`]);
  const result = spawnSync(binary, [
    'compose', '--project', projectFile, ...bindings, '--out', output,
    '--compiler', compiler, '--node', process.execPath,
  ], { cwd: fixture.root, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  return {
    blueprint: JSON.parse(await fs.readFile(path.join(output, 'blueprint.json'), 'utf8')),
    review: await fs.readFile(path.join(output, 'review.md'), 'utf8'),
  };
}

test('compose publishes a bounded capability catalog with observed, declared, and unsupported status', async (t) => {
  const value = project(['a', 'b'], [scenario('baseline', ['a', 'b'], [])]);
  const { blueprint, review } = await compose(t, value, async (fixture) => {
    await fs.writeFile(path.join(fixture.sources.a.root, 'index.d.ts'), [
      'export declare function Button(props: { label?: string }): unknown;',
      'export declare function Broken(props: { label?: string }): unknown;',
      'export declare function Ghost(props: {',
    ].join('\n'));
  });

  const a = blueprint.sources.find((source) => source.id === 'a');
  const b = blueprint.sources.find((source) => source.id === 'b');
  assert.ok(a.capabilities.some((item) => item.kind === 'component' && item.name === 'Button' && item.status === 'unsupported'));
  assert.ok(a.capabilities.some((item) => item.kind === 'token' && item.name === 'color.action' && item.status === 'observed'));
  assert.ok(b.capabilities.some((item) => item.kind === 'mode' && item.name === 'dark' && item.status === 'human-declared'));
  for (const source of blueprint.sources) for (const capability of source.capabilities) {
    assert.deepEqual(Object.keys(capability).sort(), ['evidenceRefs', 'kind', 'name', 'status']);
    assert.ok(capability.evidenceRefs.length > 0);
  }
  assert.doesNotMatch(JSON.stringify(blueprint.sources), /export declare|sourceRoot|\/Users\//);
  assert.match(review, /Capability catalog/);
  assert.match(review, /human-declared/);
  assert.match(review, /unsupported/);
});

test('duplicate static capability names remain visible but unsupported', async (t) => {
  const value = project(['a', 'b'], [scenario('baseline', ['a', 'b'], [])]);
  const { blueprint } = await compose(t, value, async (fixture) => {
    const manifestFile = path.join(fixture.sources.a.root, 'package.json');
    const manifestValue = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
    manifestValue.exports = {
      '.': { types: './index.d.ts' },
      './alternate': { types: './alternate.d.ts' },
    };
    await fs.writeFile(manifestFile, JSON.stringify(manifestValue, null, 2));
    await fs.writeFile(path.join(fixture.sources.a.root, 'alternate.d.ts'), 'export declare function Button(props: { tone?: string }): unknown;\n');
  });
  const buttons = blueprint.sources.find((source) => source.id === 'a').capabilities
    .filter((item) => item.kind === 'component' && item.name === 'Button');
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].status, 'unsupported');
  assert.ok(buttons[0].evidenceRefs.length >= 2);
});

test('compose compares every later scenario with the first baseline using semantic identities', async (t) => {
  const baseline = scenario('baseline', ['a', 'b'], [
    selection('shared', 'a', 'component', 'Button'),
    selection('old', 'b', 'token', 'color.action'),
  ], {
    dependencies: [{ from: 'shared', to: 'old', rationale: 'Button uses the action token.' }],
  });
  const alternative = scenario('alternative', ['c', 'b'], [
    selection('new', 'b', 'mode', 'dark'),
    selection('shared', 'c', 'component', 'Button', { targetName: 'Action', disposition: 'adapt', rationale: 'Use the pressed-state contract.' }),
  ], {
    target: { name: '@fixture/evolved-foundation', mode: 'evolve', baseSource: 'c' },
    dependencies: [{ from: 'shared', to: 'new', rationale: 'Button needs the declared mode.' }],
    architecture: { layout: 'by-kind', topology: 'workspace', delivery: 'preserve', deliverySource: 'c' },
  });
  const { blueprint, review } = await compose(t, project(['a', 'b', 'c'], [baseline, alternative]));

  assert.equal(blueprint.comparisons.length, 1);
  const comparison = blueprint.comparisons[0];
  assert.deepEqual(Object.keys(comparison).sort(), [
    'architectureChanges', 'baselineScenario', 'blockerCounts', 'dependencyChanges',
    'scenario', 'selectionChanges', 'sourceChanges', 'targetChanged',
  ]);
  assert.equal(comparison.baselineScenario, 'baseline');
  assert.equal(comparison.scenario, 'alternative');
  assert.deepEqual(comparison.sourceChanges, { added: ['c'], removed: ['a'] });
  assert.equal(comparison.targetChanged, true);
  assert.deepEqual(comparison.architectureChanges, ['layout', 'topology', 'delivery', 'deliverySource']);
  assert.deepEqual(comparison.selectionChanges.map(({ id, change }) => [id, change]), [
    ['new', 'added'], ['old', 'removed'], ['shared', 'changed'],
  ]);
  assert.equal(comparison.selectionChanges.find(({ id }) => id === 'shared').before.source, 'a');
  assert.equal(comparison.selectionChanges.find(({ id }) => id === 'shared').after.source, 'c');
  assert.equal('evidenceRefs' in comparison.selectionChanges.find(({ id }) => id === 'shared').before, false);
  assert.deepEqual(comparison.dependencyChanges, {
    added: [{ from: 'shared', to: 'new', rationale: 'Button needs the declared mode.' }],
    removed: [{ from: 'shared', to: 'old', rationale: 'Button uses the action token.' }],
  });
  assert.deepEqual(Object.keys(comparison.blockerCounts).sort(), ['after', 'before']);
  assert.match(review, /Scenario comparisons/);
  assert.match(review, /alternative.*baseline/i);
  assert.match(review, /Source changes.*added c.*removed a/is);
  assert.match(review, /Architecture changes.*layout.*topology.*delivery.*deliverySource/is);
});

test('scenario comparison ignores display titles and collection ordering', async (t) => {
  const selections = [
    selection('a-button', 'a', 'component', 'Button'),
    selection('b-color', 'b', 'token', 'color.action'),
  ];
  const dependencies = [
    { from: 'a-button', to: 'b-color', rationale: 'First dependency.' },
    { from: 'b-color', to: 'a-button', rationale: 'Second dependency.' },
  ];
  const baseline = scenario('baseline', ['a', 'b'], selections, { title: 'Baseline', dependencies });
  const reordered = scenario('reordered', ['b', 'a'], [...selections].reverse(), {
    title: 'A different display title', dependencies: [...dependencies].reverse(),
  });
  const { blueprint } = await compose(t, project(['a', 'b'], [baseline, reordered]));
  assert.deepEqual(blueprint.comparisons[0], {
    baselineScenario: 'baseline', scenario: 'reordered',
    sourceChanges: { added: [], removed: [] }, targetChanged: false,
    architectureChanges: [], selectionChanges: [],
    dependencyChanges: { added: [], removed: [] },
    blockerCounts: { before: blueprint.scenarios[0].blockers.length, after: blueprint.scenarios[1].blockers.length },
  });
});
