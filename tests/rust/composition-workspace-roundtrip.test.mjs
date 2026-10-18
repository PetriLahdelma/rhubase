import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCompositionFixture, project, scenario, selection, treeDigest } from '../composition/fixture.mjs';
import { applyWorkspaceAction, createWorkspaceState, serializeProject, validateProjectImport } from '../../src/composition-workspace.mjs';

const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const binary = path.join(checkout, 'target/release/ctrl-shift');
const compiler = path.join(checkout, 'node_modules/typescript/lib/typescript.js');

before(() => {
  const result = spawnSync('cargo', ['build', '--release', '--locked', '--offline', '--bin', 'ctrl-shift'], { cwd: checkout, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('actual CLI catalog -> editor branch/exclude/export -> CLI preserves the missing prerequisite', async (t) => {
  const fixture = await createCompositionFixture(t);
  const original = project(['a', 'b', 'c'], [scenario('abc', ['a', 'b', 'c'], [
    selection('button', 'a', 'component', 'Button'),
    selection('color', 'b', 'token', 'color.action'),
    selection('card', 'c', 'component', 'Card'),
  ], { dependencies: [{ from: 'button', to: 'card', rationale: 'Declared integration prerequisite.' }] })]);
  await fs.writeFile(fixture.projectFile, JSON.stringify(original));
  const hashesBefore = await Promise.all(Object.values(fixture.sources).map(({ root }) => treeDigest(root)));
  const compose = (projectFile, output) => spawnSync(binary, [
    'compose', '--project', projectFile,
    ...Object.entries(fixture.sources).flatMap(([id, source]) => ['--source', `${id}=${source.root}`]),
    '--out', output, '--compiler', compiler, '--node', process.execPath,
  ], { cwd: fixture.root, encoding: 'utf8', timeout: 30_000 });
  const first = path.join(fixture.root, 'inspected');
  const result = compose(fixture.projectFile, first);
  assert.equal(result.status, 0, result.stderr);
  const pinned = JSON.parse(await fs.readFile(path.join(first, 'project.json'), 'utf8'));
  const blueprint = JSON.parse(await fs.readFile(path.join(first, 'blueprint.json'), 'utf8'));
  const html = await fs.readFile(path.join(first, 'workspace.html'), 'utf8');
  const script = /<script type="module">([\s\S]*?)<\/script>/.exec(html)?.[1];
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1];
  assert.ok(script && style, 'published workspace contains its bundled editor assets');
  for (const [directive, content] of [['script-src', script], ['style-src', style]]) {
    const hash = createHash('sha256').update(content).digest('base64');
    assert.ok(html.includes(`${directive} 'sha256-${hash}'`), 'CSP matches the exact emitted asset bytes');
  }
  assert.doesNotMatch(html, /<script[^>]*\bsrc=|unsafe-inline|nonce=/i);
  assert.equal(blueprint.scenarios[0].blockers.length, 0);
  let state = createWorkspaceState(pinned, blueprint);
  state = applyWorkspaceAction(state, { type: 'branch-scenario', id: 'ab', title: 'Without C' });
  state = applyWorkspaceAction(state, { type: 'exclude-source', sourceId: 'c' });
  assert.equal(state.status, 'needs-cli-validation');
  const exported = serializeProject(state);
  const edited = JSON.parse(exported);
  assert.deepEqual(edited.scenarios[0].includedSources, ['a', 'b', 'c']);
  assert.deepEqual(edited.scenarios[1].includedSources, ['a', 'b']);
  assert.deepEqual(edited.scenarios[1].dependencies, original.scenarios[0].dependencies);
  assert.doesNotThrow(() => validateProjectImport(edited, state.catalogPins));
  const editedFile = path.join(fixture.root, 'downloaded-project.json');
  await fs.writeFile(editedFile, exported);
  const second = path.join(fixture.root, 'revalidated');
  const rerun = compose(editedFile, second);
  assert.equal(rerun.status, 0, rerun.stderr);
  const fresh = JSON.parse(await fs.readFile(path.join(second, 'blueprint.json'), 'utf8'));
  assert.equal(fresh.scenarios[0].blockers.length, 0);
  assert.ok(fresh.scenarios[1].blockers.some((item) => item.kind === 'dependency-target-unavailable' && item.selectionIds.includes('button') && item.message.includes('`card` is missing')));
  assert.deepEqual(fresh.comparisons[0].sourceChanges, { added: [], removed: ['c'] });
  assert.equal(fresh.executable, false);
  assert.ok(fresh.scenarios.every((item) => item.checks.every((check) => check.status === 'not-run')));
  assert.deepEqual(await Promise.all(Object.values(fixture.sources).map(({ root }) => treeDigest(root))), hashesBefore);
});
