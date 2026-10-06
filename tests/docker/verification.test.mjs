import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPlan } from '../../src/contract.mjs';
import { digest, readJson, writeJson } from '../../src/files.mjs';
import { migrate, verify } from '../../src/run.mjs';
import { buildReport } from '../../src/report.mjs';
import { execute, resolveImage, runCheck } from '../../src/sandbox.mjs';

const image = process.env.SHIFT_TEST_IMAGE ?? 'node:22-alpine';
async function prepare(t, mutate = () => {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shift-docker-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.cp(path.resolve('fixtures/consolidation/checkout'), path.join(root, 'fixture'), { recursive: true });
  const file = path.join(root, 'fixture/case.json');
  const c = await readJson(file); mutate(c);
  await fs.writeFile(file, JSON.stringify(c));
  await writeJson(path.join(root, 'plan.json'), await createPlan(file));
  return migrate(path.join(root, 'plan.json'), path.join(root, 'run'));
}

test('baseline and migrated descriptor behavior pass independently', async (t) => {
  const run = await prepare(t);
  const evidence = await verify(run.dir, image);
  assert.equal(evidence.checks[0].baseline.status, 'passed');
  assert.equal(evidence.checks[0].candidate.status, 'passed');
  assert.equal((await buildReport(run.dir)).fixtureResult, 'partial-with-blockers');
  await assert.rejects(verify(run.dir, image), { code: 'EEXIST' });
  await fs.appendFile(path.join(run.dir, 'candidate-behavior.log'), 'tampered');
  await assert.rejects(buildReport(run.dir), /log changed/);
});

test('independent expectations catch lost form-submit semantics', async (t) => {
  const run = await prepare(t, (c) => {
    const edit = c.units.find((u) => u.id === 'submit').edits[0];
    edit.after = edit.after.replace(", type: 'submit'", '');
    edit.afterSha256 = digest(edit.after);
  });
  const evidence = await verify(run.dir, image);
  assert.equal(evidence.checks[0].baseline.status, 'passed');
  assert.equal(evidence.checks[0].candidate.status, 'failed');
  assert.equal((await buildReport(run.dir)).fixtureResult, 'verification-incomplete-or-failed');
});

test('a passing configured check cannot hide a missing required check', async (t) => {
  const run = await prepare(t, (c) => { c.requiredChecks.push('accessibility'); });
  const output = await execute(process.execPath, ['src/cli.mjs', 'verify', '--run', run.dir, '--image', image]);
  assert.equal(output.code, 3, output.stderr);
  const report = await buildReport(run.dir);
  assert.equal(report.requiredChecks.find((c) => c.id === 'accessibility').candidate, 'not-configured');
  assert.equal(report.fixtureResult, 'verification-incomplete-or-failed');
});

test('container enforces the tested mount, network and privilege boundaries', async () => {
  process.env.SHIFT_HOST_SECRET_SENTINEL = 'not-for-container';
  try {
    const result = await runCheck({
      image: await resolveImage(image), consumer: path.resolve('fixtures/consolidation/checkout/consumer'),
      oracle: path.resolve('tests/probes/containment.test.mjs'), timeoutMs: 10000, expectedTests: 4,
    });
    assert.equal(result.status, 'passed', result.stdout + result.stderr);
  } finally { delete process.env.SHIFT_HOST_SECRET_SENTINEL; }
});

test('timeout removes the container as well as its client process', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shift-timeout-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const oracle = path.join(root, 'hung.test.mjs');
  await fs.writeFile(oracle, "import test from 'node:test'; test('hang', async () => { await new Promise(() => {}); }); setInterval(() => {}, 1000);");
  const result = await runCheck({
    image: await resolveImage(image), consumer: path.resolve('fixtures/consolidation/checkout/consumer'),
    oracle, timeoutMs: 500, expectedTests: 1,
  });
  assert.equal(result.stopped, 'timeout');
  const inspect = await execute('docker', ['container', 'inspect', result.container]);
  assert.notEqual(inspect.code, 0, 'Timed-out container was left running');
});
