// Fixture authoring only. Not part of the migration engine or benchmark oracle.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { digest } from '../src/files.mjs';

const base = path.resolve('fixtures/consolidation');
const commerce = `// Controlled model of one source system. No React/DOM claim.
export function Button({ label, type = 'submit', disabled = false, loading = false }) {
  return { role: 'button', type, label, disabled, loading, announcesLoading: false };
}
export const theme = { spacing: 8, ring: 'legacy' };
`;
const admin = `// Controlled model of a second source system with overloaded semantics.
export function Button({ label, variant = 'action', href, selected = false }) {
  if (variant === 'contentLink') return { role: 'link', label, href, newTabAllowed: true };
  if (variant === 'toggle') return { role: 'button', type: 'button', label, pressed: selected };
  return { role: 'button', type: 'button', label };
}
export const theme = { spacing: 8, ring: 'legacy' };
`;
const target = `// Chosen target for this controlled fixture, not a real published library.
export function Button({ label, type = 'button', disabled = false }) {
  return { role: 'button', type, label, disabled, loading: false, announcesLoading: false };
}
export function LinkButton({ label, href }) {
  return { role: 'link', label, href, newTabAllowed: true };
}
export function ToggleButton({ label, pressed }) {
  return { role: 'button', type: 'button', label, pressed };
}
export const theme = { spacing: 8, ring: 'foundation' };
`;

for (const app of ['checkout', 'account']) {
  const root = path.join(base, app);
  const consumer = path.join(root, 'consumer');
  await fs.mkdir(path.join(consumer, 'src'), { recursive: true });
  await fs.mkdir(path.join(consumer, 'systems'), { recursive: true });
  await fs.mkdir(path.join(root, 'oracles'), { recursive: true });
  for (const [name, content] of [['commerce', commerce], ['admin', admin], ['foundation', target]]) {
    await fs.writeFile(path.join(consumer, 'systems', name + '.mjs'), content);
  }
  const label = app === 'checkout' ? 'Pay' : 'Save';
  const href = app === 'checkout' ? '/billing' : '/profile';
  const files = {
    'theme.mjs': {
      before: `import { theme as commerce } from '../systems/commerce.mjs';\nimport { theme as admin } from '../systems/admin.mjs';\nexport const theme = { ...commerce, ...admin };\n`,
      after: `import { theme } from '../systems/foundation.mjs';\nexport { theme };\n`,
    },
    'form.mjs': {
      before: `import { Button } from '../systems/commerce.mjs';\nexport const submit = () => Button({ label: '${label}' });\n`,
      after: `import { Button } from '../systems/foundation.mjs';\nexport const submit = () => Button({ label: '${label}', type: 'submit' });\n`,
    },
    'navigation.mjs': {
      before: `import { Button } from '../systems/admin.mjs';\nexport const navigation = () => Button({ label: 'Details', variant: 'contentLink', href: '${href}' });\n`,
      after: `import { LinkButton } from '../systems/foundation.mjs';\nexport const navigation = () => LinkButton({ label: 'Details', href: '${href}' });\n`,
    },
    'toggle.mjs': {
      before: `import { Button } from '../systems/admin.mjs';\nexport const toggle = () => Button({ label: 'Pinned', variant: 'toggle', selected: true });\n`,
      after: `import { ToggleButton } from '../systems/foundation.mjs';\nexport const toggle = () => ToggleButton({ label: 'Pinned', pressed: true });\n`,
    },
  };
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(consumer, 'src', name), content.before);
  await fs.writeFile(path.join(consumer, 'src/loading.mjs'), `import { Button } from '../systems/commerce.mjs';\nexport const loading = () => Button({ label: 'Saving', loading: true });\n`);
  await fs.writeFile(path.join(consumer, 'src/dynamic.mjs'), `import { Button } from '../systems/admin.mjs';\nexport const dynamic = (props) => Button(props);\n`);
  const decisions = [
    { id: 'provider', invariants: ['spacing remains 8', 'focus ring intentionally becomes foundation'], rationale: 'Target theme is approved for this fixture. Both source providers have the same spacing.' },
    { id: 'submit', invariants: ['type submit', 'label retained', 'disabled false'], rationale: 'Commerce defaults to submit; target defaults to button, so set type explicitly.' },
    { id: 'navigation', invariants: ['href retained', 'link role', 'new tab allowed'], rationale: 'Literal navigation maps to a dedicated link.' },
    { id: 'toggle', invariants: ['pressed true', 'type button'], rationale: 'Explicit selected state maps to a dedicated toggle.' },
  ].map((d) => ({ ...d, status: 'approved', owner: 'fixture-author (not a customer approval)' }));
  const mapping = [['provider', 'theme.mjs'], ['submit', 'form.mjs'], ['navigation', 'navigation.mjs'], ['toggle', 'toggle.mjs']];
  const units = mapping.map(([id, file]) => ({
    id, summary: decisions.find((d) => d.id === id).rationale, decisions: [id], requires: id === 'provider' ? [] : ['provider'],
    edits: [{ file: 'src/' + file, ...files[file], beforeSha256: digest(files[file].before), afterSha256: digest(files[file].after) }],
  }));
  const usages = [
    { id: 'commerce-provider', source: 'commerce', file: 'src/theme.mjs', anchor: "import { theme as commerce }", disposition: 'mapped', unit: 'provider' },
    { id: 'admin-provider', source: 'admin', file: 'src/theme.mjs', anchor: "import { theme as admin }", disposition: 'mapped', unit: 'provider' },
    { id: 'submit-button', source: 'commerce', file: 'src/form.mjs', anchor: 'export const submit', disposition: 'mapped', unit: 'submit' },
    { id: 'navigation-button', source: 'admin', file: 'src/navigation.mjs', anchor: 'export const navigation', disposition: 'mapped', unit: 'navigation' },
    { id: 'toggle-button', source: 'admin', file: 'src/toggle.mjs', anchor: 'export const toggle', disposition: 'mapped', unit: 'toggle' },
    { id: 'loading-button', source: 'commerce', file: 'src/loading.mjs', anchor: 'export const loading', disposition: 'target-gap', reason: 'Target has no approved loading/announcement behavior', owner: 'Target system owner' },
    { id: 'dynamic-button', source: 'admin', file: 'src/dynamic.mjs', anchor: 'export const dynamic', disposition: 'unsupported', reason: 'Runtime props do not establish intent', owner: 'Application maintainer' },
  ];
  const oracle = `// Expected behavior is authored separately from migration rules.
// This models descriptors, not browser or React behavior.
import test from 'node:test';
import assert from 'node:assert/strict';
import { submit } from '/consumer/src/form.mjs';
import { navigation } from '/consumer/src/navigation.mjs';
import { toggle } from '/consumer/src/toggle.mjs';
import { loading } from '/consumer/src/loading.mjs';
import { dynamic } from '/consumer/src/dynamic.mjs';
import { theme } from '/consumer/src/theme.mjs';
test('form still submits with its original label', () => {
  assert.deepEqual(submit(), { role: 'button', type: 'submit', label: '${label}', disabled: false, loading: false, announcesLoading: false });
});
test('navigation preserves destination and link semantics', () => {
  assert.deepEqual(navigation(), { role: 'link', label: 'Details', href: '${href}', newTabAllowed: true });
});
test('toggle preserves pressed state without submitting', () => {
  assert.deepEqual(toggle(), { role: 'button', type: 'button', label: 'Pinned', pressed: true });
});
test('unresolved loading behavior remains unchanged', () => {
  assert.equal(loading().loading, true);
  assert.equal(loading().announcesLoading, false);
});
test('opaque runtime props remain supported by legacy code', () => {
  assert.deepEqual(dynamic({ label: 'Other', variant: 'toggle', selected: false }), { role: 'button', type: 'button', label: 'Other', pressed: false });
});
test('theme preserves spacing and applies only the approved focus change', () => {
  assert.equal(theme.spacing, 8);
  assert.equal(theme.ring, process.env.SHIFT_PHASE === 'candidate' ? 'foundation' : 'legacy');
});
`;
  await fs.writeFile(path.join(root, 'oracles/behavior.test.mjs'), oracle);
  const c = {
    schemaVersion: 1, id: app + '-consolidation', kind: 'controlled-fixture', consumer: 'consumer',
    sources: ['commerce', 'admin'], target: 'foundation',
    inventory: { kind: 'manual', limitations: 'Seven registered fixture sites; completeness is not inferred from discovery.' },
    decisions, units, usages, requiredChecks: ['behavior'],
    checks: [{ id: 'behavior', description: 'Six independently stated descriptor expectations', oracle: 'oracles/behavior.test.mjs', sha256: digest(oracle), expectedTests: 6, timeoutMs: 20000 }],
  };
  await fs.writeFile(path.join(root, 'case.json'), JSON.stringify(c, null, 2) + '\n');
}
console.log('Wrote two controlled consolidation cases. No benchmark results generated.');
