import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadCompiler, inspectContents, inspectSource, validateSourceRules } from '../../src/source-analysis.mjs';

const { ts, identity } = await loadCompiler(process.env.SHIFT_TYPESCRIPT_PATH);
const rules = { schemaVersion: 1, sources: [{ module: 'old-ui', exports: ['Button'] }, { module: 'old-ui/Button', exports: ['default'] }] };
const inspect = (text) => inspectContents(ts, new Map([['src/view.tsx', text]]), rules);

test('named import aliases resolve through lexical symbols', () => {
  const result = inspect("import { Button as Action } from 'old-ui'; const view = <Action size='sm'>Save</Action>;");
  assert.equal(result.usages.length, 1);
  assert.equal(result.usages[0].origin.exported, 'Button');
  assert.equal(result.usages[0].origin.localName, 'Action');
  assert.deepEqual(result.usages[0].props[0], { name: 'size', kind: 'literal', value: 'sm' });
});

test('shadowed imports and unrelated same-name components are not source usages', () => {
  const result = inspect(`import { Button } from 'old-ui';
    function nested(Button) { return <Button/>; }
    const view = <Button/>;`);
  assert.equal(result.usages.length, 1);
  assert.equal(result.usages[0].line, 3);
  assert.equal(inspect("import {Button} from 'unrelated';const x=<Button/>;").usages.length, 0);
});

test('namespace and default imports are counted once per usage', () => {
  const result = inspect("import * as Old from 'old-ui'; import B from 'old-ui/Button'; const x=<><Old.Button/><B>x</B></>;");
  assert.equal(result.usages.length, 2);
  assert.equal(result.unsupported.length, 0);
});

test('comments and strings resembling JSX do not become usage sites', () => {
  const result = inspect("import {Button} from 'old-ui'; // <Button/>\n const text='<Button/>'; const real=<Button/>;");
  assert.equal(result.usages.length, 1);
});

test('opaque spread is recorded without inventing resolved props', () => {
  const result = inspect("import {Button} from 'old-ui';const x=<Button {...unknown} open={state} onToggle={setState}/>;");
  assert.equal(result.usages[0].disposition, 'unsupported-spread');
  assert.equal(result.usages[0].props[0].kind, 'spread');
  assert.ok(result.usages[0].flags.some((flag) => flag.includes('Controlled visibility')));
});

test('structural children remain visible to migration review', () => {
  const result = inspect("import {Button} from 'old-ui';const x=<Button><Menu/></Button>;");
  assert.ok(result.usages[0].flags.some((flag) => flag.includes('structural migration')));
});

test('wrappers, aliases and factories create unsupported reference evidence', () => {
  const result = inspect("import {Button} from 'old-ui'; const Alias=Button; const Styled=styled(Button); const x=<Alias/>;");
  assert.equal(result.usages.length, 0);
  assert.equal(result.unsupported.filter((s) => s.kind === 'non-jsx-reference').length, 2);
});

test('namespace factories are unsupported references rather than silent omissions', () => {
  const result = inspect("import * as Old from 'old-ui'; const Wrapped=styled(Old.Button);");
  assert.equal(result.usages.length, 0);
  assert.equal(result.unsupported.length, 1);
});

test('namespace aliases and computed access are explicitly unsupported', () => {
  const result = inspect("import * as Old from 'old-ui'; const Alias=Old; const B=Old['Button'];");
  assert.equal(result.usages.length, 0);
  assert.equal(result.unsupported.filter((u) => u.kind === 'namespace-reference').length, 2);
});

test('re-exports, CommonJS and dynamic imports are explicitly unsupported', () => {
  const result = inspect("export {Button} from 'old-ui'; const Old=require('old-ui'); const lazy=import('old-ui');");
  assert.equal(result.usages.length, 0);
  assert.equal(result.unsupported.length, 3);
});

test('local wrapper origins are not claimed as resolved package usages', () => {
  const result = inspect("import Button from './wrapper'; const x=<Button/>;");
  assert.equal(result.usages.length, 0);
  assert.equal(result.unsupported[0].kind, 'local-import');
});

test('type-only imports are not treated as runtime component identity', () => {
  assert.equal(inspect("import type {Button} from 'old-ui'; const x=<Button/>;").usages.length, 0);
});

test('malformed source produces explicit syntax diagnostics', () => {
  assert.ok(inspect("import {Button} from 'old-ui';const x=<Button ").syntaxDiagnostics.length);
});

test('source rules reject duplicates and unsupported compiler versions', async () => {
  assert.throws(() => validateSourceRules({ schemaVersion: 1, sources: [rules.sources[0], rules.sources[0]] }), /Duplicate/);
  await assert.rejects(loadCompiler(null), /Pass --compiler/);
  assert.match(identity.version, /^5\.9\./);
  assert.match(identity.sha256, /^[a-f0-9]{64}$/);
});

test('inspection never executes a source file', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shift-parse-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'danger.jsx'), "throw new Error('must not execute'); import {Button} from 'old-ui';const x=<Button/>;");
  const report = await inspectSource(root, rules, process.env.SHIFT_TYPESCRIPT_PATH);
  assert.equal(report.usages.length, 1);
  assert.equal(report.readiness, 'not-verified');
});

test('real historical files match the separately registered direct usages', async () => {
  const root = path.resolve('experiments/superset-dropdown');
  const sourceRules = JSON.parse(await fs.readFile(path.join(root, 'source-rules.json'), 'utf8'));
  const registration = JSON.parse(await fs.readFile(path.join(root, 'registration.json'), 'utf8'));
  const report = await inspectSource(path.join(root, 'input'), sourceRules, process.env.SHIFT_TYPESCRIPT_PATH);
  assert.equal(report.syntaxDiagnostics.length, 0);
  assert.equal(report.usages.length, registration.sourceUsages.reduce((sum, item) => sum + item.count, 0));
  for (const expected of registration.sourceUsages) {
    assert.equal(report.usages.filter((u) => u.file === expected.file && u.origin.module === expected.module).length, expected.count);
  }
});
