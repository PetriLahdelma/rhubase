import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runWorkflow, inspectWorkflow } from '../../src/workflow.mjs';
import { treeSnapshot } from '../../src/workflow-files.mjs';

const fixture = path.resolve('examples/react-consolidation');
const compiler = process.env.SHIFT_TYPESCRIPT_PATH;
const reactNodeModules = process.env.SHIFT_REACT_NODE_MODULES ?? process.env.SHIFT_TOOLCHAIN;
let root;
let project;
let configFile;
let recipeFile;
let reference;
let run;
let sourceBefore;
let gitBefore;

function git(directory, ...args) {
  return execFileSync('git', ['-c', 'user.name=Shift Test', '-c', 'user.email=shift-test@localhost', '-C', directory, ...args], { encoding: 'utf8' }).trim();
}

function browserContainers() {
  return execFileSync('docker', ['ps', '-aq', '--filter', 'name=shift-browser-'], { encoding: 'utf8' }).trim();
}

async function writeConfig(file, overrides = {}) {
  const value = {
    schemaVersion: 1,
    name: overrides.name ?? 'test',
    project: overrides.project ?? project,
    output: overrides.output ?? path.join(root, 'runs'),
    recipes: overrides.recipes ?? [recipeFile],
    references: overrides.references ?? [reference],
    checks: overrides.checks ?? [{ id: 'syntax', kind: 'syntax', required: true }],
    git: overrides.git ?? true,
  };
  if (overrides.toolchain) value.toolchain = overrides.toolchain;
  await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n');
}

before(async () => {
  assert.ok(compiler, 'Set SHIFT_TYPESCRIPT_PATH to the trusted TypeScript 5.9 compiler');
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'shift-workflow-test-'));
  project = path.join(root, 'source');
  await fs.cp(fixture, project, { recursive: true });
  recipeFile = path.join(root, 'recipe.json');
  await fs.copyFile(path.join(fixture, 'recipe.json'), recipeFile);
  reference = path.join(root, 'reference');
  await fs.mkdir(reference);
  await fs.writeFile(path.join(reference, 'migration-guide.md'), '# Approved consolidation\n');
  execFileSync('git', ['init', '-b', 'main', project]);
  git(project, 'add', '.');
  git(project, 'commit', '-m', 'Initial consumer');
  await fs.appendFile(path.join(project, 'systems/admin.jsx'), '\n// local tracked work\n');
  await fs.writeFile(path.join(project, 'local-note.txt'), 'untracked source note\n');
  sourceBefore = await treeSnapshot(project);
  gitBefore = { head: git(project, 'rev-parse', 'HEAD'), refs: git(project, 'show-ref'), status: git(project, 'status', '--porcelain=v1') };
  configFile = path.join(root, 'shift.config.json');
  await writeConfig(configFile);
  run = await runWorkflow(configFile, { compiler });
});

after(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});

test('syntax-only workflow generates a successful candidate that still requires runtime validation', async () => {
  assert.equal(run.exitCode, 0);
  assert.equal(run.summary.readiness, 'needs-runtime-validation');
  assert.deepEqual(await inspectWorkflow(run.runDirectory), run.summary);
});

test('workflow preserves dirty tracked and untracked source bytes and every source ref', async () => {
  assert.equal((await treeSnapshot(project)).digest, sourceBefore.digest);
  assert.deepEqual(
    { head: git(project, 'rev-parse', 'HEAD'), refs: git(project, 'show-ref'), status: git(project, 'status', '--porcelain=v1') },
    gitBefore,
  );
});

test('workflow creates a review branch only inside the isolated candidate repository', () => {
  assert.match(git(path.join(run.runDirectory, 'candidate'), 'branch', '--show-current'), /^shift\/test-/);
  assert.equal(git(path.join(run.runDirectory, 'candidate'), 'rev-parse', '--verify', 'baseline').length, 40);
  assert.doesNotMatch(git(project, 'branch', '--list'), /shift\//);
});

test('workflow emits an applicable patch, reports, draft PR body and sealed evidence', async () => {
  const required = ['config.json', 'tools.json', 'recipes.json', 'inventory.json', 'transformations.json', 'candidate-inventory.json', 'changes.patch', 'checks.json', 'report.json', 'report.md', 'PR.md', 'events.jsonl', 'manifest.json'];
  for (const file of required) assert.equal((await fs.lstat(path.join(run.runDirectory, file))).isFile(), true, file);
  assert.match(await fs.readFile(path.join(run.runDirectory, 'changes.patch'), 'utf8'), /foundation\.jsx/);
  const manifest = JSON.parse(await fs.readFile(path.join(run.runDirectory, 'manifest.json'), 'utf8'));
  assert.ok(manifest.artifacts.files['candidate/src/App.jsx']);
  assert.ok(manifest.artifacts.files['checks/syntax/result.json']);
  const patchProbe = path.join(root, 'patch-probe');
  await fs.cp(path.join(run.runDirectory, 'baseline'), patchProbe, { recursive: true });
  execFileSync('git', ['-C', patchProbe, 'apply', '--whitespace=nowarn', '--check', path.join(run.runDirectory, 'changes.patch')]);
  execFileSync('git', ['-C', patchProbe, 'apply', '--whitespace=nowarn', path.join(run.runDirectory, 'changes.patch')]);
  assert.equal((await treeSnapshot(patchProbe)).digest, (await treeSnapshot(path.join(run.runDirectory, 'candidate'))).digest);
});

const sealedArtifacts = [
  'config.json',
  'recipes.json',
  'references/0/migration-guide.md',
  'inventory.json',
  'baseline/src/App.jsx',
  'candidate/src/App.jsx',
  'changes.patch',
  'tools.json',
  'checks/syntax/result.json',
  'checks.json',
  'report.json',
  'report.md',
  'PR.md',
];

for (const artifact of sealedArtifacts) {
  test(`status rejects tampering with ${artifact}`, async () => {
    const file = path.join(run.runDirectory, artifact);
    const original = await fs.readFile(file);
    try {
      await fs.appendFile(file, '\ntampered\n');
      await assert.rejects(inspectWorkflow(run.runDirectory), /Run artifacts changed/);
    } finally {
      await fs.writeFile(file, original);
    }
  });
}

for (const [label, external] of [
  ['original config', () => configFile],
  ['original recipe', () => recipeFile],
  ['original reference', () => path.join(reference, 'migration-guide.md')],
  ['original source', () => path.join(project, 'local-note.txt')],
]) {
  test(`status rejects a changed ${label}`, async () => {
    const file = external();
    const original = await fs.readFile(file);
    try {
      await fs.appendFile(file, 'changed\n');
      await assert.rejects(inspectWorkflow(run.runDirectory), /Original (?:input\/tool|source\/reference) changed/);
    } finally {
      await fs.writeFile(file, original);
    }
  });
}

test('status rejects changed original Git refs', async () => {
  git(project, 'branch', 'unexpected-ref');
  try {
    await assert.rejects(inspectWorkflow(run.runDirectory), /Original source refs changed/);
  } finally {
    git(project, 'branch', '-D', 'unexpected-ref');
  }
});

test('status rejects a different original symbolic branch at the same commit', async () => {
  const originalBranch = git(project, 'branch', '--show-current');
  git(project, 'checkout', '--quiet', '-b', 'unexpected-symbolic');
  try {
    await assert.rejects(inspectWorkflow(run.runDirectory), /Original source refs changed/);
  } finally {
    git(project, 'checkout', '--quiet', originalBranch);
    git(project, 'branch', '-D', 'unexpected-symbolic');
  }
});

test('status rejects a changed candidate review HEAD', async () => {
  const candidate = path.join(run.runDirectory, 'candidate');
  const reviewBranch = git(candidate, 'branch', '--show-current');
  git(candidate, 'checkout', '--quiet', '--detach');
  git(candidate, 'commit', '--allow-empty', '-m', 'Unexpected candidate commit');
  try {
    await assert.rejects(inspectWorkflow(run.runDirectory), /Candidate review ref changed/);
  } finally {
    git(candidate, 'checkout', '--quiet', reviewBranch);
  }
});

test('status rejects a different candidate symbolic branch at the same commit', async () => {
  const candidate = path.join(run.runDirectory, 'candidate');
  const reviewBranch = git(candidate, 'branch', '--show-current');
  git(candidate, 'checkout', '--quiet', '-b', 'unexpected-candidate-symbolic');
  try {
    await assert.rejects(inspectWorkflow(run.runDirectory), /Candidate review/);
  } finally {
    git(candidate, 'checkout', '--quiet', reviewBranch);
    git(candidate, 'branch', '-D', 'unexpected-candidate-symbolic');
  }
});

test('blocking source usage produces needs-review and exit code 2', async () => {
  const blockedProject = path.join(root, 'blocked-source');
  await fs.cp(fixture, blockedProject, { recursive: true });
  const app = path.join(blockedProject, 'src/App.jsx');
  const source = await fs.readFile(app, 'utf8');
  await fs.writeFile(app, source.replace('<AdminButton\n          variant="action"', '<AdminButton\n          {...mystery}\n          variant="action"'));
  const blockedConfig = path.join(root, 'blocked.config.json');
  await writeConfig(blockedConfig, { name: 'blocked', project: blockedProject, output: path.join(root, 'blocked-runs'), references: [], git: false });
  const result = await runWorkflow(blockedConfig, { compiler });
  assert.equal(result.exitCode, 2);
  assert.equal(result.summary.readiness, 'needs-review');
  assert.ok(result.summary.counts.blocked > 0);
});

test('missing runtime toolchain produces durable failed evidence rather than readiness', async () => {
  const failedConfig = path.join(root, 'failed.config.json');
  await writeConfig(failedConfig, {
    name: 'failed-runtime',
    output: path.join(root, 'failed-runs'),
    checks: [{ id: 'browser', kind: 'browser-demo', required: true, image: 'ghcr.io/browserless/chromium:v2.38.2' }],
    git: false,
  });
  const result = await runWorkflow(failedConfig, { compiler });
  assert.equal(result.exitCode, 1);
  assert.equal(result.summary.readiness, 'failed');
  assert.match(result.summary.error, /explicit toolchain/);
  assert.equal((await fs.lstat(path.join(result.runDirectory, 'failure.json'))).isFile(), true);
});

test('configured browser workflow verifies generated candidate and seals runtime logs', async () => {
  assert.ok(reactNodeModules, 'Set SHIFT_REACT_NODE_MODULES or SHIFT_TOOLCHAIN to an explicit trusted node_modules directory');
  const browserConfig = path.join(root, 'browser.config.json');
  await writeConfig(browserConfig, {
    name: 'browser-runtime',
    output: path.join(root, 'browser-runs'),
    checks: [{ id: 'browser', kind: 'browser-demo', required: true, image: 'ghcr.io/browserless/chromium:v2.38.2' }],
    toolchain: reactNodeModules,
    git: false,
  });
  const result = await runWorkflow(browserConfig, { compiler });
  assert.equal(result.exitCode, 0, result.summary.error);
  assert.equal(result.summary.readiness, 'ready-for-review');
  assert.equal(result.summary.checks.find(({ id }) => id === 'browser').scope, 'browser');
  const log = path.join(result.runDirectory, 'checks/browser/candidate/stdout.log');
  const original = await fs.readFile(log);
  try {
    await fs.appendFile(log, 'tampered\n');
    await assert.rejects(inspectWorkflow(result.runDirectory), /Run artifacts changed/);
  } finally {
    await fs.writeFile(log, original);
  }
  assert.equal((await inspectWorkflow(result.runDirectory)).readiness, 'ready-for-review');
});

test('passing browser behavior cannot hide an unmapped source component variant', async () => {
  assert.ok(reactNodeModules, 'Set SHIFT_REACT_NODE_MODULES or SHIFT_TOOLCHAIN to an explicit trusted node_modules directory');
  const unmappedProject = path.join(root, 'unmapped-source');
  await fs.cp(fixture, unmappedProject, { recursive: true });
  const app = path.join(unmappedProject, 'src/App.jsx');
  const source = await fs.readFile(app, 'utf8');
  const changed = source.replace('variant="action"', 'variant="unmapped"');
  assert.notEqual(changed, source, 'test mutation did not find the action variant');
  await fs.writeFile(app, changed);
  const unmappedConfig = path.join(root, 'unmapped.config.json');
  await writeConfig(unmappedConfig, {
    name: 'unmapped-runtime', project: unmappedProject, output: path.join(root, 'unmapped-runs'), references: [],
    checks: [{ id: 'browser', kind: 'browser-demo', required: true, image: 'ghcr.io/browserless/chromium:v2.38.2' }],
    toolchain: reactNodeModules, git: false,
  });
  const result = await runWorkflow(unmappedConfig, { compiler });
  assert.equal(result.summary.checks.find(({ id }) => id === 'browser').candidate, 'passed');
  assert.equal(result.summary.readiness, 'needs-review');
  assert.equal(result.exitCode, 2);
  assert.ok(result.summary.counts.blocked > 0);
});

test('candidate browser-phase cancellation seals failure evidence and removes its container', async () => {
  assert.ok(reactNodeModules, 'Set SHIFT_REACT_NODE_MODULES or SHIFT_TOOLCHAIN to an explicit trusted node_modules directory');
  assert.equal(browserContainers(), '', 'stale shift browser container exists before cancellation test');
  const cancelledConfig = path.join(root, 'cancelled.config.json');
  await writeConfig(cancelledConfig, {
    name: 'cancelled-runtime', output: path.join(root, 'cancelled-runs'),
    checks: [{ id: 'browser', kind: 'browser-demo', required: true, image: 'ghcr.io/browserless/chromium:v2.38.2' }],
    toolchain: reactNodeModules, git: false,
  });
  const controller = new AbortController();
  const result = await runWorkflow(cancelledConfig, {
    compiler,
    signal: controller.signal,
    onProgress(stage, detail) {
      if (stage === 'verify-phase' && detail === 'browser:candidate') controller.abort();
    },
  });
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.summary.readiness, 'failed');
  const failure = JSON.parse(await fs.readFile(path.join(result.runDirectory, 'failure.json'), 'utf8'));
  assert.equal(failure.cancelled, true);
  assert.equal((await inspectWorkflow(result.runDirectory)).readiness, 'failed');
  assert.equal(browserContainers(), '', 'cancelled browser container was not removed');
});

test('browser check timeout covers build, image resolution and browser execution without readiness', async () => {
  assert.ok(reactNodeModules, 'Set SHIFT_REACT_NODE_MODULES or SHIFT_TOOLCHAIN to an explicit trusted node_modules directory');
  assert.equal(browserContainers(), '', 'stale shift browser container exists before timeout workflow');
  const timeoutConfig = path.join(root, 'timeout.config.json');
  await writeConfig(timeoutConfig, {
    name: 'timeout-runtime', output: path.join(root, 'timeout-runs'),
    checks: [{
      id: 'browser', kind: 'browser-demo', required: true,
      image: 'ghcr.io/browserless/chromium:v2.38.2', timeoutMs: 100,
    }],
    toolchain: reactNodeModules, git: false,
  });
  const result = await runWorkflow(timeoutConfig, { compiler });
  assert.equal(result.exitCode, 2);
  assert.equal(result.summary.readiness, 'verification-failed');
  const check = JSON.parse(await fs.readFile(path.join(result.runDirectory, 'checks/browser/result.json'), 'utf8'));
  assert.deepEqual(
    [check.baseline.status, check.baseline.stopped, check.candidate.status, check.candidate.stopped],
    ['inconclusive', 'timeout', 'inconclusive', 'timeout'],
  );
  assert.equal((await inspectWorkflow(result.runDirectory)).readiness, 'verification-failed');
  assert.equal(browserContainers(), '', 'timed-out browser container was not removed');
});
