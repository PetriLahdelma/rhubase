import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { auditAgentChanges, auditAgentCode } from '../../src/workflow-agent.mjs';
import { treeSnapshot } from '../../src/workflow-files.mjs';

const snapshot = (entries) => ({
  files: Object.fromEntries(Object.entries(entries).map(([file, sha256]) => [file, { sha256, bytes: 1 }])),
});

test('agent audit accepts edits to a discovered application source file', () => {
  const before = snapshot({ 'project/src/App.jsx': 'before', 'project/src/helper.js': 'same' });
  const after = snapshot({ 'project/src/App.jsx': 'after', 'project/src/helper.js': 'same' });
  assert.deepEqual(auditAgentChanges(before, after, new Set(['src/App.jsx'])), ['project/src/App.jsx']);
});

test('agent audit rejects edits outside the discovered migration scope', () => {
  const before = snapshot({ 'project/src/App.jsx': 'before', 'project/src/helper.js': 'same' });
  const after = snapshot({ 'project/src/App.jsx': 'before', 'project/src/helper.js': 'after' });
  assert.throws(() => auditAgentChanges(before, after, new Set(['src/App.jsx'])), /outside the discovered\/declared migration scope/);
});

test('agent audit rejects changes to tests', () => {
  const before = snapshot({ 'project/src/App.jsx': 'same', 'project/tests/App.test.jsx': 'before' });
  const after = snapshot({ 'project/src/App.jsx': 'same', 'project/tests/App.test.jsx': 'after' });
  assert.throws(() => auditAgentChanges(before, after), /protected file/);
});

test('agent audit rejects changes to build and verification configuration', () => {
  const before = snapshot({ 'project/src/App.jsx': 'same', 'project/vite.config.js': 'before' });
  const after = snapshot({ 'project/src/App.jsx': 'same', 'project/vite.config.js': 'after' });
  assert.throws(() => auditAgentChanges(before, after), /protected file/);
});

test('agent audit rejects file additions and removals', () => {
  const before = snapshot({ 'project/src/App.jsx': 'same' });
  const after = snapshot({ 'project/src/App.jsx': 'same', 'project/src/new.jsx': 'new' });
  assert.throws(() => auditAgentChanges(before, after), /added or removed files/);
});

test('agent audit rejects a newly introduced hidden Git configuration', () => {
  const before = snapshot({ 'project/src/App.jsx': 'same' });
  const after = snapshot({ 'project/src/App.jsx': 'same', 'project/.git/config': 'new' });
  assert.throws(() => auditAgentChanges(before, after), /added or removed files|metadata|hidden/i);
});

test('agent workspace snapshot rejects hidden Git metadata before it can evade the file audit', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shift-agent-policy-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'project/.git'), { recursive: true });
  await fs.writeFile(path.join(root, 'project/.git/config'), '[core]\nrepositoryformatversion = 0\n');
  await assert.rejects(treeSnapshot(root, { excludeGenerated: false, rejectGit: true }), /Unexpected Git metadata/);
});

test('agent audit rejects changes outside the candidate project', () => {
  const before = snapshot({ 'project/src/App.jsx': 'same', 'reference/0/guide.md': 'before' });
  const after = snapshot({ 'project/src/App.jsx': 'same', 'reference/0/guide.md': 'after' });
  assert.throws(() => auditAgentChanges(before, after), /protected file/);
});

for (const file of [
  'project/rollup.config.js',
  'project/cypress.config.ts',
  'project/src/widget.config.ts',
  'project/.storybook/main.js',
  'project/src/widget.cy.tsx',
  'project/src/widget.e2e.ts',
  'project/src/widget.integration.js',
  'project/src/widget.tests.ts',
  'project/src/Widget.stories.tsx',
]) {
  test(`agent audit rejects protected convention file ${file}`, () => {
    const before = snapshot({ [file]: 'before' });
    const after = snapshot({ [file]: 'after' });
    assert.throws(() => auditAgentChanges(before, after), /protected file/);
  });
}

for (const [label, suppression] of [
  ['TypeScript expect error', '// @ts-expect-error'],
  ['c8 ignore', '/* c8 ignore next */'],
  ['Istanbul ignore', '/* istanbul ignore next */'],
  ['Biome ignore', '// biome-ignore lint/suspicious/noExplicitAny: bypass'],
  ['oxlint disable', '// oxlint-disable no-unused-vars'],
  ['test skip', "test.skip('migration', () => {})"],
  ['test only', "test.only('migration', () => {})"],
]) {
  test(`agent code audit rejects newly introduced ${label}`, () => {
    assert.throws(
      () => auditAgentCode('export const value = 1;\n', `${suppression}\nexport const value = 1;\n`, 'src/value.ts'),
      /suppression/i,
    );
  });
}

test('agent code audit permits an existing suppression that was not increased', () => {
  const source = '// @ts-expect-error\nexport const value = legacy;\n';
  assert.doesNotThrow(() => auditAgentCode(source, source.replace('legacy', 'replacement'), 'src/value.ts'));
});

test('agent code audit rejects duplicating an existing process exit suppression', () => {
  const original = 'if (fatal) process.exit(1);\n';
  const proposed = 'if (fatal) process.exit(1);\nif (alsoFatal) process.exit(2);\n';
  assert.throws(() => auditAgentCode(original, proposed, 'src/runner.ts'), /suppression/i);
});
