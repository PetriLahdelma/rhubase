import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyWorkspaceAction,
  catalogEntries,
  createWorkspaceState,
  safeJsonForHtml,
  serializeProject,
  validateProjectImport,
} from '../../src/composition-workspace.mjs';
import { project, scenario, selection } from './fixture.mjs';

const digestA = 'a'.repeat(64);
const digestB = 'b'.repeat(64);
const digestC = 'c'.repeat(64);
const pinned = project(['a', 'b'], [scenario('baseline', ['a', 'b'], [
  selection('a-button', 'a', 'component', 'Button'),
  selection('b-color', 'b', 'token', 'color.action'),
], { dependencies: [{ from: 'a-button', to: 'b-color', rationale: 'Button needs the action color.' }] })]);
pinned.sources[0].digest = digestA;
pinned.sources[1].digest = digestB;
const blueprint = {
  schemaVersion: 1,
  kind: 'rhubase-composition-blueprint',
  sources: [
    { id: 'a', identity: { name: '@fixture/a', version: '1.0.0' }, capabilities: [
      { kind: 'component', name: 'Button', status: 'observed', evidenceRefs: [{ kind: 'static-source' }] },
    ] },
    { id: 'b', identity: { name: '@fixture/b', version: '1.0.0' }, capabilities: [
      { kind: 'token', name: 'color.action', status: 'observed', evidenceRefs: [{ kind: 'static-source' }] },
      { kind: 'mode', name: 'dark', status: 'human-declared', evidenceRefs: [{ kind: 'human-declaration' }] },
    ] },
  ],
  scenarios: [{ id: 'baseline', blockers: [{ kind: 'example' }], checks: [{ status: 'not-run' }] }],
};

test('catalog entries preserve source qualification and filter without implying equivalence', () => {
  assert.deepEqual(catalogEntries(blueprint, 'button').map(({ key }) => key), ['a:component:Button']);
  assert.deepEqual(catalogEntries(blueprint, '').map(({ key }) => key), [
    'a:component:Button', 'b:mode:dark', 'b:token:color.action',
  ]);
});

test('branch, edit, remove and undo/redo keep changes local and mark CLI validation stale', () => {
  let state = createWorkspaceState(pinned, blueprint);
  state = applyWorkspaceAction(state, { type: 'branch-scenario', id: 'alternate', title: 'Alternate' });
  assert.equal(state.project.scenarios.length, 2);
  assert.equal(state.activeScenarioId, 'alternate');
  state = applyWorkspaceAction(state, { type: 'update-target', patch: { name: '@fixture/new-foundation' } });
  assert.equal(state.status, 'needs-cli-validation');
  assert.equal(state.project.scenarios[0].target.name, '@fixture/foundation');
  assert.equal(state.project.scenarios[1].target.name, '@fixture/new-foundation');
  state = applyWorkspaceAction(state, { type: 'undo' });
  assert.equal(state.project.scenarios[1].target.name, '@fixture/foundation');
  state = applyWorkspaceAction(state, { type: 'redo' });
  assert.equal(state.project.scenarios[1].target.name, '@fixture/new-foundation');
});

test('excluding a source removes its selections and retains incoming dependency as unresolved', () => {
  const threeSource = structuredClone(pinned);
  threeSource.sources.push({ id: 'c', digest: digestC, declaredModes: [] });
  threeSource.scenarios[0].includedSources.push('c');
  const threeBlueprint = structuredClone(blueprint);
  threeBlueprint.sources.push({ id: 'c', identity: { name: '@fixture/c', version: '1.0.0' }, capabilities: [] });
  let state = createWorkspaceState(threeSource, threeBlueprint);
  state = applyWorkspaceAction(state, { type: 'exclude-source', sourceId: 'b' });
  const active = state.project.scenarios[0];
  assert.deepEqual(active.includedSources, ['a', 'c']);
  assert.equal(active.selections.some((item) => item.source === 'b'), false);
  assert.deepEqual(active.dependencies, [{ from: 'a-button', to: 'b-color', rationale: 'Button needs the action color.' }]);
  assert.deepEqual(state.consequences, ['Removed 1 selection from b.', 'Retained 1 dependency as an unresolved prerequisite.']);
  assert.doesNotThrow(() => serializeProject(state));
});

test('exclusion refuses to silently rewrite target or delivery choices', () => {
  const threeSource = structuredClone(pinned);
  threeSource.sources.push({ id: 'c', digest: digestC, declaredModes: [] });
  threeSource.scenarios[0].includedSources.push('c');
  threeSource.scenarios[0].target = { name: '@fixture/foundation', mode: 'evolve', baseSource: 'b' };
  const threeBlueprint = structuredClone(blueprint);
  threeBlueprint.sources.push({ id: 'c', identity: { name: '@fixture/c', version: '1.0.0' }, capabilities: [] });
  const state = createWorkspaceState(threeSource, threeBlueprint);
  assert.throws(() => applyWorkspaceAction(state, { type: 'exclude-source', sourceId: 'b' }), /base source/i);
  assert.deepEqual(state.project, threeSource);
});

test('closed import rejects stale pins and approval fields before changing state', () => {
  const state = createWorkspaceState(pinned, blueprint);
  const stale = structuredClone(pinned);
  stale.sources[0].digest = 'c'.repeat(64);
  assert.throws(() => validateProjectImport(stale, state.catalogPins), /digest/i);
  const forged = structuredClone(pinned);
  forged.scenarios[0].selections[0].approved = true;
  assert.throws(() => validateProjectImport(forged, state.catalogPins), /unexpected or missing fields/i);
  assert.deepEqual(state.project, pinned);
});

test('safe embedded JSON cannot terminate a script or inject markup', () => {
  const encoded = safeJsonForHtml({ title: '</script><img src=x onerror=alert(1)>\u2028' });
  assert.doesNotMatch(encoded, /<\/script|<img/i);
  assert.match(encoded, /\\u003c/);
  assert.deepEqual(JSON.parse(encoded), { title: '</script><img src=x onerror=alert(1)>\u2028' });
});

test('serializing a valid edited project strips workspace-only state and stays schema exact', () => {
  let state = createWorkspaceState(pinned, blueprint);
  state = applyWorkspaceAction(state, { type: 'update-selection', id: 'a-button', patch: { rationale: 'Keep the established button contract.' } });
  const value = JSON.parse(serializeProject(state));
  assert.deepEqual(Object.keys(value).sort(), ['kind', 'scenarios', 'schemaVersion', 'sources', 'title']);
  assert.equal(value.scenarios[0].selections[0].rationale, 'Keep the established button contract.');
  assert.equal(Object.hasOwn(value, 'approved'), false);
});
