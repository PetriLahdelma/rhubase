import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { loadCompiler } from '../../src/source-analysis.mjs';
import { evaluateContents } from '../../scripts/evaluate-source-case.mjs';

const { ts } = await loadCompiler(process.env.SHIFT_TYPESCRIPT_PATH);
const base = path.resolve('experiments/superset-dropdown');
const paths = ['src/dashboard/components/menu/PopoverDropdown.jsx', 'src/dashboard/components/menu/WithPopoverMenu.jsx', 'src/explore/components/DisplayQueryButton.jsx'];
const before = new Map(); const after = new Map();
for (const file of paths) {
  before.set(file, await fs.readFile(path.join(base, 'input', file), 'utf8'));
  after.set(file, await fs.readFile(path.join(base, 'results/candidate', file), 'utf8'));
}
const dashboard = paths[0]; const display = paths[2];
function mutate(file, from, to) {
  const candidate = new Map(after);
  assert.ok(candidate.get(file).includes(from), 'Mutation must actually alter the candidate');
  candidate.set(file, candidate.get(file).replace(from, to));
  return evaluateContents(ts, before, candidate);
}
const fails = (result, suffix) => result.checks.some((c) => c.id.endsWith(suffix) && c.status === 'needs-review');

test('recorded agent candidate satisfies the corrected source-only rubric', () => {
  const report = evaluateContents(ts, before, after);
  assert.equal(report.needsReview, 0);
  assert.equal(report.readiness, 'runtime-unverified');
});

test('loss of existing class is caught but added class tokens are allowed', () => {
  assert.ok(fails(mutate(dashboard, 'popover-dropdown btn', 'other btn'), ':preserve-className'));
  assert.ok(!fails(mutate(dashboard, 'popover-dropdown btn', 'popover-dropdown extra btn'), ':preserve-className'));
});

test('native trigger must explicitly avoid form submission', () => {
  assert.ok(fails(mutate(display, 'type="button"', 'type="submit"'), ':native-trigger'));
});

test('loss of controlled visibility cannot pass', () => {
  assert.ok(fails(mutate(display, 'visible={menuVisible}', 'visible={false}'), ':visible'));
  assert.ok(fails(mutate(display, 'onVisibleChange={setMenuVisible}', 'onVisibleChange={() => {}}'), ':onVisibleChange'));
});

test('changed menu handler or target origin is caught', () => {
  assert.ok(fails(mutate(display, 'onClick={handleMenuClick}', 'onClick={() => {}}'), ':menu-preserved'));
  assert.ok(fails(mutate(display, "from 'src/common/components'", "from 'unrelated'"), ':target-origin'));
});

test('dashboard popup containment is required without imposing it on other consumers', () => {
  assert.ok(fails(mutate(dashboard, 'triggerNode => triggerNode.parentNode', 'triggerNode => document.body'), ':popup-containment'));
  const report = evaluateContents(ts, before, after);
  assert.equal(report.checks.filter((c) => c.id.endsWith(':popup-containment')).length, 1);
});

test('changed focus cleanup logic and menu close behavior are caught', () => {
  assert.ok(fails(mutate(paths[1], "document.removeEventListener('click', this.handleClick);", ''), ':unchanged-context'));
  assert.ok(fails(mutate(display, 'setMenuVisible(false);', ''), ':unrelated-logic'));
});

test('unmigrated input cannot satisfy the target-origin checks', () => {
  assert.ok(fails(evaluateContents(ts, before, before), ':target-origin'));
});
