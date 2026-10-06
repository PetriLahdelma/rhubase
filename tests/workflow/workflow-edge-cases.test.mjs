import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runWorkflow, inspectWorkflow } from '../../src/workflow.mjs';

const fixture = path.resolve('examples/react-consolidation');
const compiler = process.env.SHIFT_TYPESCRIPT_PATH;
const toolchain = process.env.SHIFT_REACT_NODE_MODULES ?? process.env.SHIFT_TOOLCHAIN;
const image = process.env.SHIFT_BROWSER_IMAGE ?? 'ghcr.io/browserless/chromium:v2.38.2';

async function prepare(t, name, mutate = async () => {}) {
  assert.ok(compiler, 'Set SHIFT_TYPESCRIPT_PATH to the trusted TypeScript 5.9 compiler');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `shift-${name}-`));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'source');
  await fs.cp(fixture, project, { recursive: true });
  await mutate(project);
  const recipe = path.join(root, 'recipe.json');
  await fs.copyFile(path.join(fixture, 'recipe.json'), recipe);
  return { root, project, recipe };
}

async function runCase(scope, overrides = {}) {
  const config = path.join(scope.root, 'shift.config.json');
  await fs.writeFile(config, JSON.stringify({
    schemaVersion: 1,
    name: overrides.name ?? 'edge-case',
    project: scope.project,
    output: path.join(scope.root, 'runs'),
    recipes: [scope.recipe],
    sources: overrides.sources ?? [],
    checks: overrides.checks ?? [{ id: 'syntax', kind: 'syntax', required: true }],
    toolchain: overrides.toolchain,
    git: overrides.git ?? false,
  }, null, 2) + '\n');
  return runWorkflow(config, { compiler });
}

test('two unmapped usages on the same source line remain two blockers', async (t) => {
  const scope = await prepare(t, 'same-line', async (project) => {
    const file = path.join(project, 'src/App.jsx');
    const source = await fs.readFile(file, 'utf8');
    await fs.writeFile(file, source.replace(
      '</form>',
      '<AdminButton variant="unmapped" data-testid="unmapped-one" /><AdminButton variant="unmapped" data-testid="unmapped-two" /></form>',
    ));
  });
  const result = await runCase(scope);
  const unmapped = result.summary.blockers.filter((item) => item.reason === 'Selected source usage has no reviewed mapping');
  assert.equal(unmapped.length, 2);
  assert.equal(new Set(unmapped.map((item) => item.id)).size, 2);
  assert.equal(result.summary.counts.blocked, 2);
});

test('explicit source without a recipe remains blocked even when browser checks pass', async (t) => {
  assert.ok(toolchain, 'Set SHIFT_REACT_NODE_MODULES or SHIFT_TOOLCHAIN to an explicit trusted node_modules directory');
  const scope = await prepare(t, 'explicit-source', async (project) => {
    await fs.writeFile(path.join(project, 'systems/extra.jsx'), "import React from 'react'; export function Badge(props) { return <span {...props}>New</span>; }\n");
    const file = path.join(project, 'src/App.jsx');
    let source = await fs.readFile(file, 'utf8');
    source = source.replace("import { Button as AdminButton } from '../systems/admin.jsx';", "import { Button as AdminButton } from '../systems/admin.jsx';\nimport { Badge } from '../systems/extra.jsx';");
    source = source.replace('</form>', '<Badge data-testid="extra-badge" /></form>');
    await fs.writeFile(file, source);
  });
  const result = await runCase(scope, {
    sources: [{ module: '../systems/extra.jsx', exports: ['Badge'] }],
    checks: [{ id: 'browser', kind: 'browser-demo', required: true, image }],
    toolchain,
  });
  assert.equal(result.summary.checks.find(({ id }) => id === 'browser').candidate, 'passed');
  assert.equal(result.summary.readiness, 'needs-review');
  assert.equal(result.exitCode, 2);
  assert.ok(result.summary.blockers.some((item) => item.origin?.exported === 'Badge'));
});

test('opaque unresolved usage is retained and verified in the browser without a readiness claim', async (t) => {
  assert.ok(toolchain, 'Set SHIFT_REACT_NODE_MODULES or SHIFT_TOOLCHAIN to an explicit trusted node_modules directory');
  const retainedUsage = `<AdminButton
          {...unresolvedProps}
          data-testid="unresolved-source"
          variant="action"
          onAction={() => { document.body.dataset.unresolved = 'clicked'; }}
        >
          Legacy unresolved
        </AdminButton>`;
  const scope = await prepare(t, 'retained-unresolved', async (project) => {
    const file = path.join(project, 'src/App.jsx');
    let source = await fs.readFile(file, 'utf8');
    source = source.replace("import { Button as AdminButton } from '../systems/admin.jsx';", "import { Button as AdminButton } from '../systems/admin.jsx';\nconst unresolvedProps = { title: 'retained source usage' };");
    source = source.replace('</form>', `${retainedUsage}</form>`);
    await fs.writeFile(file, source);
  });
  const result = await runCase(scope, {
    checks: [{ id: 'browser', kind: 'browser-demo', required: true, image, retainedUnresolved: true }],
    toolchain,
  });
  assert.equal(result.summary.checks.find(({ id }) => id === 'browser').candidate, 'passed');
  assert.equal(result.summary.readiness, 'needs-review');
  assert.equal(result.exitCode, 2);
  assert.ok(result.summary.counts.blocked > 0);
  const candidate = await fs.readFile(path.join(result.runDirectory, 'candidate/src/App.jsx'), 'utf8');
  assert.ok(candidate.includes(retainedUsage), 'candidate changed the unresolved source usage');
  assert.match(candidate, /import \{ Button as AdminButton \} from ['"]\.\.\/systems\/admin\.jsx['"]/);
  const check = JSON.parse(await fs.readFile(path.join(result.runDirectory, 'checks/browser/result.json'), 'utf8'));
  assert.match(check.candidate.logs.stdout, /"assertions":17/);
  assert.match(check.candidate.logs.stdout, /"retainedUnresolved":true/);
});

test('initial direct usage counts partition discovery and unsupported references appear once', async (t) => {
  const scope = await prepare(t, 'count-partition', async (project) => {
    const file = path.join(project, 'src/App.jsx');
    let source = await fs.readFile(file, 'utf8');
    source = source.replace("import { Button as AdminButton } from '../systems/admin.jsx';", "import { Button as AdminButton } from '../systems/admin.jsx';\nconst Wrapped = AdminButton;");
    source = source.replace('</form>', '<AdminButton variant="unmapped" data-testid="initially-unresolved" /></form>');
    await fs.writeFile(file, source);
  });
  const result = await runCase(scope);
  const counts = result.summary.counts;
  assert.equal(counts.deterministic + counts.unchanged + counts.initiallyUnresolved, counts.discovered);
  assert.equal(counts.initiallyUnresolved, 1);
  assert.equal(counts.unsupportedReferences, 1);
  assert.equal(result.summary.blockers.filter((item) => item.kind === 'non-jsx-reference').length, 1);
});

test('executable source files retain mode in baseline, candidate and candidate Git', async (t) => {
  const scope = await prepare(t, 'executable-mode', async (project) => {
    const script = path.join(project, 'bin/tool.sh');
    await fs.mkdir(path.dirname(script), { recursive: true });
    await fs.writeFile(script, '#!/bin/sh\necho shift\n', { mode: 0o755 });
    await fs.chmod(script, 0o755);
  });
  const result = await runCase(scope, { git: true });
  for (const directory of ['baseline', 'candidate']) {
    const mode = (await fs.stat(path.join(result.runDirectory, directory, 'bin/tool.sh'))).mode & 0o777;
    assert.equal(mode, 0o755, directory);
  }
  const index = execFileSync('git', ['-C', path.join(result.runDirectory, 'candidate'), 'ls-files', '-s', '--', 'bin/tool.sh'], { encoding: 'utf8' });
  assert.match(index, /^100755 /);
  const candidateScript = path.join(result.runDirectory, 'candidate/bin/tool.sh');
  await fs.chmod(candidateScript, 0o644);
  try {
    await assert.rejects(inspectWorkflow(result.runDirectory), /Run artifacts changed/);
  } finally {
    await fs.chmod(candidateScript, 0o755);
  }
  assert.equal((await inspectWorkflow(result.runDirectory)).readiness, 'needs-runtime-validation');
});

test('hostile ambient Git routing variables cannot redirect source inspection or candidate Git state', async (t) => {
  const scope = await prepare(t, 'hostile-git');
  execFileSync('git', ['init', '-b', 'main', scope.project]);
  execFileSync('git', ['-C', scope.project, '-c', 'user.name=Shift Test', '-c', 'user.email=shift@localhost', 'add', '.']);
  execFileSync('git', ['-C', scope.project, '-c', 'user.name=Shift Test', '-c', 'user.email=shift@localhost', 'commit', '-m', 'Source baseline']);
  const sourceHead = execFileSync('git', ['-C', scope.project, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const sourceHeadFile = await fs.readFile(path.join(scope.project, '.git/HEAD'));
  const sourceIndex = await fs.readFile(path.join(scope.project, '.git/index'));

  const decoy = path.join(scope.root, 'decoy');
  execFileSync('git', ['init', '-b', 'decoy', decoy]);
  execFileSync('git', ['-C', decoy, '-c', 'user.name=Decoy', '-c', 'user.email=decoy@localhost', 'commit', '--allow-empty', '-m', 'Decoy']);
  const decoyHead = await fs.readFile(path.join(decoy, '.git/HEAD'));
  const decoyIndex = await fs.readFile(path.join(decoy, '.git/index'));
  const variables = {
    GIT_DIR: path.join(decoy, '.git'),
    GIT_WORK_TREE: decoy,
    GIT_INDEX_FILE: path.join(decoy, '.git/index'),
    GIT_COMMON_DIR: path.join(decoy, '.git'),
    GIT_OBJECT_DIRECTORY: path.join(decoy, '.git/objects'),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(decoy, '.git/objects'),
  };
  const previous = Object.fromEntries(Object.keys(variables).map((name) => [name, process.env[name]]));
  let result;
  try {
    Object.assign(process.env, variables);
    result = await runCase(scope, { git: true });
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }

  assert.equal(result.exitCode, 0, result.summary.error);
  assert.equal(execFileSync('git', ['-C', scope.project, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourceHead);
  assert.deepEqual(await fs.readFile(path.join(scope.project, '.git/HEAD')), sourceHeadFile);
  assert.deepEqual(await fs.readFile(path.join(scope.project, '.git/index')), sourceIndex);
  assert.deepEqual(await fs.readFile(path.join(decoy, '.git/HEAD')), decoyHead);
  assert.deepEqual(await fs.readFile(path.join(decoy, '.git/index')), decoyIndex);
  const candidate = path.join(result.runDirectory, 'candidate');
  assert.match(execFileSync('git', ['-C', candidate, 'branch', '--show-current'], { encoding: 'utf8' }).trim(), /^shift\/edge-case-/);
  assert.equal((await fs.lstat(path.join(candidate, '.git'))).isDirectory(), true);
  assert.notDeepEqual(await fs.readFile(path.join(candidate, '.git/index')), decoyIndex);
});
