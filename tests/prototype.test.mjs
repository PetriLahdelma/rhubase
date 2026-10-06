import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPlan, validateContract } from '../src/contract.mjs';
import { createOutput, digest, readJson, snapshot, writeJson } from '../src/files.mjs';
import { migrate, verify } from '../src/run.mjs';
import { buildReport, writeReport } from '../src/report.mjs';
import { containerArgs, execute, interpretTest } from '../src/sandbox.mjs';
import { unifiedPatch } from '../src/patch.mjs';

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shift-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fixture = path.join(root, 'fixture');
  await fs.cp(path.resolve('fixtures/consolidation/checkout'), fixture, { recursive: true });
  return { root, fixture, file: path.join(fixture, 'case.json'), consumer: path.join(fixture, 'consumer') };
}

async function editCase(env, transform) {
  const c = await readJson(env.file);
  transform(c);
  await fs.writeFile(env.file, JSON.stringify(c, null, 2) + '\n');
}

async function planned(env) {
  const plan = await createPlan(env.file);
  const planFile = path.join(env.root, 'plan.json');
  await writeJson(planFile, plan);
  return { plan, planFile };
}

test('manual inventory reconciles mapped, target-gap and unsupported sites', async (t) => {
  const env = await setup(t);
  const plan = await createPlan(env.file);
  assert.equal(plan.usages.length, 7);
  assert.equal(plan.units.length, 4);
  assert.equal(plan.usages.filter((u) => u.status === 'planned').length, 5);
  assert.equal(plan.usages.filter((u) => u.status === 'target-gap').length, 1);
  assert.equal(plan.usages.filter((u) => u.status === 'unsupported').length, 1);
  assert.equal(plan.inventory.kind, 'manual');
});

test('missing and ambiguous manual usage anchors fail rather than inflate counts', async (t) => {
  const env = await setup(t);
  await editCase(env, (c) => { c.usages[0].anchor = 'not-present'; });
  await assert.rejects(createPlan(env.file), /Missing or ambiguous usage anchor/);
  await editCase(env, (c) => { c.usages[0].anchor = 'import'; });
  await assert.rejects(createPlan(env.file), /Missing or ambiguous usage anchor/);
});

test('migration changes only planned files and preserves the original tree', async (t) => {
  const env = await setup(t);
  const initial = await snapshot(env.consumer);
  const { planFile } = await planned(env);
  const run = await migrate(planFile, path.join(env.root, 'run'));
  assert.equal((await snapshot(env.consumer)).digest, initial.digest);
  assert.equal(run.changes.length, 4);
  for (const file of ['src/loading.mjs', 'src/dynamic.mjs', 'systems/commerce.mjs', 'systems/admin.mjs', 'systems/foundation.mjs']) {
    assert.equal(run.candidate.files[file].sha256, initial.files[file].sha256);
  }
  assert.match(await fs.readFile(path.join(run.dir, 'candidate/src/form.mjs'), 'utf8'), /type: 'submit'/);
  const report = await writeReport(run.dir);
  assert.deepEqual(report.counts, { registered: 7, changed: 5, alreadyApplied: 0, blocked: 0, targetGap: 1, unsupported: 1 });
  assert.equal(report.readiness, 'unvalidated-prototype');
  assert.equal(report.requiredChecks[0].candidate, 'not-configured');
  assert.equal(report.fixtureResult, 'verification-incomplete-or-failed');
});

test('pending shared provider decision blocks all dependent edits', async (t) => {
  const env = await setup(t);
  await editCase(env, (c) => { c.decisions[0].status = 'pending'; });
  const { plan, planFile } = await planned(env);
  assert.equal(plan.units.filter((u) => u.status === 'blocked').length, 4);
  const run = await migrate(planFile, path.join(env.root, 'run'));
  assert.equal(run.changes.length, 0);
  assert.equal(run.candidate.digest, run.baseline.digest);
  assert.equal((await buildReport(run.dir)).counts.blocked, 5);
});

test('target and consumer drift invalidate an existing plan', async (t) => {
  for (const changed of ['src/form.mjs', 'systems/foundation.mjs']) {
    const env = await setup(t);
    const { planFile } = await planned(env);
    await fs.appendFile(path.join(env.consumer, changed), '// drift\n');
    await assert.rejects(migrate(planFile, path.join(env.root, 'run')), /Stale/);
    await assert.rejects(fs.stat(path.join(env.root, 'run')), { code: 'ENOENT' });
  }
});

test('changed shared decisions invalidate completed run evidence', async (t) => {
  const env = await setup(t);
  const { planFile } = await planned(env);
  const run = await migrate(planFile, path.join(env.root, 'run'));
  await editCase(env, (c) => { c.decisions[0].rationale += ' Revised.'; });
  await assert.rejects(buildReport(run.dir), /Stale plan/);
});

test('second application reuses decision structure with explicit different inputs', async () => {
  const first = await createPlan('fixtures/consolidation/checkout/case.json');
  const second = await createPlan('fixtures/consolidation/account/case.json');
  assert.deepEqual(first.units.map((u) => u.id), second.units.map((u) => u.id));
  assert.notEqual(first.input.digest, second.input.digest);
  assert.notEqual(first.planHash, second.planHash);
});

test('already migrated exact files produce no additional edits', async (t) => {
  const env = await setup(t);
  const c = await readJson(env.file);
  for (const unit of c.units) for (const edit of unit.edits) await fs.writeFile(path.join(env.consumer, edit.file), edit.after);
  const { plan, planFile } = await planned(env);
  assert.ok(plan.units.every((u) => u.status === 'already-applied'));
  const run = await migrate(planFile, path.join(env.root, 'run'));
  assert.equal(run.changes.length, 0);
  assert.equal((await buildReport(run.dir)).counts.alreadyApplied, 5);
});

test('duplicate IDs, cyclic dependencies and overlapping units are rejected', async (t) => {
  const env = await setup(t);
  const original = await readJson(env.file);
  const duplicate = structuredClone(original); duplicate.usages.push(duplicate.usages[0]);
  assert.throws(() => validateContract(duplicate), /Duplicate usage/);
  const cycle = structuredClone(original); cycle.units[0].requires = ['submit'];
  assert.throws(() => validateContract(cycle), /Cyclic/);
  const overlap = structuredClone(original); overlap.units[1].edits = overlap.units[0].edits;
  assert.throws(() => validateContract(overlap), /same file/);
});

test('consumer symlinks and traversal paths cannot escape source boundaries', async (t) => {
  const env = await setup(t);
  await fs.symlink('/etc/passwd', path.join(env.consumer, 'src/escape.mjs'));
  await assert.rejects(createPlan(env.file), /Symlink/);
  const c = await readJson(env.file); c.units[0].edits[0].file = '../escape.mjs';
  assert.throws(() => validateContract(c), /Unsafe path/);
});

test('oracles cannot reside inside the mutable consumer', async (t) => {
  const env = await setup(t);
  await fs.copyFile(path.join(env.fixture, 'oracles/behavior.test.mjs'), path.join(env.consumer, 'behavior.test.mjs'));
  await editCase(env, (c) => { c.checks[0].oracle = 'consumer/behavior.test.mjs'; });
  await assert.rejects(createPlan(env.file), /outside the consumer/);
});

test('tampered oracle and forged plan hashes are rejected', async (t) => {
  const env = await setup(t);
  const { plan, planFile } = await planned(env);
  plan.units[0].status = 'already-applied';
  await fs.writeFile(planFile, JSON.stringify(plan));
  await assert.rejects(migrate(planFile, path.join(env.root, 'run')), /altered/);
  await fs.appendFile(path.join(env.fixture, 'oracles/behavior.test.mjs'), '// changed');
  await assert.rejects(createPlan(env.file), /Oracle hash/);
});

test('candidate edits invalidate reports and cannot be relabeled checked', async (t) => {
  const env = await setup(t);
  const { planFile } = await planned(env);
  const run = await migrate(planFile, path.join(env.root, 'run'));
  await fs.appendFile(path.join(run.dir, 'candidate/src/form.mjs'), '// manual change');
  await assert.rejects(buildReport(run.dir), /snapshot changed/);
});

test('exclusive outputs refuse to overwrite user files and runs', async (t) => {
  const env = await setup(t);
  const { planFile } = await planned(env);
  const output = path.join(env.root, 'run');
  await migrate(planFile, output);
  await fs.writeFile(path.join(output, 'user-note.txt'), 'keep');
  await assert.rejects(migrate(planFile, output), { code: 'EEXIST' });
  assert.equal(await fs.readFile(path.join(output, 'user-note.txt'), 'utf8'), 'keep');
  await assert.rejects(createOutput(path.join(env.consumer, 'out'), [env.consumer]), /outside input/);
});

test('secrets and unsupported input trees fail before copying', async (t) => {
  const env = await setup(t);
  await fs.writeFile(path.join(env.consumer, '.env'), 'SECRET=do-not-copy');
  await assert.rejects(createPlan(env.file), /secret file/);
});

test('TAP evidence fails closed for missing tests, skips, timeout and exit failure', () => {
  const good = { code: 0, stopped: null, stdout: '# tests 6\n# pass 6\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n' };
  assert.equal(interpretTest(good, 6), 'passed');
  assert.equal(interpretTest(good, 7), 'failed');
  assert.equal(interpretTest({ ...good, stdout: '' }, 6), 'failed');
  assert.equal(interpretTest({ ...good, stdout: good.stdout.replace('# skipped 0', '# skipped 1') }, 6), 'failed');
  assert.equal(interpretTest({ ...good, code: 1 }, 6), 'failed');
  assert.equal(interpretTest({ ...good, stopped: 'timeout' }, 6), 'inconclusive');
});

test('runner fixes containment flags and rejects invalid mount syntax', () => {
  const args = containerArgs({ name: 'test', image: 'sha256:abc', consumer: '/tmp/consumer', oracle: '/tmp/oracle', phase: 'baseline' });
  for (const flag of ['--network=none', '--read-only', '--cap-drop=ALL', '--pull=never', '--user=65534:65534']) assert.ok(args.includes(flag));
  assert.ok(args.includes('SHIFT_PHASE=baseline'));
  assert.ok(!args.some((a) => a.includes('docker.sock')));
  assert.throws(() => containerArgs({ name: 'test', image: 'x', consumer: '/tmp,readonly=false', oracle: '/tmp/oracle' }), /mount path/);
});

test('supervisor bounds noisy and hung processes', async () => {
  const hung = await execute(process.execPath, ['-e', 'setInterval(()=>{},1000)'], 100);
  assert.equal(hung.stopped, 'timeout');
  const noisy = await execute(process.execPath, ['-e', 'process.stdout.write("x".repeat(100000))'], 1000, 100);
  assert.equal(noisy.stopped, 'output-limit');
});

test('CLI emits structured errors and cannot return production readiness', async () => {
  const wrong = await execute(process.execPath, ['src/cli.mjs', 'plan']);
  assert.equal(wrong.code, 1);
  assert.match(JSON.parse(wrong.stderr).error, /Missing --case/);
  const analyze = await execute(process.execPath, ['src/cli.mjs', 'analyze', '--case', 'fixtures/consolidation/checkout/case.json', '--require-ready']);
  assert.equal(analyze.code, 2);
  assert.equal(JSON.parse(analyze.stdout).kind, 'controlled-fixture');
});

test('missing Docker image never falls back to host execution', async (t) => {
  const env = await setup(t);
  const { planFile } = await planned(env);
  const run = await migrate(planFile, path.join(env.root, 'run'));
  await assert.rejects(verify(run.dir, '-unsafe-image'), /Invalid Docker/);
  assert.equal((await buildReport(run.dir)).requiredChecks[0].candidate, 'not-configured');
});

test('one file changed in a multi-file unit is rejected as partial state', async (t) => {
  const env = await setup(t);
  await editCase(env, (c) => {
    c.units[0].edits.push(...c.units[1].edits);
    c.usages.find((u) => u.unit === 'submit').unit = 'provider';
    c.units.splice(1, 1);
  });
  const c = await readJson(env.file);
  await fs.writeFile(path.join(env.consumer, c.units[0].edits[0].file), c.units[0].edits[0].after);
  await assert.rejects(createPlan(env.file), /partially applied/);
});

test('new source files invalidate the plan even outside edited files', async (t) => {
  const env = await setup(t);
  const { planFile } = await planned(env);
  await fs.writeFile(path.join(env.consumer, 'src/new-use.mjs'), 'export const newUsage = 1;');
  await assert.rejects(migrate(planFile, path.join(env.root, 'run')), /Stale plan/);
});

test('the source-bound edit cannot rewrite its test oracle', async (t) => {
  const env = await setup(t);
  const c = await readJson(env.file);
  c.units[0].edits[0].file = 'oracles/behavior.test.mjs';
  assert.throws(() => validateContract(c), /source files under src/);
  c.units[0].edits[0].file = 'src/theme.mjs';
  c.units[0].edits[0].after = 'unreviewed';
  assert.throws(() => validateContract(c), /hash\/content mismatch/);
});

test('generated patch is applicable to the baseline without a Git repository', async (t) => {
  const env = await setup(t);
  const { planFile } = await planned(env);
  const run = await migrate(planFile, path.join(env.root, 'run'));
  const result = await execute('git', ['-C', path.join(run.dir, 'baseline'), 'apply', '--check', path.join(run.dir, 'changes.patch')]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(unifiedPatch([{ file: 'src/no-newline.mjs', before: 'old', after: 'new\n' }]), /No newline at end of file/);
  await fs.appendFile(path.join(run.dir, 'changes.patch'), 'tamper');
  await assert.rejects(buildReport(run.dir), /patch changed/);
});
