import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initializeConfig, doctorWorkflow } from '../../src/workflow-setup.mjs';
import { runWorkflow } from '../../src/workflow.mjs';

const fixture = path.resolve('examples/react-consolidation');
const compiler = process.env.SHIFT_TYPESCRIPT_PATH;

async function temporaryProject(t, label) {
  assert.ok(compiler, 'Set SHIFT_TYPESCRIPT_PATH to the trusted TypeScript 5.9 compiler');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `shift-setup-${label}-`));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'consumer');
  await fs.cp(fixture, project, { recursive: true });
  const recipe = path.join(root, 'recipe.json');
  await fs.copyFile(path.join(fixture, 'recipe.json'), recipe);
  return { root, project, recipe };
}

async function writeDoctorConfig(scope, recipe) {
  const config = path.join(scope.root, `doctor-${path.basename(recipe)}.json`);
  await fs.writeFile(config, JSON.stringify({
    schemaVersion: 1,
    name: 'doctor-case',
    project: scope.project,
    output: path.join(scope.root, 'runs'),
    compiler,
    recipes: [recipe],
    checks: [{ id: 'syntax', kind: 'syntax', required: true }],
    git: false,
  }, null, 2) + '\n');
  return config;
}

test('doctor is not ready when a declared recipe is missing', async (t) => {
  const scope = await temporaryProject(t, 'missing');
  const config = await writeDoctorConfig(scope, path.join(scope.root, 'missing-recipe.json'));
  const result = await doctorWorkflow(config, { compiler });
  assert.equal(result.ready, false);
  assert.equal(result.checks.find(({ name }) => name === 'Migration inputs').status, 'missing');
});

test('doctor is not ready when a declared recipe is malformed', async (t) => {
  const scope = await temporaryProject(t, 'malformed');
  const malformed = path.join(scope.root, 'malformed-recipe.json');
  await fs.writeFile(malformed, '{"schemaVersion":1,"id":"broken","rules":[]}\n');
  const config = await writeDoctorConfig(scope, malformed);
  const result = await doctorWorkflow(config, { compiler });
  assert.equal(result.ready, false);
  assert.equal(result.checks.find(({ name }) => name === 'Migration inputs').status, 'missing');
});

test('init inside a consumer chooses sibling output and produces a doctor-ready runnable config', async (t) => {
  const scope = await temporaryProject(t, 'inside-consumer');
  const configFile = path.join(scope.project, 'shift.config.json');
  await initializeConfig({ out: configFile, project: scope.project, recipe: scope.recipe, compiler });
  const config = JSON.parse(await fs.readFile(configFile, 'utf8'));
  assert.equal(config.output.startsWith(scope.project + path.sep), false);
  assert.equal(path.dirname(config.output), scope.root);
  assert.equal((await doctorWorkflow(configFile, { compiler })).ready, true);
  const result = await runWorkflow(configFile, { compiler });
  assert.equal(result.exitCode, 0, result.summary.error);
  assert.equal(result.summary.readiness, 'needs-runtime-validation');
});
