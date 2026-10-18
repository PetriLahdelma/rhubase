import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import vm from 'node:vm';
import { project, scenario, selection } from './fixture.mjs';

// A small event-binding harness, not a browser or an accessibility evaluation.
// IDs come from the actual template so a mismatched bootstrap cannot pass.
async function mount() {
  const html = await fs.readFile(new URL('../../src/composition-workspace.html', import.meta.url), 'utf8');
  const script = await fs.readFile(new URL('../../src/composition-workspace.mjs', import.meta.url), 'utf8');
  class Element {
    constructor() { this.dataset = {}; this.value = ''; this.textContent = ''; this.innerHTML = ''; this.listeners = {}; }
    addEventListener(name, callback) { (this.listeners[name] ??= []).push(callback); }
    dispatch(name, event = { target: this }) { return Promise.all((this.listeners[name] ?? []).map((callback) => callback(event))); }
    focus() {}
    click() {}
  }
  const nodes = Object.fromEntries([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, new Element()]));
  const value = project(['a', 'b'], [scenario('baseline', ['a', 'b'], [selection('button', 'a', 'component', 'Button')])]);
  value.sources.forEach((source, index) => { source.digest = String(index + 1).repeat(64); });
  const blueprint = { schemaVersion: 1, kind: 'rhubase-composition-blueprint', sources: value.sources.map(({ id, digest }) => ({
    id, digest, identity: { name: `@fixture/${id}`, version: '1.0.0' }, coverage: {},
    capabilities: [{ kind: 'component', name: 'Button', status: 'observed', evidenceRefs: [] }],
  })), scenarios: [{ id: 'baseline', blockers: [], findings: [], checks: [], compatibility: 'unverified' }], comparisons: [] };
  nodes['rhubase-project'].textContent = JSON.stringify(value);
  nodes['rhubase-blueprint'].textContent = JSON.stringify(blueprint);
  const events = new Element();
  const downloads = [];
  const doc = { querySelector: (selector) => nodes[selector.slice(1)] ?? null, createElement: () => new Element(), addEventListener: events.addEventListener.bind(events) };
  vm.runInNewContext(script.replace(/^export /gm, ''), {
    document: doc, structuredClone, TextEncoder, Blob, console,
    URL: { createObjectURL: (blob) => { downloads.push(blob); return 'blob:test'; }, revokeObjectURL() {} },
    setTimeout: (callback) => callback(), addEventListener: events.addEventListener.bind(events),
  }, { timeout: 2000 });
  return { nodes, events, downloads };
}

test('real template and script bootstrap controls, edit a target and download the updated project', async () => {
  const { nodes, downloads } = await mount();
  assert.match(nodes['catalog-list'].innerHTML, /Button/);
  assert.match(nodes['selection-list'].innerHTML, /button/);
  nodes['target-name'].value = '@fixture/edited';
  await nodes['target-name'].dispatch('change');
  assert.equal(nodes['workspace-status'].textContent, 'Needs CLI validation');
  await nodes.export.dispatch('click');
  assert.equal(downloads.length, 1);
  const downloaded = JSON.parse(await downloads[0].text());
  assert.equal(downloaded.scenarios[0].target.name, '@fixture/edited');
  assert.equal(downloaded.kind, 'rhubase-composition-project');
});

test('rationale input does not rebuild the focused editor before the edit is committed', async () => {
  const { nodes, downloads } = await mount();
  const before = nodes['selection-list'].innerHTML;
  const input = { tagName: 'TEXTAREA', dataset: { field: 'rationale' }, value: 'A complete multi-word rationale.', closest: () => ({ dataset: { selection: 'button' } }) };
  await nodes['selection-list'].dispatch('input', { target: input });
  assert.equal(nodes['selection-list'].innerHTML, before);
  await nodes['selection-list'].dispatch('change', { target: input });
  await nodes.export.dispatch('click');
  assert.equal(JSON.parse(await downloads[0].text()).scenarios[0].selections[0].rationale, input.value);
});
