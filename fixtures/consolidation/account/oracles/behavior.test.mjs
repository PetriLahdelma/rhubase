// Expected behavior is authored separately from migration rules.
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
  assert.deepEqual(submit(), { role: 'button', type: 'submit', label: 'Save', disabled: false, loading: false, announcesLoading: false });
});
test('navigation preserves destination and link semantics', () => {
  assert.deepEqual(navigation(), { role: 'link', label: 'Details', href: '/profile', newTabAllowed: true });
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
