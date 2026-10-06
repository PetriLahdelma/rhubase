import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCompiler, parseProject } from '../../src/source-analysis.mjs';
import { transformSources } from '../../src/recipes.mjs';

// Known failures preserved in validation/frozen. These are development regressions,
// not evidence from the separately withheld snapshot-inference corpus.
const { ts } = await loadCompiler(process.env.SHIFT_TYPESCRIPT_PATH);
function generatedValue(value, hasProps) {
  const source = `import { Button } from 'old-ui'; const view = <Button${hasProps ? ' id="save"' : ''} />;`;
  const recipe = { schemaVersion: 1, id: 'literal-regression', rules: [{ id: 'label', kind: 'component', from: { module: 'old-ui', export: 'Button' }, to: { module: 'new-ui', export: 'Button' }, props: { set: { label: value } } }] };
  const result = transformSources(ts, new Map([['case.tsx', source]]), recipe);
  const output = result.contents.get('case.tsx');
  assert.deepEqual(parseProject(ts, new Map([['case.tsx', output]])).diagnostics, [], output);
  const emitted = ts.transpileModule(output, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ESNext } }).outputText;
  const file = ts.createSourceFile('generated.js', emitted, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let actual;
  function visit(node) {
    if (ts.isPropertyAssignment(node) && node.name.getText() === 'label' && ts.isStringLiteral(node.initializer)) actual = node.initializer.text;
    ts.forEachChild(node, visit);
  }
  visit(file);
  return actual;
}
test('adding the first attribute preserves valid JSX and the value', () => assert.equal(generatedValue('Save order', false), 'Save order'));
for (const value of ['He said "Go"', 'line\nbreak', 'a\\b', 'A &amp; B', '<ready>', '日本語 🎯']) {
  test(`JSX string generation preserves ${JSON.stringify(value)}`, () => assert.equal(generatedValue(value, true), value));
}
