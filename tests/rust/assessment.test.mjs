import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAssessmentFixture, treeDigest, sentinelText } from '../assessment/fixture.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = path.join(repository, 'Cargo.toml');
const trustedCompiler = process.env.SHIFT_TYPESCRIPT_PATH;
const hangWorker = path.join(repository, 'tests/rust/workers/hang-assessment.mjs');
const fixtureWorker = (name) => path.join(repository, 'tests/rust/workers', `${name}.mjs`);
let fixture; let root; let binary; let beforeDigest;

function assessArgs(output, extra = []) {
  return ['assess', fixture.root, '--source', '@legacy/a', '--source', '@legacy/b', '--target', '@target/ui', '--out', output, '--node', process.execPath, ...extra];
}
function run(output, options = {}) {
  const env = { ...process.env, ...(options.env ?? {}) }; for (const key of options.unsetEnv ?? []) delete env[key];
  return spawnSync(binary, assessArgs(output, options.extra), { cwd: options.cwd ?? root, env, encoding: 'utf8', timeout: options.timeout ?? 30000, maxBuffer: 8 * 1024 * 1024 });
}
async function files(rootDirectory) {
  const result = {};
  async function visit(directory, prefix = '') {
    for (const name of (await fs.readdir(directory)).sort()) {
      const file = path.join(directory, name); const relative = prefix + name; const stat = await fs.lstat(file);
      if (stat.isDirectory()) await visit(file, relative + '/'); else result[relative] = { bytes: await fs.readFile(file), mode: stat.mode & 0o777 };
    }
  }
  await visit(rootDirectory); return result;
}
function processExists(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } }
async function waitForFile(file, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    await new Promise((resolve) => setTimeout(resolve, 20));
  } throw new Error(`timeout waiting for ${path.basename(file)}`);
}
async function waitForExit(pid, timeoutMs = 3000) { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline && processExists(pid)) await new Promise((resolve) => setTimeout(resolve, 20)); return !processExists(pid); }
function collect(child, timeoutMs = 5000) {
  let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk; });
  return Promise.race([new Promise((resolve) => child.once('close', (code) => resolve({ code, stderr }))), new Promise((_, reject) => setTimeout(() => reject(new Error('assessment coordinator did not exit')), timeoutMs))]);
}

before(async (t) => {
  assert.ok(trustedCompiler && path.isAbsolute(trustedCompiler)); root = await fs.mkdtemp(path.join(os.tmpdir(), 'shift-assessment-rust-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  fixture = await createAssessmentFixture(t); beforeDigest = await treeDigest(fixture.root);
  const fresh = path.join(root, 'build-cwd'); await fs.mkdir(fresh);
  const build = spawnSync('cargo', ['build', '--locked', '--release', '--manifest-path', manifest, '--bin', 'ctrl-shift'], { cwd: fresh, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  assert.equal(build.status, 0, build.stdout + build.stderr); binary = path.join(repository, 'target/release/ctrl-shift');
});
after(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });

test('assess auto-selects only a trusted pinned compiler and publishes a portable review directory', async () => {
  const output = path.join(root, 'assessment');
  const result = run(output, { unsetEnv: ['SHIFT_TYPESCRIPT_PATH'] }); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /assessment|review/i);
  const names = (await fs.readdir(output)).sort(); assert.deepEqual(names, ['assessment.json', 'assessment.md', 'contracts', 'manifest.json']);
  const machine = JSON.parse(await fs.readFile(path.join(output, 'assessment.json'), 'utf8')); const markdown = await fs.readFile(path.join(output, 'assessment.md'), 'utf8');
  assert.equal(machine.kind, 'consumer-migration-assessment'); assert.equal(machine.status, 'draft-review'); assert.equal(machine.executable, false); assert.equal(machine.sources.length, 2);
  assert.equal(machine.usageInventory.usages.length, fixture.expected.directUsages); assert.equal(machine.mappingGroups.flatMap((group) => group.usageIds).length, fixture.expected.directUsages);
  assert.match(markdown, /many-to-one|source systems|target/i); assert.match(markdown, /coverage/i); assert.match(markdown, /decisions?.*review/i); assert.match(markdown, /declared[- ]not[- ]run/i); assert.match(markdown, /limitations?/i); assert.match(markdown, /review steps?/i);
  const verificationSection = markdown.split('## Verification candidates')[1].split('### Other declared scripts')[0];
  const otherScriptsSection = markdown.split('### Other declared scripts')[1].split('## Gaps and unknowns')[0];
  assert.doesNotMatch(verificationSection, /preinstall/); assert.match(otherScriptsSection, /preinstall/);
  assert.doesNotMatch(markdown + JSON.stringify(machine), new RegExp(sentinelText)); assert.doesNotMatch(markdown + JSON.stringify(machine), new RegExp(fixture.root)); assert.doesNotMatch(markdown, /writeFileSync|SECRET_TOKEN/);
  const contractFiles = await fs.readdir(path.join(output, 'contracts')); assert.equal(contractFiles.length, 2); assert.ok(contractFiles.every((name) => name.endsWith('.json')));
  const manifestValue = JSON.parse(await fs.readFile(path.join(output, 'manifest.json'), 'utf8')); assert.equal(manifestValue.kind, 'consumer-assessment-artifact-manifest');
  const canonicalManifestFiles = manifestValue.files.map(({ file, sha256, bytes }) => ({ file, sha256, bytes }));
  assert.equal(manifestValue.digest, createHash('sha256').update(JSON.stringify(canonicalManifestFiles)).digest('hex'));
  for (const item of manifestValue.files) {
    const bytes = await fs.readFile(path.join(output, item.file)); assert.equal(bytes.length, item.bytes); assert.equal(createHash('sha256').update(bytes).digest('hex'), item.sha256);
  }
  for (const [relative, info] of Object.entries(await files(output))) assert.equal(info.mode, 0o600, `${relative} mode`);
  assert.equal(await treeDigest(fixture.root), beforeDigest); await assert.rejects(fs.lstat(fixture.marker), { code: 'ENOENT' });
});

test('assessment outputs are deterministic across distinct directories', async () => {
  const one = path.join(root, 'deterministic-one'); const two = path.join(root, 'deterministic-two'); assert.equal(run(one).status, 0); assert.equal(run(two).status, 0);
  const first = await files(one); const second = await files(two); assert.deepEqual(Object.keys(second), Object.keys(first));
  for (const name of Object.keys(first)) assert.deepEqual(second[name], first[name], name);
});

test('Markdown report escapes hostile repository metadata without changing machine data', async (t) => {
  const hostile = await createAssessmentFixture(t); const manifestFile = path.join(hostile.root, 'package.json'); const manifestValue = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  const hostileName = 'evil`break</table>\n# injected [click](javascript:alert(1))'; manifestValue.name = hostileName; await fs.writeFile(manifestFile, JSON.stringify(manifestValue, null, 2));
  const output = path.join(root, 'hostile-markdown');
  const result = spawnSync(binary, ['assess', hostile.root, '--source', '@legacy/a', '--source', '@legacy/b', '--target', '@target/ui', '--out', output, '--node', process.execPath], { cwd: root, env: { ...process.env }, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  const machine = JSON.parse(await fs.readFile(path.join(output, 'assessment.json'), 'utf8')); const markdown = await fs.readFile(path.join(output, 'assessment.md'), 'utf8');
  assert.equal(machine.repository.name, hostileName); assert.doesNotMatch(markdown, /<\/table>|^# injected/m); assert.match(markdown, /Repository: `` evil`break&lt;\/table&gt; # injected \[click\]\(javascript:alert\(1\)\) ``/);
  await assert.rejects(fs.lstat(hostile.marker), { code: 'ENOENT' });
});

test('explicit compiler overrides an invalid environment compiler; invalid explicit compiler does not fall back', async () => {
  const good = path.join(root, 'compiler-good'); const success = run(good, { env: { SHIFT_TYPESCRIPT_PATH: path.join(fixture.root, 'node_modules/typescript/lib/typescript.js') }, extra: ['--compiler', trustedCompiler] }); assert.equal(success.status, 0, success.stderr);
  const bad = path.join(root, 'compiler-bad'); const failure = run(bad, { extra: ['--compiler', path.join(fixture.root, 'node_modules/typescript/lib/typescript.js')] }); assert.notEqual(failure.status, 0); await assert.rejects(fs.lstat(bad), { code: 'ENOENT' });
  await assert.rejects(fs.lstat(fixture.marker), { code: 'ENOENT' });
});

test('explicit local source and target may share a package name when roots and versions differ', async () => {
  const oldRoot = path.join(fixture.root, 'packages/upgrade-old'); const newRoot = path.join(fixture.root, 'packages/upgrade-new'); await fs.mkdir(oldRoot); await fs.mkdir(newRoot);
  await fs.writeFile(path.join(oldRoot, 'package.json'), '{"name":"@upgrade/ui","version":"1.0.0","types":"index.d.ts"}'); await fs.writeFile(path.join(oldRoot, 'index.d.ts'), 'export declare function OldWidget(props: {}): unknown;\n');
  await fs.writeFile(path.join(newRoot, 'package.json'), '{"name":"@upgrade/ui","version":"2.0.0","types":"index.d.ts"}'); await fs.writeFile(path.join(newRoot, 'index.d.ts'), 'export declare function NewWidget(props: {}): unknown;\n');
  await fs.writeFile(path.join(fixture.root, 'packages/app/src/Upgrade.tsx'), "import { OldWidget } from '@upgrade/ui'; export const upgrade = <OldWidget />;\n");
  const output = path.join(root, 'same-package-upgrade');
  const result = spawnSync(binary, ['assess', fixture.root, '--source', './packages/upgrade-old', '--target', './packages/upgrade-new', '--out', output, '--compiler', trustedCompiler, '--node', process.execPath], { cwd: root, env: { ...process.env }, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr); const assessment = JSON.parse(await fs.readFile(path.join(output, 'assessment.json'), 'utf8'));
  assert.equal(assessment.sources[0].importName, '@upgrade/ui'); assert.equal(assessment.sources[0].identity.version, '1.0.0'); assert.equal(assessment.target.identity.name, '@upgrade/ui'); assert.equal(assessment.target.identity.version, '2.0.0');
});

test('refuses existing, input-contained and symlink-aliased output directories', async (t) => {
  const existing = path.join(root, 'existing'); await fs.mkdir(existing); await fs.writeFile(path.join(existing, 'owner'), 'owner'); assert.notEqual(run(existing).status, 0); assert.equal(await fs.readFile(path.join(existing, 'owner'), 'utf8'), 'owner');
  const inside = path.join(fixture.root, 'assessment-output'); assert.notEqual(run(inside).status, 0); await assert.rejects(fs.lstat(inside), { code: 'ENOENT' });
  const alias = path.join(root, 'repo-alias'); try { await fs.symlink(fixture.root, alias, 'dir'); } catch (error) { if (error.code === 'EPERM') return t.skip('symlinks unavailable'); throw error; }
  const throughAlias = path.join(alias, 'assessment-output'); assert.notEqual(run(throughAlias).status, 0); await assert.rejects(fs.lstat(path.join(fixture.root, 'assessment-output')), { code: 'ENOENT' });
});

for (const name of [
  'assessment-duplicate-usage', 'assessment-target-mismatch', 'assessment-bad-evidence', 'assessment-passed-verification', 'assessment-missing-field',
  'assessment-repository-digest', 'assessment-source-identity', 'assessment-source-contract-file', 'assessment-source-import-name',
  'assessment-ungrouped-usage', 'assessment-cross-group-duplicate', 'assessment-missing-change-id', 'assessment-missing-proposal-id',
  'assessment-usage-position', 'assessment-decision-approved', 'assessment-decision-check', 'assessment-owner-incoherent',
  'assessment-verification-missing', 'assessment-verification-extra', 'assessment-group-count',
  'assessment-spread-mapping', 'assessment-dynamic-mapping', 'assessment-conflicting-targets', 'assessment-decision-kind',
]) {
  test(`strict Rust validator rejects forged ${name} result`, async () => {
    const output = path.join(root, `forged-${name}`); const before = await treeDigest(fixture.root);
    const result = run(output, { extra: ['--worker', fixtureWorker(name)] });
    assert.equal(result.status, 1, result.stderr); await assert.rejects(fs.lstat(output), { code: 'ENOENT' }); assert.equal(await treeDigest(fixture.root), before);
  });
}

test('timeout and SIGINT publish no assessment and clean worker descendants', { skip: process.platform === 'win32' }, async () => {
  const timeoutOutput = path.join(root, 'timeout'); const timeoutMarker = path.join(path.dirname(fixture.root), `assessment-hang-${path.basename(fixture.root)}.json`);
  await fs.rm(timeoutMarker, { force: true });
  const timeout = run(timeoutOutput, { extra: ['--worker', hangWorker, '--timeout-ms', '300'], timeout: 5000 }); assert.equal(timeout.status, 124, timeout.stderr); const timeoutPids = JSON.parse(await fs.readFile(timeoutMarker, 'utf8')); assert.equal(await waitForExit(timeoutPids.worker), true); assert.equal(await waitForExit(timeoutPids.child), true); await assert.rejects(fs.lstat(timeoutOutput), { code: 'ENOENT' }); await fs.rm(timeoutMarker);

  const cancelOutput = path.join(root, 'cancel'); const child = spawn(binary, assessArgs(cancelOutput, ['--worker', hangWorker, '--timeout-ms', '10000']), { cwd: root, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const cancelPids = await waitForFile(timeoutMarker); child.kill('SIGINT'); const code = await Promise.race([new Promise((resolve) => child.once('close', resolve)), new Promise((_, reject) => setTimeout(() => reject(new Error('SIGINT ignored')), 5000))]);
  assert.equal(code, 130); assert.equal(await waitForExit(cancelPids.worker), true); assert.equal(await waitForExit(cancelPids.child), true); await assert.rejects(fs.lstat(cancelOutput), { code: 'ENOENT' });
  await fs.rm(timeoutMarker, { force: true });
});

test('concurrent isolated assessment timeouts use distinct complete PID markers and clean both process trees', { skip: process.platform === 'win32' }, async (t) => {
  const fixtures = await Promise.all([createAssessmentFixture(t), createAssessmentFixture(t)]);
  const runs = fixtures.map((item, index) => {
    const output = path.join(root, `concurrent-timeout-${index}`); const marker = path.join(path.dirname(item.root), `assessment-hang-${path.basename(item.root)}.json`);
    const argv = ['assess', item.root, '--source', '@legacy/a', '--source', '@legacy/b', '--target', '@target/ui', '--out', output, '--worker', hangWorker, '--timeout-ms', '300', '--node', process.execPath];
    const child = spawn(binary, argv, { cwd: root, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] }); return { child, output, marker, completion: collect(child) };
  });
  const markers = await Promise.all(runs.map((item) => waitForFile(item.marker)));
  const results = await Promise.all(runs.map((item) => item.completion));
  for (let index = 0; index < runs.length; index++) {
    assert.equal(results[index].code, 124, results[index].stderr); assert.equal(await waitForExit(markers[index].worker), true); assert.equal(await waitForExit(markers[index].child), true); await assert.rejects(fs.lstat(runs[index].output), { code: 'ENOENT' });
  }
  assert.notEqual(runs[0].marker, runs[1].marker);
});
