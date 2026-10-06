import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadCompiler } from '../../src/source-analysis.mjs';
import { transformSources } from '../../src/recipes.mjs';
import { verifyBrowserDemo } from '../../scripts/browser-demo.mjs';

const fixture = path.resolve('examples/react-consolidation');
const compilerPath = process.env.SHIFT_TYPESCRIPT_PATH;
const reactNodeModules = process.env.SHIFT_REACT_NODE_MODULES ?? process.env.SHIFT_TOOLCHAIN;
if (!reactNodeModules) throw new Error('Set SHIFT_REACT_NODE_MODULES or SHIFT_TOOLCHAIN to an explicit trusted node_modules directory');
const toolchain = {
  esbuildPath: process.env.SHIFT_ESBUILD_PATH
    ?? path.join(reactNodeModules, 'esbuild/lib/main.js'),
  nodeModules: reactNodeModules,
};
const image = process.env.SHIFT_BROWSER_IMAGE ?? 'ghcr.io/browserless/chromium:v2.38.2';
let root;
let candidate;
let outcome;

function browserContainers() {
  return execFileSync('docker', ['ps', '-aq', '--filter', 'name=shift-browser-'], { encoding: 'utf8' }).trim();
}

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'shift-react-demo-'));
  candidate = path.join(root, 'candidate');
  await fs.cp(fixture, candidate, { recursive: true });
  const recipe = JSON.parse(await fs.readFile(path.join(fixture, 'recipe.json'), 'utf8'));
  const appPath = 'src/App.jsx';
  const sourcePaths = ['src/App.jsx', 'systems/admin.jsx', 'systems/commerce.jsx', 'systems/foundation.jsx'];
  const contents = new Map(await Promise.all(sourcePaths.map(async (file) => [file, await fs.readFile(path.join(candidate, file), 'utf8')])));
  const { ts } = await loadCompiler(compilerPath);
  outcome = transformSources(ts, contents, recipe);
  await fs.writeFile(path.join(candidate, appPath), outcome.contents.get(appPath));
});

after(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});

test('reviewed recipe generates every demo migration without blockers', () => {
  assert.equal(outcome.outcomes.filter(({ status }) => status === 'transformed').length, 5);
  assert.deepEqual(outcome.blockers, []);
});

test('recipe-generated app retires both source-system imports', () => {
  const generated = outcome.contents.get('src/App.jsx');
  assert.doesNotMatch(generated, /systems\/(commerce|admin)\.jsx/);
  assert.match(generated, /systems\/foundation\.jsx/);
});

test('browser verifier requires an explicit trusted toolchain', async () => {
  await assert.rejects(
    verifyBrowserDemo({ project: fixture, phase: 'baseline', outputDir: path.join(root, 'invalid'), toolchain: {}, image }),
    /Explicit absolute esbuildPath and nodeModules/,
  );
});

test('browser verifier reports cancellation before starting build or Docker work', async () => {
  const controller = new AbortController();
  controller.abort();
  const outputDir = path.join(root, 'cancelled-before-build');
  const result = await verifyBrowserDemo({
    project: fixture, phase: 'baseline', outputDir, toolchain, image, signal: controller.signal,
  });
  assert.equal(result.status, 'inconclusive');
  assert.equal(result.stopped, 'cancelled');
  assert.equal(result.logs.stopped, 'cancelled');
  await assert.rejects(fs.lstat(outputDir), { code: 'ENOENT' });
});

test('browser verifier applies one timeout budget to the whole check', async () => {
  assert.equal(browserContainers(), '', 'stale shift browser container exists before timeout test');
  const result = await verifyBrowserDemo({
    project: fixture,
    phase: 'baseline',
    outputDir: path.join(root, 'whole-check-timeout'),
    toolchain,
    image,
    timeoutMs: 1,
  });
  assert.equal(result.status, 'inconclusive');
  assert.equal(result.stopped, 'timeout');
  assert.equal(result.logs.stopped, 'timeout');
  assert.equal(browserContainers(), '', 'timed-out browser container was not removed');
});

test('baseline source systems satisfy the browser behavior oracle', async () => {
  const result = await verifyBrowserDemo({
    project: fixture, phase: 'baseline', outputDir: path.join(root, 'baseline-browser'), toolchain, image,
  });
  assert.equal(result.status, 'passed', result.logs.stdout + result.logs.stderr);
  assert.equal(result.scope, 'browser');
});

test('recipe-generated foundation candidate preserves browser behavior', async () => {
  const result = await verifyBrowserDemo({
    project: candidate, phase: 'candidate', outputDir: path.join(root, 'candidate-browser'), toolchain, image,
  });
  assert.equal(result.status, 'passed', result.logs.stdout + result.logs.stderr);
  assert.match(result.logs.stdout, /"assertions":13/);
  assert.deepEqual(
    [result.toolchain.esbuildVersion, result.toolchain.reactVersion, result.toolchain.reactDomVersion],
    ['0.27.3', '19.2.3', '19.2.3'],
  );
});

test('browser oracle rejects a generated candidate that loses submit semantics', async () => {
  const broken = path.join(root, 'broken');
  await fs.cp(candidate, broken, { recursive: true });
  const app = path.join(broken, 'src/App.jsx');
  const source = await fs.readFile(app, 'utf8');
  const mutated = source.replace('type="submit"', 'type="button"');
  assert.notEqual(mutated, source, 'test mutation did not find generated submit type');
  await fs.writeFile(app, mutated);
  const result = await verifyBrowserDemo({
    project: broken, phase: 'candidate', outputDir: path.join(root, 'broken-browser'), toolchain, image,
  });
  assert.equal(result.status, 'failed');
  assert.match(result.logs.stderr, /submit button type/);
});
