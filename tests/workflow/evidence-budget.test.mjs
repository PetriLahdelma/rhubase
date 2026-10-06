import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { artifactSnapshot, treeSnapshot } from '../../src/workflow-files.mjs';
import { validateAgentContext } from '../../src/workflow-agent.mjs';

async function directory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shift-evidence-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('evidence hash accepts multiple admitted copies over the source byte budget', async (t) => {
  const root = await directory(t);
  for (const part of ['baseline', 'candidate']) {
    await fs.mkdir(path.join(root, part));
    for (let i = 0; i < 11; i++) await fs.writeFile(path.join(root, part, `${i}.dat`), Buffer.alloc(4_800_000, i));
    assert.equal(Object.keys((await treeSnapshot(path.join(root, part))).files).length, 11);
  }
  await fs.writeFile(path.join(root, 'changes.patch'), Buffer.alloc(6_000_000, 'p'));
  const snapshot = await artifactSnapshot(root);
  assert.equal(Object.keys(snapshot.files).length, 23);
  assert.equal(snapshot.files['changes.patch'].bytes, 6_000_000);
});

test('evidence hash accepts more than ten thousand files across source copies', async (t) => {
  const root = await directory(t);
  await fs.mkdir(path.join(root, 'baseline')); await fs.mkdir(path.join(root, 'candidate'));
  const seed = path.join(root, 'seed'); await fs.writeFile(seed, '');
  for (let i = 0; i < 5010; i++) {
    await fs.link(seed, path.join(root, 'baseline', `${i}.txt`));
    await fs.link(seed, path.join(root, 'candidate', `${i}.txt`));
  }
  const snapshot = await artifactSnapshot(root);
  assert.equal(Object.keys(snapshot.files).length, 10021);
});

test('combined agent context fails admission before source and references are copied', () => {
  assert.throws(() => validateAgentContext({ files: { source: { bytes: 52_000_000 } } }, [{ files: { reference: { bytes: 52_000_000 } } }], 'task'), /Combined agent/);
  const many = { files: Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [String(i), { bytes: 0 }])) };
  assert.throws(() => validateAgentContext(many, [many], 'task'), /Combined agent/);
  assert.equal(validateAgentContext({ files: { src: { bytes: 100 } } }, [{ files: { ref: { bytes: 100 } } }], 'task').files, 3);
});
