import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const compiler = process.env.SHIFT_TYPESCRIPT_PATH;
const worker = path.join(repository, 'src/inference-worker.mjs');
const workers = path.join(repository, 'tests/rust/workers');
const manifest = path.join(repository, 'Cargo.toml');
const rustProfile = process.env.SHIFT_RUST_PROFILE ?? 'debug';
if (!['debug', 'release'].includes(rustProfile)) throw new Error('SHIFT_RUST_PROFILE must be debug or release');
const corpusRegistrations = [
  { name: 'v1', file: path.join(repository, 'validation/inference-blind/corpus.json'), sha256: 'bd4440eb4f645aa18ef70c597a1f3cb6a2f1a0e60075d667bac5d7c4955ba3ae' },
  { name: 'v2', file: path.join(repository, 'validation/inference-followup-v2/corpus.json'), sha256: '2179347ccfa40eb5b4c4dac8a72a3b707460e1eb4b15ab7480bf6f1bbf02c623' },
];
const corpusCases = corpusRegistrations.flatMap((registration) => JSON.parse(readFileSync(registration.file, 'utf8')).cases.map((scenario) => ({ study: registration.name, ...scenario })));
let root; let from; let to; let binary; let inputIdentity; let buildEvidence;

function digest(value) { return createHash('sha256').update(value).digest('hex'); }
async function treeIdentity(directory) {
  const result = {};
  async function visit(current, prefix = '') {
    for (const name of (await fs.readdir(current)).sort()) {
      const absolute = path.join(current, name); const relative = prefix + name; const stat = await fs.lstat(absolute);
      assert.equal(stat.isSymbolicLink(), false, `unexpected fixture symlink: ${relative}`);
      if (stat.isDirectory()) await visit(absolute, relative + '/');
      else result[relative] = { sha256: digest(await fs.readFile(absolute)), mode: stat.mode & 0o777 };
    }
  }
  await visit(directory); return result;
}
function rustArgs(output, options = {}) {
  return ['infer', '--from', from, '--to', to, '--compiler', compiler, '--out', output,
    '--node', process.execPath, ...(options.worker ? ['--worker', options.worker] : []),
    ...(options.timeoutMs ? ['--timeout-ms', String(options.timeoutMs)] : []),
    ...(options.maxOutputBytes ? ['--max-output-bytes', String(options.maxOutputBytes)] : []),
    ...(options.extra ?? [])];
}
function runRust(output, options = {}) {
  return spawnSync(binary, rustArgs(output, options), {
    cwd: options.cwd ?? root,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: 'utf8', timeout: options.processTimeout ?? 15000, maxBuffer: 4 * 1024 * 1024,
  });
}
function spawnRust(output, options = {}) {
  return spawn(binary, rustArgs(output, options), {
    cwd: options.cwd ?? root,
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
function collect(child, timeoutMs = 5000) {
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
  return Promise.race([
    new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }))),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Rust coordinator did not exit within test bound')), timeoutMs)),
  ]);
}
function directNode() {
  const request = { protocolVersion: 1, requestId: 'a'.repeat(64), method: 'infer', params: { from, to, compiler } };
  const result = spawnSync(process.execPath, [worker], { input: JSON.stringify(request), encoding: 'utf8', cwd: root, maxBuffer: 32 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.requestId, request.requestId);
  return envelope.result;
}
function directEnvelope(caseFrom, caseTo, requestId) {
  const request = { protocolVersion: 1, requestId, method: 'infer', params: { from: caseFrom, to: caseTo, compiler } };
  const result = spawnSync(process.execPath, [worker], { input: JSON.stringify(request), encoding: 'utf8', cwd: root, maxBuffer: 32 * 1024 * 1024 });
  assert.ok([0, 1].includes(result.status), result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.requestId, requestId);
  return { process: result, envelope };
}
async function assertInputsUnchanged() { assert.deepEqual({ from: await treeIdentity(from), to: await treeIdentity(to) }, inputIdentity); }
async function pathMissing(file) { try { await fs.lstat(file); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; } }
async function names() { return new Set(await fs.readdir(root)); }
function addedNames(before, after) { return [...after].filter((name) => !before.has(name)).sort(); }
function fixture(name) { return path.join(workers, `${name}.mjs`); }
function processExists(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } }
async function waitForFile(file, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${path.basename(file)}`);
}
async function waitForExit(pid, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && processExists(pid)) await new Promise((resolve) => setTimeout(resolve, 20));
  return !processExists(pid);
}

before(async () => {
  assert.ok(compiler && path.isAbsolute(compiler), 'SHIFT_TYPESCRIPT_PATH must identify the trusted TypeScript compiler');
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'shift-rust-integration-'));
  from = path.join(root, 'old'); to = path.join(root, 'new');
  await fs.mkdir(path.join(to, 'docs'), { recursive: true }); await fs.mkdir(from, { recursive: true });
  await fs.writeFile(path.join(from, 'package.json'), JSON.stringify({ name: '@rust-test/ui', version: '1.0.0', types: 'index.d.ts' }));
  await fs.writeFile(path.join(from, 'index.d.ts'), "export interface SharedProps { label: string; }\nexport declare function OldAction(props: SharedProps): unknown;\n");
  await fs.writeFile(path.join(to, 'package.json'), JSON.stringify({ name: '@rust-test/ui', version: '2.0.0', types: 'index.d.ts' }));
  await fs.writeFile(path.join(to, 'index.d.ts'), "export interface SharedProps { label: string; }\nexport declare function PrimaryAction(props: SharedProps): unknown;\n");
  await fs.writeFile(path.join(to, 'docs/migration.md'), 'Replace `OldAction` with `PrimaryAction`.\n');
  inputIdentity = { from: await treeIdentity(from), to: await treeIdentity(to) };

  const freshCwd = path.join(root, 'build-cwd'); await fs.mkdir(freshCwd);
  if (process.env.SHIFT_RUST_BINARY) {
    binary = path.resolve(process.env.SHIFT_RUST_BINARY);
    buildEvidence = { source: 'SHIFT_RUST_BINARY', cwd: freshCwd };
  } else {
    const build = spawnSync('cargo', ['build', '--locked', ...(rustProfile === 'release' ? ['--release'] : []), '--manifest-path', manifest, '--bin', 'ctrl-shift'], { cwd: freshCwd, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    assert.equal(build.status, 0, build.stdout + build.stderr);
    binary = path.join(repository, 'target', rustProfile, process.platform === 'win32' ? 'ctrl-shift.exe' : 'ctrl-shift');
    buildEvidence = { source: `cargo build --locked (${rustProfile})`, cwd: freshCwd, stdout: build.stdout, stderr: build.stderr };
  }
  assert.equal((await fs.stat(binary)).isFile(), true);
  for (const registration of corpusRegistrations) assert.equal(digest(await fs.readFile(registration.file)), registration.sha256, `${registration.name} corpus changed`);
});

after(async () => {
  for (const registration of corpusRegistrations) assert.equal(digest(await fs.readFile(registration.file)), registration.sha256, `${registration.name} corpus changed during parity run`);
  if (root) await fs.rm(root, { recursive: true, force: true });
});

test('compiles from a fresh unrelated working directory', () => {
  assert.notEqual(path.resolve(buildEvidence.cwd), repository);
  assert.ok(path.isAbsolute(binary));
});

test('Rust output equals direct production Node inference and reruns byte-deterministically', async () => {
  const expected = directNode();
  const first = path.join(root, 'first.json'); const second = path.join(root, 'second.json');
  const before = await names();
  const one = runRust(first, { cwd: path.join(root, 'build-cwd') }); const two = runRust(second, { cwd: os.tmpdir() });
  assert.equal(one.status, 0, one.stderr); assert.equal(two.status, 0, two.stderr);
  assert.deepEqual(JSON.parse(await fs.readFile(first, 'utf8')), expected);
  assert.deepEqual(await fs.readFile(second), await fs.readFile(first));
  assert.equal((await fs.stat(first)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(second)).mode & 0o777, 0o600);
  assert.deepEqual(addedNames(before, await names()), ['first.json', 'second.json']);
  await assertInputsUnchanged();
});

test('worker request has exact version, method, absolute params and 64-hex correlation', async () => {
  const output = path.join(root, 'record-output.json'); const record = path.join(root, 'recorded-request.json');
  const result = runRust(output, { worker: fixture('record-request'), env: { SHIFT_RUST_ENV_SENTINEL: 'must-not-reach-worker', GIT_DIR: '/hostile/git-dir' } });
  assert.equal(result.status, 0, result.stderr);
  const request = JSON.parse(await fs.readFile(record, 'utf8'));
  assert.deepEqual(Object.keys(request).sort(), ['method', 'params', 'protocolVersion', 'requestId']);
  assert.equal(request.protocolVersion, 1); assert.equal(request.method, 'infer'); assert.match(request.requestId, /^[a-f0-9]{64}$/);
  assert.deepEqual(request.params, { from: await fs.realpath(from), to: await fs.realpath(to), compiler: await fs.realpath(compiler) });
  const workerEnv = JSON.parse(await fs.readFile(path.join(root, 'recorded-worker-env.json'), 'utf8'));
  const allowedKeys = process.platform === 'darwin' ? ['PATH', '__CF_USER_TEXT_ENCODING'] : ['PATH'];
  assert.deepEqual(Object.keys(workerEnv).sort(), allowedKeys.sort());
  assert.equal(typeof workerEnv.PATH, 'string');
  assert.equal(workerEnv.SHIFT_RUST_ENV_SENTINEL, undefined); assert.equal(workerEnv.GIT_DIR, undefined);
});

for (const [caseIndex, scenario] of corpusCases.entries()) {
  test(`Rust transport matches direct Node on released ${scenario.study}/${scenario.id}`, async () => {
    const caseRoot = path.join(root, 'corpus', scenario.study, scenario.id);
    for (const [relative, content] of Object.entries(scenario.files)) {
      const file = path.join(caseRoot, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content, { flag: 'wx' });
    }
    const caseFrom = await fs.realpath(path.join(caseRoot, 'from')); const caseTo = await fs.realpath(path.join(caseRoot, 'to'));
    const before = { from: await treeIdentity(caseFrom), to: await treeIdentity(caseTo) };
    const requestId = caseIndex.toString(16).padStart(64, '0');
    const direct = directEnvelope(caseFrom, caseTo, requestId);
    const output = path.join(root, 'corpus-results', `${scenario.study}-${scenario.id}.json`); await fs.mkdir(path.dirname(output), { recursive: true });
    const rust = spawnSync(binary, ['infer', '--from', caseFrom, '--to', caseTo, '--compiler', compiler, '--out', output, '--node', process.execPath], { cwd: os.tmpdir(), encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
    if (direct.envelope.ok) {
      assert.equal(direct.process.status, 0, direct.process.stderr); assert.equal(rust.status, 0, rust.stderr);
      assert.deepEqual(JSON.parse(await fs.readFile(output, 'utf8')), direct.envelope.result);
    } else {
      assert.equal(direct.process.status, 1); assert.equal(rust.status, 1, rust.stderr); assert.equal(await pathMissing(output), true);
    }
    assert.deepEqual({ from: await treeIdentity(caseFrom), to: await treeIdentity(caseTo) }, before);
  });
}

for (const [name, options] of [
  ['malformed', {}], ['trailing', {}], ['oversized', { maxOutputBytes: 1024 }], ['wrong-version', {}],
  ['wrong-correlation', {}], ['executable-proposal', {}], ['bad-evidence-hash', {}], ['bad-evidence-path', {}],
  ['bad-evidence-range', {}], ['missing-target-shape', {}], ['success-then-nonzero', {}], ['error-envelope', {}], ['noisy-stderr', {}], ['duplicate-fields', {}],
  ['success-extra-error-null', {}], ['failure-extra-result-null', {}],
  ['no-final-lf', {}], ['double-lf', {}], ['crlf', {}],
]) {
  test(`rejects ${name} worker output without publishing a contract`, async () => {
    const output = path.join(root, `rejected-${name}.json`);
    const before = await names();
    const result = runRust(output, { ...options, worker: fixture(name) });
    assert.equal(result.status, 1, `stdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.equal(await pathMissing(output), true);
    assert.deepEqual(addedNames(before, await names()), [], 'coordinator left an owned temporary artifact');
    await assertInputsUnchanged();
  });
}

test('rejects unknown worker error codes as protocol violations', async () => {
  const output = path.join(root, 'unknown-error-code.json');
  const result = runRust(output, { worker: fixture('unknown-error-code') });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /protocol|unknown|error code|shape mismatch/i);
  assert.equal(await pathMissing(output), true);
});

test('strict argument parser rejects unknown and duplicate flags as usage errors', () => {
  const unknown = runRust(path.join(root, 'unknown.json'), { extra: ['--unknown-flag'] });
  const duplicate = runRust(path.join(root, 'duplicate.json'), { extra: ['--from', from] });
  assert.equal(unknown.status, 2); assert.equal(duplicate.status, 2);
});

test('refuses to overwrite an existing output', async () => {
  const output = path.join(root, 'existing.json'); await fs.writeFile(output, 'owner bytes');
  const before = await names(); const result = runRust(output); assert.equal(result.status, 1); assert.equal(await fs.readFile(output, 'utf8'), 'owner bytes');
  assert.deepEqual(await names(), before);
});

test('refuses output inside an input and through a symlink alias', async (t) => {
  const inside = path.join(from, 'contract.json'); assert.equal(runRust(inside).status, 1); assert.equal(await pathMissing(inside), true);
  const alias = path.join(root, 'old-alias');
  try { await fs.symlink(from, alias, 'dir'); } catch (error) { if (error.code === 'EPERM') return t.skip('directory symlinks unavailable'); throw error; }
  const aliased = path.join(alias, 'contract.json'); assert.equal(runRust(aliased).status, 1); assert.equal(await pathMissing(path.join(from, 'contract.json')), true);
});

test('timeout kills a hanging worker and its descendant', async () => {
  const output = path.join(root, 'timeout.json'); const marker = path.join(root, 'hang-pids.json');
  const result = runRust(output, { worker: fixture('hang-with-child'), timeoutMs: 300, processTimeout: 5000 });
  assert.equal(result.status, 124, result.stderr); const pids = JSON.parse(await fs.readFile(marker, 'utf8'));
  assert.equal(await waitForExit(pids.worker), true); assert.equal(await waitForExit(pids.child), true); assert.equal(await pathMissing(output), true);
  await fs.rm(marker);
});

test('worker leader exit cannot leave a pipe-holding descendant past the deadline', async () => {
  const output = path.join(root, 'pipe-child.json'); const marker = path.join(root, 'pipe-child-pids.json');
  const started = Date.now();
  const result = runRust(output, { worker: fixture('exit-with-pipe-child'), timeoutMs: 3000, processTimeout: 5000 });
  assert.equal(result.status, 0, result.stderr); assert.ok(Date.now() - started < 5000, 'pipe-holding descendant escaped cleanup bound');
  const pids = JSON.parse(await fs.readFile(marker, 'utf8'));
  assert.equal(await waitForExit(pids.worker), true); assert.equal(await waitForExit(pids.child), true);
  assert.equal(JSON.parse(await fs.readFile(output, 'utf8')).kind, 'migration-contract');
});

for (const [name, markerName, options] of [
  ['oversized-with-child', 'oversized-child-pids.json', { maxOutputBytes: 1024 }],
  ['stderr-with-child', 'stderr-child-pids.json', {}],
  ['infinite-stdout-with-child', 'infinite-child-pids.json', { maxOutputBytes: 1024 }],
]) {
  test(`${name} limit failure kills worker and descendant`, async () => {
    const output = path.join(root, `${name}.json`); const marker = path.join(root, markerName);
    const result = runRust(output, { worker: fixture(name), processTimeout: 5000, ...options });
    assert.equal(result.status, 1, result.stderr); assert.notEqual(result.status, 124); const pids = JSON.parse(await fs.readFile(marker, 'utf8'));
    assert.equal(await waitForExit(pids.worker), true); assert.equal(await waitForExit(pids.child), true); assert.equal(await pathMissing(output), true);
  });
}

test('input drift while the worker runs rejects the result', async () => {
  const output = path.join(root, 'input-drift.json'); const marker = path.join(root, 'drift-ready.json'); const release = path.join(root, 'drift-release');
  const source = path.join(from, 'index.d.ts'); const original = await fs.readFile(source);
  const child = spawnRust(output, { worker: fixture('wait-for-release') }); const completion = collect(child);
  try {
    await waitForFile(marker); await fs.appendFile(source, '\n// changed during worker execution\n'); await fs.writeFile(release, 'release');
    const result = await completion; assert.equal(result.code, 1, result.stderr); assert.equal(await pathMissing(output), true);
  } finally {
    if (processExists(child.pid)) child.kill('SIGKILL');
    await fs.writeFile(source, original); await fs.rm(marker, { force: true }); await fs.rm(release, { force: true });
  }
  await assertInputsUnchanged();
});

test('worker tool drift while the worker runs rejects the result', async () => {
  const output = path.join(root, 'tool-drift.json'); const marker = path.join(root, 'tool-ready.json'); const release = path.join(root, 'tool-release');
  const tool = path.join(root, 'mutable-worker.mjs');
  const inferenceUrl = new URL('../../src/inference.mjs', import.meta.url).href;
  const code = `import fs from 'node:fs/promises';import path from 'node:path';\nlet text='';for await(const c of process.stdin)text+=c;const request=JSON.parse(text);const parent=path.dirname(await fs.realpath(request.params.from));await fs.writeFile(path.join(parent,'tool-ready.json'),JSON.stringify({worker:process.pid}),{flag:'wx'});while(true){try{await fs.access(path.join(parent,'tool-release'));break}catch(e){if(e.code!=='ENOENT')throw e}await new Promise(r=>setTimeout(r,10))}const {inferContract}=await import(${JSON.stringify(inferenceUrl)});const result=await inferContract(request.params);process.stdout.write(JSON.stringify({protocolVersion:1,requestId:request.requestId,ok:true,result})+'\\n');\n`;
  await fs.writeFile(tool, code);
  const child = spawnRust(output, { worker: tool }); const completion = collect(child);
  try {
    await waitForFile(marker); await fs.appendFile(tool, '\n// tool drift\n'); await fs.writeFile(release, 'release');
    const result = await completion; assert.equal(result.code, 1, result.stderr); assert.equal(await pathMissing(output), true);
  } finally { if (processExists(child.pid)) child.kill('SIGKILL'); }
});

test('SIGINT returns 130 and kills worker descendants', { skip: process.platform === 'win32' }, async () => {
  const output = path.join(root, 'cancel.json'); const marker = path.join(root, 'hang-pids.json');
  const child = spawnRust(output, { worker: fixture('hang-with-child'), timeoutMs: 10000 }); const completion = collect(child);
  const pids = await waitForFile(marker); child.kill('SIGINT'); const result = await completion;
  assert.equal(result.code, 130, `stdout=${result.stdout}\nstderr=${result.stderr}`); assert.equal(await waitForExit(pids.worker), true); assert.equal(await waitForExit(pids.child), true); assert.equal(await pathMissing(output), true);
});
