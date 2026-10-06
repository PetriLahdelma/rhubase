import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { copySnapshot, createOutput, demand, digest, jsonDigest, readJson, safePath, snapshot, writeJson } from './files.mjs';
import { validatePlan } from './contract.mjs';
import { resolveImage, runCheck } from './sandbox.mjs';
import { unifiedPatch } from './patch.mjs';

export async function migrate(planFile, out) {
  const plan = await readJson(planFile);
  const loaded = await validatePlan(plan);
  const dir = await createOutput(out, [path.dirname(loaded.caseFile), loaded.consumer]);
  let seq = 0;
  const event = async (operation, state, data = {}) => fs.appendFile(path.join(dir, 'events.jsonl'), JSON.stringify({ sequence: ++seq, operation, state, ...data }) + '\n');
  try {
    await writeJson(path.join(dir, 'plan.json'), plan);
    await writeJson(path.join(dir, 'contract.json'), loaded.contract);
    const candidate = path.join(dir, 'candidate');
    const baseline = path.join(dir, 'baseline');
    await fs.mkdir(candidate); await fs.mkdir(baseline);
    await event('snapshot', 'prepared', { inputHash: loaded.input.digest });
    await copySnapshot(loaded.consumer, baseline, loaded.input);
    await copySnapshot(loaded.consumer, candidate, loaded.input);
    await event('snapshot', 'committed');
    await fs.mkdir(path.join(dir, 'oracles'));
    for (const [id, oracle] of Object.entries(loaded.oracles)) {
      const content = await fs.readFile(oracle.file);
      demand(digest(content) === oracle.sha256, 'Oracle changed while copying');
      await fs.writeFile(path.join(dir, 'oracles', id + '.test.mjs'), content, { flag: 'wx' });
    }
    const changes = []; const appliedEdits = [];
    for (const unit of plan.units) {
      if (unit.status !== 'planned') continue;
      const specification = loaded.contract.units.find((u) => u.id === unit.id);
      await event(unit.id, 'prepared');
      for (const edit of specification.edits) {
        const file = await safePath(candidate, edit.file);
        demand(digest(await fs.readFile(file)) === edit.beforeSha256, `Candidate preimage mismatch: ${edit.file}`);
        const temporary = file + '.shift-tmp';
        await fs.writeFile(temporary, edit.after, { flag: 'wx' });
        await fs.rename(temporary, file);
        changes.push({ unit: unit.id, file: edit.file, beforeSha256: edit.beforeSha256, afterSha256: edit.afterSha256 });
        appliedEdits.push(edit);
      }
      await event(unit.id, 'applied');
      await event(unit.id, 'committed');
    }
    const candidateSnapshot = await snapshot(candidate);
    const patch = unifiedPatch(appliedEdits);
    await fs.writeFile(path.join(dir, 'changes.patch'), patch, { flag: 'wx' });
    const record = {
      schemaVersion: 1, runId: randomUUID(), caseId: plan.caseId,
      kind: plan.kind, createdAt: new Date().toISOString(), planHash: plan.planHash,
      contractHash: loaded.contractHash, baseline: loaded.input,
      candidate: candidateSnapshot, changes, patchSha256: digest(patch),
      engine: { runtime: process.version, sourceHash: (await snapshot(fileURLToPath(new URL('.', import.meta.url)))).digest },
    };
    await writeJson(path.join(dir, 'run.json'), record);
    await event('run', 'committed', { candidateHash: candidateSnapshot.digest });
    return { dir, ...record };
  } catch (error) {
    await event('run', 'failed', { message: error.message });
    throw error;
  }
}

export async function inspectRun(dir) {
  dir = await fs.realpath(dir);
  const run = await readJson(path.join(dir, 'run.json'));
  const plan = await readJson(path.join(dir, 'plan.json'));
  const contract = await readJson(path.join(dir, 'contract.json'));
  demand(run.schemaVersion === 1 && run.planHash === plan.planHash, 'Invalid run/plan');
  demand(jsonDigest(contract) === run.contractHash, 'Run contract changed');
  const { planHash, ...payload } = plan;
  demand(jsonDigest(payload) === planHash, 'Run plan changed');
  await validatePlan(plan); // Source or shared decision drift invalidates this run.
  demand(run.contractHash === plan.contractHash && run.baseline.digest === plan.input.digest, 'Run provenance mismatch');
  demand(digest(await fs.readFile(await safePath(dir, 'changes.patch'))) === run.patchSha256, 'Run patch changed');
  const baseline = await snapshot(path.join(dir, 'baseline'));
  const candidate = await snapshot(path.join(dir, 'candidate'));
  demand(baseline.digest === run.baseline.digest && candidate.digest === run.candidate.digest, 'Run snapshot changed; evidence is stale');
  for (const check of contract.checks) {
    const file = await safePath(dir, `oracles/${check.id}.test.mjs`);
    demand(digest(await fs.readFile(file)) === check.sha256, 'Run oracle changed');
  }
  return { dir, run, plan, contract };
}

export async function verify(dir, image) {
  const inspected = await inspectRun(dir);
  dir = inspected.dir;
  const { run, contract } = inspected;
  // A failed/interrupted verification leaves an exclusive marker and cannot be
  // relabeled successful by retry. Use a new run; general resume is deferred.
  const lock = await fs.open(path.join(dir, 'verification.lock'), 'wx');
  await lock.close();
  const checks = [];
  try {
    const imageId = await resolveImage(image);
    for (const check of contract.checks) {
      const phases = {};
      for (const phase of ['baseline', 'candidate']) {
        const result = await runCheck({
          image: imageId, phase, consumer: path.join(dir, phase),
          oracle: path.join(dir, 'oracles', check.id + '.test.mjs'),
          timeoutMs: check.timeoutMs, expectedTests: check.expectedTests,
        });
        demand(result.stopped !== 'cancelled', 'Verification cancelled');
        const log = `${phase}-${check.id}.log`;
        await fs.writeFile(path.join(dir, log), result.stdout + result.stderr, { flag: 'wx' });
        phases[phase] = {
          status: result.status, exitCode: result.code, stopped: result.stopped,
          durationMs: result.durationMs, log, logSha256: digest(result.stdout + result.stderr),
        };
      }
      checks.push({ id: check.id, oracleSha256: check.sha256, ...phases });
    }
    await inspectRun(dir);
    const evidence = {
      schemaVersion: 1, runId: run.runId, planHash: run.planHash,
      contractHash: run.contractHash, baselineHash: run.baseline.digest,
      candidateHash: run.candidate.digest, image: imageId, checks,
      scope: 'Controlled fixture Node tests; no browser, React, visual, accessibility or hostile-code proof.',
    };
    await writeJson(path.join(dir, 'verification.json'), evidence);
    return evidence;
  } catch (error) {
    await writeJson(path.join(dir, 'verification-error.json'), { message: error.message });
    throw error;
  }
}
