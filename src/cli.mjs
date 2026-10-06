#!/usr/bin/env node
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createPlan } from './contract.mjs';
import { demand, readJson, writeJson } from './files.mjs';
import { inferContract } from './inference.mjs';
import { inspectSource } from './source-analysis.mjs';
import { migrate, verify } from './run.mjs';
import { writeReport } from './report.mjs';
import { runWorkflow, inspectWorkflow } from './workflow.mjs';
import { initializeConfig, doctorWorkflow } from './workflow-setup.mjs';

const help = `Shift — reviewable design-system migrations

shift-ds infer --from <old-package-directory> --to <new-package-directory> --out <new-contract.json> [--compiler <typescript.js>]
shift-ds init --preset demo|superset|superset-agent --out <new-config.json> [--output <runs-directory>] [--compiler <typescript.js>] [--toolchain <node_modules>]
shift-ds init --project <source-directory> --recipe <reviewed-recipe.json> --out <new-config.json> [--output <runs-directory>]
shift-ds doctor [--config <config.json>] [--compiler <typescript.js>] [--toolchain <node_modules>]
shift-ds run --config <config.json> [--compiler <typescript.js>] [--toolchain <node_modules>] [--require-ready] [--json]
shift-ds status --run <run-directory> [--require-ready] [--json]

run discovers usages, generates edits, verifies, and saves a patch/report/local
review branch. Originals are preserved. Agent execution is explicit in config.
No dependency installs, image pulls, remote publication or automatic merging.

Earlier experimental commands (retained for reproducibility):

node src/cli.mjs analyze --case <case.json>
node src/cli.mjs plan --case <case.json> --out <new-plan.json>
node src/cli.mjs migrate --plan <plan.json> --out <new-run-directory>
node src/cli.mjs verify --run <run-directory> --image <existing-node-image>
node src/cli.mjs report --run <run-directory>
node src/cli.mjs inspect-source --root <directory> --rules <rules.json> --compiler <typescript.js> [--out <new-json>]

Output parents must exist. Existing plans/runs are never overwritten.
The earlier plan/migrate/verify commands accept controlled-fixture cases only.
`;

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    case: { type: 'string' }, out: { type: 'string' }, plan: { type: 'string' },
    from: { type: 'string' }, to: { type: 'string' },
    run: { type: 'string' }, image: { type: 'string' }, help: { type: 'boolean' },
    root: { type: 'string' }, rules: { type: 'string' }, compiler: { type: 'string' },
    config: { type: 'string' }, preset: { type: 'string' }, project: { type: 'string' },
    recipe: { type: 'string' }, toolchain: { type: 'string' }, output: { type: 'string' }, json: { type: 'boolean' },
    'require-ready': { type: 'boolean' },
  } });
  const command = positionals[0];
  const required = (key) => { if (!values[key]) throw new Error(`Missing --${key}`); return values[key]; };
  if (values.help || !command) process.stdout.write(help);
  else {
    if (positionals.length !== 1) throw new Error('Expected one command');
    let result;
    switch (command) {
      case 'infer': {
        const from = await fs.realpath(required('from')); const to = await fs.realpath(required('to'));
        const output = path.resolve(required('out')); const parent = await fs.realpath(path.dirname(output));
        const resolvedOutput = path.join(parent, path.basename(output));
        for (const root of [from, to]) demand(resolvedOutput !== root && !resolvedOutput.startsWith(root + path.sep), 'Inference output must be outside both input snapshots');
        result = await inferContract({ from: required('from'), to: required('to'), compiler: values.compiler ?? process.env.SHIFT_TYPESCRIPT_PATH });
        await writeJson(resolvedOutput, result);
        break;
      }
      case 'init': result = await initializeConfig({ ...values, out: required('out') }); break;
      case 'doctor': {
        result = await doctorWorkflow(values.config, { compiler: values.compiler, toolchain: values.toolchain });
        if (!result.ready) process.exitCode = 1;
        break;
      }
      case 'run': {
        const abort = new AbortController();
        const cancel = () => abort.abort();
        process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
        try {
          result = await runWorkflow(required('config'), {
            compiler: values.compiler, toolchain: values.toolchain, output: values.output, signal: abort.signal,
            onProgress: values.json ? undefined : (stage, detail) => process.stderr.write(`[${stage}] ${detail}\n`),
          });
          process.exitCode = result.exitCode;
        } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
        break;
      }
      case 'status': result = { runDirectory: path.resolve(required('run')), summary: await inspectWorkflow(required('run')) }; break;
      case 'inspect-source': {
        result = await inspectSource(required('root'), await readJson(required('rules')), values.compiler ?? process.env.SHIFT_TYPESCRIPT_PATH);
        if (values.out) await writeJson(path.resolve(values.out), result);
        if (result.syntaxDiagnostics.length) process.exitCode = 3;
        break;
      }
      case 'analyze': result = await createPlan(required('case')); break;
      case 'plan': {
        result = await createPlan(required('case'));
        await writeJson(path.resolve(required('out')), result); break;
      }
      case 'migrate': result = await migrate(required('plan'), required('out')); break;
      case 'verify': {
        result = await verify(required('run'), required('image'));
        const report = await writeReport(required('run'));
        if (report.requiredChecks.some((c) => c.baseline !== 'passed' || c.candidate !== 'passed')) process.exitCode = 3;
        break;
      }
      case 'report': result = await writeReport(required('run')); break;
      default: throw new Error(`Unknown command: ${command}`);
    }
    if (['run', 'status'].includes(command) && !values.json) {
      process.stdout.write(`Shift: ${result.summary.readiness}\n${result.summary.counts.changedFiles} changed files; ${result.summary.counts.blocked} blockers\nReport: ${path.join(result.runDirectory, 'report.md')}\nPatch: ${path.join(result.runDirectory, 'changes.patch')}\n`);
    } else process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (values['require-ready'] && result.summary?.readiness !== 'ready-for-review') process.exitCode = process.exitCode || 2;
    if (command === 'verify' && result.checks.some((c) => c.baseline.status !== 'passed' || c.candidate.status !== 'passed')) process.exitCode = 3;
  }
} catch (error) {
  process.stderr.write(JSON.stringify({ error: error.message }) + '\n');
  process.exitCode = 1;
}
