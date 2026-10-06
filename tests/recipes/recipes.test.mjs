import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { loadCompiler, parseProject } from '../../src/source-analysis.mjs';
import { evaluateContents } from '../../scripts/evaluate-source-case.mjs';
import { validateRecipe, recipeSourceRules, transformSources } from '../../src/recipes.mjs';

const { ts } = await loadCompiler(process.env.SHIFT_TYPESCRIPT_PATH);
const component = (overrides = {}) => ({
  schemaVersion: 1,
  id: 'buttons',
  rules: [{
    id: 'action-button', kind: 'component',
    from: { module: '@old/ui', export: 'Button' },
    to: { module: '@new/ui', export: 'ActionButton' },
    when: { prop: 'variant', literal: 'action' },
    props: {
      rename: { onAction: 'onClick' },
      values: { size: { small: 'xs' } },
      remove: { variant: 'action' },
      set: { type: 'button', destructive: false },
    },
    ...overrides,
  }],
});

test('validates declarative recipes and derives deduplicated analyzer rules', () => {
  const recipe = component();
  recipe.rules.push({ ...recipe.rules[0], id: 'other', when: { prop: 'variant', literal: 'other' } });
  assert.equal(validateRecipe(recipe), recipe);
  assert.deepEqual(recipeSourceRules(recipe), { schemaVersion: 1, sources: [{ module: '@old/ui', exports: ['Button'] }] });
  assert.throws(() => validateRecipe(component({ props: { rename: { value: 'next' }, set: { next: true } } })), /conflict/);
  assert.throws(() => validateRecipe(component({ kind: 'code' })), /Unsupported/);
});

test('rejects unknown recipe fields and malformed operation maps before source changes', () => {
  const mutations = [
    (recipe) => { recipe.typo = true; },
    (recipe) => { recipe.rules[0].typo = true; },
    (recipe) => { recipe.rules[0].from.exprot = 'Button'; },
    (recipe) => { recipe.rules[0].to.package = '@new/ui'; },
    (recipe) => { recipe.rules[0].when.extra = true; },
    (recipe) => { recipe.rules[0].props.renmae = { onAction: 'onClick' }; },
    (recipe) => { recipe.rules[0].props.rename = []; },
    (recipe) => { recipe.rules[0].props = null; },
    (recipe) => { recipe.rules[0].props.remove = null; },
    (recipe) => { recipe.rules[0].props.values = { size: [] }; },
    (recipe) => { recipe.rules[0].props.set = { count: Number.POSITIVE_INFINITY }; },
  ];
  const before = `import { Button } from '@old/ui';\nexport const x = <Button variant="action" onAction={save} />;\n`;
  for (const mutate of mutations) {
    const recipe = component(); mutate(recipe);
    const contents = new Map([['invalid.tsx', before]]);
    assert.throws(() => transformSources(ts, contents, recipe));
    assert.equal(contents.get('invalid.tsx'), before);
  }
});

test('generates a qualified component migration, preserves children, and is idempotent', () => {
  const before = `import { Button as OldButton, Card } from '@old/ui';\nimport { Icon } from '@new/ui';\nconst view = <OldButton variant="action" size="small" onAction={save} aria-label="Save"><Card>Keep</Card></OldButton>;\n`;
  const result = transformSources(ts, new Map([['App.tsx', before]]), component());
  assert.equal(result.edits.length, 1);
  assert.equal(result.outcomes[0].status, 'transformed');
  assert.equal(result.blockers.length, 0);
  const after = result.contents.get('App.tsx');
  assert.match(after, /import \{ Icon, ActionButton \} from ['"]@new\/ui['"]/);
  assert.match(after, /import \{ Card \} from ['"]@old\/ui['"]/);
  assert.match(after, /<ActionButton\s+size="xs"\s+onClick=\{save\}\s+aria-label="Save"\s+type="button"\s+destructive=\{false\}>/);
  assert.match(after, /<Card>Keep<\/Card><\/ActionButton>/);
  assert.equal(result.edits[0].beforeSha256.length, 64);
  assert.equal(result.edits[0].afterSha256.length, 64);
  assert.deepEqual(parseProject(ts, result.contents).diagnostics, []);
  const second = transformSources(ts, result.contents, component());
  assert.equal(second.edits.length, 0);
  assert.equal(second.outcomes.length, 0);
});

test('supports default and namespace source identities and collision-free target imports', () => {
  const recipe = {
    schemaVersion: 1, id: 'origins', rules: [
      { id: 'default', kind: 'component', from: { module: 'old-default', export: 'default' }, to: { module: 'target', export: 'Widget' } },
      { id: 'namespace', kind: 'component', from: { module: 'old-ns', export: 'Button' }, to: { module: 'target', export: 'Control' } },
    ],
  };
  const before = `import Legacy from 'old-default';\nimport * as Old from 'old-ns';\nconst Widget = 1;\nexport const x = <><Legacy keep="yes" /><Old.Button /></>;\n`;
  const result = transformSources(ts, new Map([['x.tsx', before]]), recipe);
  const after = result.contents.get('x.tsx');
  assert.match(after, /import \{ Widget as Widget2, Control \} from "target"/);
  assert.match(after, /<Widget2 keep="yes" \/>/);
  assert.match(after, /<Control \/>/);
  assert.match(after, /import \* as Old from 'old-ns'/);
  assert.equal(result.outcomes.filter((outcome) => outcome.status === 'transformed').length, 2);
});

test('does not reuse a target import shadowed at the migration site', () => {
  const recipe = component({ when: undefined, props: {} });
  const before = `import { Button } from '@old/ui';\nimport { ActionButton } from '@new/ui';\nfunction View(ActionButton) { return <Button />; }\n`;
  const result = transformSources(ts, new Map([['shadow-target.tsx', before]]), recipe);
  const after = result.contents.get('shadow-target.tsx');
  assert.match(after, /import \{ ActionButton, ActionButton as ActionButton2 \} from ['"]@new\/ui['"]/);
  assert.match(after, /return <ActionButton2 \/>/);
});

test('adds a syntactically separated import to files without imports', () => {
  const recipe = component({ from: { module: '@old/ui', export: 'Button' }, when: undefined, props: {} });
  // A source import is needed for qualified discovery, so exercise the insertion boundary with
  // a target module that has no prior declaration and a leading directive after source cleanup.
  const before = `import { Button } from '@old/ui';\n'use client';\nexport const x = <Button />;\n`;
  const result = transformSources(ts, new Map([['directive.tsx', before]]), recipe);
  assert.deepEqual(parseProject(ts, result.contents).diagnostics, []);
  assert.match(result.contents.get('directive.tsx'), /from "@new\/ui";\n\n?'use client'/);
});

test('preserves unrelated type imports and JSX comments while removing the migrated source binding', () => {
  const recipe = component({ when: undefined, props: { remove: { variant: 'action' } } });
  const before = `import { type Metadata, Button } from '@old/ui';\nexport const x = (\n  <Button\n    /* preserve this explanation */\n    variant="action"\n    data-test="primary"\n  />\n);\n`;
  const result = transformSources(ts, new Map([['comments.tsx', before]]), recipe);
  const after = result.contents.get('comments.tsx');
  assert.match(after, /import \{ type Metadata \} from ['"]@old\/ui['"]/);
  assert.match(after, /\/\* preserve this explanation \*\//);
  assert.match(after, /data-test="primary"/);
  assert.deepEqual(parseProject(ts, result.contents).diagnostics, []);
});

test('blocks spreads and conflicting rules while protecting non-JSX bindings', () => {
  const recipe = component({ when: undefined, props: {} });
  const conflict = structuredClone(recipe); conflict.rules.push({ ...conflict.rules[0], id: 'duplicate' });
  const cases = new Map([['blocked.tsx', `import { Button } from '@old/ui';\nconst Wrapped = Button;\nexport const x = <Button {...props}><Button /></Button>;\n`]]);
  const result = transformSources(ts, cases, conflict);
  assert.equal(result.edits.length, 0);
  assert.equal(result.outcomes.length, 2);
  assert.ok(result.outcomes.every((outcome) => outcome.status === 'blocked'));
  assert.ok(result.blockers.some((blocker) => blocker.kind === 'non-jsx-reference'));
  assert.match(result.contents.get('blocked.tsx'), /import \{ Button \}/);

  const spread = transformSources(ts, new Map([['spread.tsx', `import { Button } from '@old/ui';\nexport const x = <Button {...props} />;\n`]]), recipe);
  assert.equal(spread.outcomes[0].status, 'blocked');
  assert.match(spread.outcomes[0].reason, /spread/);
  assert.doesNotMatch(spread.contents.get('spread.tsx'), /@new\/ui/);
});

test('transforms nested generic components because their AST-derived edits are disjoint', () => {
  const recipe = component({ when: undefined, props: {} });
  const before = `import { Button } from '@old/ui';\nexport const x = <Button><Button /></Button>;\n`;
  const result = transformSources(ts, new Map([['nested.tsx', before]]), recipe);
  assert.equal(result.blockers.length, 0);
  assert.equal(result.outcomes.filter((outcome) => outcome.status === 'transformed').length, 2);
  assert.match(result.contents.get('nested.tsx'), /<ActionButton><ActionButton \/><\/ActionButton>/);
});

test('blocks ambiguous conditional expressions and spread-supplied discriminants', () => {
  const expression = transformSources(ts, new Map([['x.tsx', `import { Button } from '@old/ui';\nexport const x = <Button variant={kind} />;\n`]]), component());
  assert.equal(expression.outcomes[0].status, 'blocked');
  assert.match(expression.outcomes[0].reason, /ambiguous/);
  const spread = transformSources(ts, new Map([['x.tsx', `import { Button } from '@old/ui';\nexport const x = <Button {...props} />;\n`]]), component());
  assert.equal(spread.outcomes[0].status, 'blocked');
  assert.match(spread.outcomes[0].reason, /ambiguous/);
});

test('does not transform shadowed same-name elements or unmatched conditional literals', () => {
  const before = `import { Button } from '@old/ui';\nfunction x(Button) { return <Button variant="action" />; }\nexport const y = <Button variant="link" />;\n`;
  const result = transformSources(ts, new Map([['shadow.tsx', before]]), component());
  assert.equal(result.edits.length, 0);
  assert.equal(result.outcomes.length, 1);
  assert.equal(result.outcomes[0].status, 'unchanged');
  assert.equal(result.outcomes[0].reasonCode, 'no-rule-match');
});

test('same-identity prop migrations retain imports and report an idempotent second pass', () => {
  const recipe = {
    schemaVersion: 1,
    id: 'same-package-button',
    rules: [{
      id: 'modernize-button-props', kind: 'component',
      from: { module: 'ui', export: 'Button' },
      to: { module: 'ui', export: 'Button' },
      props: {
        rename: { onAction: 'onClick' },
        values: { tone: { danger: 'destructive' } },
        remove: { legacy: true },
      },
    }],
  };
  const before = `import { Button } from 'ui';\nexport const x = <Button onAction={save} tone="danger" legacy />;\n`;
  const first = transformSources(ts, new Map([['same.tsx', before]]), recipe);
  assert.equal(first.edits.length, 1);
  assert.equal(first.outcomes[0].status, 'transformed');
  assert.equal(first.outcomes[0].reasonCode, 'rule-applied');
  assert.match(first.contents.get('same.tsx'), /import \{ Button \} from ['"]ui['"]/);
  assert.match(first.contents.get('same.tsx'), /<Button onClick=\{save\} tone="destructive"\s*\/>/);
  assert.deepEqual(parseProject(ts, first.contents).diagnostics, []);

  const second = transformSources(ts, first.contents, recipe);
  assert.equal(second.edits.length, 0);
  assert.equal(second.blockers.length, 0);
  assert.equal(second.outcomes.length, 1);
  assert.equal(second.outcomes[0].status, 'unchanged');
  assert.equal(second.outcomes[0].reasonCode, 'already-satisfied');
  assert.match(second.contents.get('same.tsx'), /import \{ Button \} from ['"]ui['"]/);
});

test('cross-identity replacement blocks when an explicit removal precondition is missing', () => {
  const recipe = component({
    when: undefined,
    props: { remove: { variant: 'action' } },
  });
  const before = `import { Button } from '@old/ui';\nexport const x = <Button aria-label="Keep source" />;\n`;
  const result = transformSources(ts, new Map([['missing-precondition.tsx', before]]), recipe);
  assert.equal(result.edits.length, 0);
  assert.equal(result.outcomes.length, 1);
  assert.equal(result.outcomes[0].status, 'blocked');
  assert.equal(result.outcomes[0].reasonCode, 'unsafe-transformation');
  assert.match(result.outcomes[0].reason, /Required removable prop variant is missing/);
  assert.equal(result.contents.get('missing-precondition.tsx'), before);
  assert.match(result.contents.get('missing-precondition.tsx'), /import \{ Button \} from '@old\/ui'/);
  assert.doesNotMatch(result.contents.get('missing-precondition.tsx'), /@new\/ui/);
});

test('same-identity conditional discriminants prove removed, renamed, and mapped target states', () => {
  const cases = [
    {
      id: 'removed',
      props: { remove: { variant: 'action' }, set: { type: 'button' } },
      expected: /<Button\s+type="button"\s*\/>/,
    },
    {
      id: 'renamed',
      props: { rename: { variant: 'intent' }, set: { type: 'button' } },
      expected: /<Button\s+intent="action"\s+type="button"\s*\/>/,
    },
    {
      id: 'mapped',
      props: { values: { variant: { action: 'primary' } }, set: { type: 'button' } },
      expected: /<Button\s+variant="primary"\s+type="button"\s*\/>/,
    },
  ];
  for (const entry of cases) {
    const recipe = {
      schemaVersion: 1, id: entry.id, rules: [{
        id: `${entry.id}-action`, kind: 'component',
        from: { module: 'ui', export: 'Button' },
        to: { module: 'ui', export: 'Button' },
        when: { prop: 'variant', literal: 'action' },
        props: entry.props,
      }],
    };
    const first = transformSources(ts, new Map([['conditional.tsx', `import { Button } from 'ui';\nexport const x = <Button variant="action" />;\n`]]), recipe);
    assert.equal(first.outcomes[0].status, 'transformed', entry.id);
    assert.match(first.contents.get('conditional.tsx'), entry.expected, entry.id);
    const second = transformSources(ts, first.contents, recipe);
    assert.equal(second.edits.length, 0, entry.id);
    assert.equal(second.blockers.length, 0, entry.id);
    assert.equal(second.outcomes[0].status, 'unchanged', entry.id);
    assert.equal(second.outcomes[0].reasonCode, 'already-satisfied', entry.id);
  }
});

test('same-identity target-state proof does not accept a different unmapped discriminant', () => {
  const recipe = {
    schemaVersion: 1, id: 'conditional', rules: [{
      id: 'action', kind: 'component',
      from: { module: 'ui', export: 'Button' },
      to: { module: 'ui', export: 'Button' },
      when: { prop: 'variant', literal: 'action' },
      props: { values: { variant: { action: 'primary' } } },
    }],
  };
  const result = transformSources(ts, new Map([['other.tsx', `import { Button } from 'ui';\nexport const x = <Button variant="other" />;\n`]]), recipe);
  assert.equal(result.edits.length, 0);
  assert.equal(result.outcomes[0].status, 'unchanged');
  assert.equal(result.outcomes[0].reasonCode, 'no-rule-match');
});

test('the named Superset recipe generates the registered migration from original inputs', async () => {
  const root = path.resolve('experiments/superset-dropdown/input');
  const files = ['src/dashboard/components/menu/PopoverDropdown.jsx', 'src/dashboard/components/menu/WithPopoverMenu.jsx', 'src/explore/components/DisplayQueryButton.jsx'];
  const before = new Map(await Promise.all(files.map(async (file) => [file, await fs.readFile(path.join(root, file), 'utf8')])));
  const recipe = JSON.parse(await fs.readFile('recipes/superset-dropdown.json', 'utf8'));
  const generated = transformSources(ts, before, recipe);
  assert.equal(generated.edits.length, 2);
  assert.equal(generated.outcomes.filter((outcome) => outcome.status === 'transformed').length, 2);
  assert.equal(generated.blockers.length, 0);
  const evaluation = evaluateContents(ts, before, generated.contents);
  assert.equal(evaluation.passed, 30);
  assert.equal(evaluation.needsReview, 0);
  assert.equal(transformSources(ts, generated.contents, recipe).edits.length, 0);
});
