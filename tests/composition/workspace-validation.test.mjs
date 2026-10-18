import test from 'node:test';
import assert from 'node:assert/strict';
import { applyWorkspaceAction, createWorkspaceState, parseProjectText, validateProjectImport } from '../../src/composition-workspace.mjs';
import { project, scenario, selection } from './fixture.mjs';

function initial() {
  const value = project(['a', 'b'], [scenario('baseline', ['a', 'b'], [
    selection('choice-1', 'a', 'component', 'Button'),
    selection('choice-2', 'b', 'component', 'Card'),
  ], { dependencies: [{ from: 'choice-2', to: 'choice-1', rationale: 'Requires the original button.' }] })]);
  value.sources.forEach((source, index) => { source.digest = String(index + 1).repeat(64); });
  const blueprint = { sources: [{ id: 'a', capabilities: [{ kind: 'component', name: 'Menu', status: 'observed', evidenceRefs: [] }] }] };
  return createWorkspaceState(value, blueprint);
}

test('new selections cannot accidentally fulfill a deleted capability prerequisite by reusing its ID', () => {
  let state = initial();
  state = applyWorkspaceAction(state, { type: 'remove-selection', id: 'choice-1' });
  const next = applyWorkspaceAction(state, { type: 'add-selection', catalogKey: 'a:component:Menu' });
  assert.equal(next.project.scenarios[0].selections.some(({ id }) => id === 'choice-1'), false);
  assert.equal(next.project.scenarios[0].dependencies[0].to, 'choice-1');
  assert.throws(() => applyWorkspaceAction(state, { type: 'add-selection', catalogKey: 'a:component:Menu', id: 'choice-1' }));
});

test('browser import rejects non-string identities and Rust-invalid UTF-8 lengths', () => {
  const state = initial();
  for (const mutate of [
    (value) => { value.scenarios[0].target.name = ['foundation']; },
    (value) => { value.scenarios[0].id = undefined; },
    (value) => { value.title = 'é'.repeat(600); },
    (value) => { value.scenarios[0].selections[0].rationale = '🌱'.repeat(300); },
    (value) => { value.scenarios[0].target.name = '@scope/foundation-'; },
  ]) {
    const edited = structuredClone(state.project);
    mutate(edited);
    assert.throws(() => validateProjectImport(edited, state.catalogPins));
  }
});

test('duplicate escaped JSON keys and changed declared-mode evidence are rejected', () => {
  const state = initial();
  const document = JSON.stringify(state.project).replace('"title":', '"ti\\u0074le":"Hidden original","title":');
  assert.throws(() => parseProjectText(document, state.catalogPins), /duplicate/i);
  const changed = structuredClone(state.project);
  changed.sources[0].declaredModes = ['new-dark'];
  assert.throws(() => validateProjectImport(changed, state.catalogPins), /declared modes/i);
  assert.deepEqual(state.project.sources[0].declaredModes, []);
});
