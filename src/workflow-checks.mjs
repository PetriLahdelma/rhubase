import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseProject } from './source-analysis.mjs';
import { treeSnapshot, readSources } from './workflow-files.mjs';
import { resolveImage, interpretTest, execute } from './sandbox.mjs';
import { runProcess } from './process.mjs';
import { evaluateSourceCase } from '../scripts/evaluate-source-case.mjs';
import { verifyBrowserDemo } from '../scripts/browser-demo.mjs';
import { demand } from './files.mjs';

async function syntax(ts, project) {
  const sources = await readSources(project, await treeSnapshot(project));
  const diagnostics = parseProject(ts, sources).diagnostics;
  return { status: diagnostics.length ? 'failed' : 'passed', scope: 'syntax', diagnostics, files: sources.size };
}

export function assertComparableImages(baseline, candidate, expectedImage) {
  if (baseline.status === 'passed' && candidate.status === 'passed') {
    demand(baseline.image === expectedImage && candidate.image === expectedImage, 'Baseline and candidate verification images differ');
  }
}

async function dockerTest(project, spec, directory, signal) {
  const image = await resolveImage(spec.image);
  demand(!/[\x00-\x1f,]/.test(project), 'Unsafe Docker mount path');
  const name = `shift-workflow-${randomUUID()}`;
  const args = [
    'run', '--rm', '--pull=never', '--name', name, '--network=none', '--read-only',
    '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user=65534:65534',
    '--pids-limit=128', '--memory=512m', '--memory-swap=512m', '--cpus=2',
    '--tmpfs=/tmp:rw,noexec,nosuid,size=32m', '--mount', `type=bind,source=${project},target=/workspace,readonly`,
    '--workdir=/workspace', '--entrypoint', spec.command[0], image, ...spec.command.slice(1),
  ];
  let result;
  try { result = await runProcess('docker', args, { timeoutMs: spec.timeoutMs ?? 60000, signal }); }
  finally { await execute('docker', ['rm', '-f', name], 5000); }
  await fs.writeFile(path.join(directory, 'stdout.log'), result.stdout);
  await fs.writeFile(path.join(directory, 'stderr.log'), result.stderr);
  return { status: interpretTest(result, spec.expectedTests), scope: 'runtime-tests', exitCode: result.code, stopped: result.stopped, durationMs: result.durationMs, image, command: spec.command };
}

export async function runWorkflowChecks({ config, ts, compiler, baseline, candidate, runDirectory, signal, onProgress = () => {} }) {
  const syntaxSpec = config.checks.find((c) => c.kind === 'syntax');
  const specs = [{ id: syntaxSpec?.id ?? 'shift-syntax', kind: 'syntax', required: true }, ...config.checks.filter((c) => c.kind !== 'syntax')];
  const checks = [];
  for (const spec of specs) {
    demand(!signal?.aborted, 'Run cancelled');
    onProgress('verify', spec.id);
    const directory = path.join(runDirectory, 'checks', spec.id);
    await fs.mkdir(directory, { recursive: true });
    const pinnedImage = spec.image ? await resolveImage(spec.image) : null;
    demand(!signal?.aborted, 'Run cancelled');
    let baselineResult; let candidateResult;
    if (spec.kind === 'superset-source') {
      baselineResult = { status: 'not-applicable', scope: 'source-contract', reason: 'Target-state assertions apply to the candidate' };
      const result = await evaluateSourceCase(baseline, candidate, compiler);
      candidateResult = { ...result, scope: 'source-contract', status: result.needsReview ? 'failed' : 'passed' };
    } else {
      const phases = {};
      for (const [phase, project] of [['baseline', baseline], ['candidate', candidate]]) {
        demand(!signal?.aborted, 'Run cancelled');
        onProgress('verify-phase', `${spec.id}:${phase}`);
        demand(!signal?.aborted, 'Run cancelled');
        const outputDir = path.join(directory, phase);
        await fs.mkdir(outputDir);
        if (spec.kind === 'syntax') phases[phase] = await syntax(ts, project);
        else if (spec.kind === 'browser-demo') {
          demand(config.toolchain, 'browser-demo requires an explicit toolchain or SHIFT_TOOLCHAIN');
          phases[phase] = await verifyBrowserDemo({ project, phase, outputDir, toolchain: config.toolchain, image: pinnedImage, signal, timeoutMs: spec.timeoutMs ?? 30000, retainedUnresolved: spec.retainedUnresolved });
          await fs.writeFile(path.join(outputDir, 'stdout.log'), phases[phase].logs.stdout);
          await fs.writeFile(path.join(outputDir, 'stderr.log'), phases[phase].logs.stderr);
        } else if (spec.kind === 'docker') phases[phase] = await dockerTest(project, { ...spec, image: pinnedImage }, outputDir, signal);
        else throw new Error(`Unknown check adapter: ${spec.kind}`);
        demand(!signal?.aborted, 'Run cancelled');
      }
      baselineResult = phases.baseline; candidateResult = phases.candidate;
      if (pinnedImage) assertComparableImages(baselineResult, candidateResult, pinnedImage);
    }
    const result = { id: spec.id, kind: spec.kind, required: spec.required, baseline: baselineResult, candidate: candidateResult };
    await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n');
    checks.push(result);
    demand(!signal?.aborted, 'Run cancelled');
  }
  return checks;
}
