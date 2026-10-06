import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourceWrapper = path.join(repository, 'bin/rhubase');

async function checkout(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhubase repository with spaces-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'bin'), { recursive: true });
  await fs.copyFile(sourceWrapper, path.join(root, 'bin/rhubase'));
  if (options.binary !== false) {
    const binary = path.join(root, 'target/release/ctrl-shift');
    await fs.mkdir(path.dirname(binary), { recursive: true });
    await fs.writeFile(binary, `#!${process.execPath}\nconst result={cwd:process.cwd(),args:process.argv.slice(2),marker:process.env.RHUBASE_CLI??null,compiler:process.env.SHIFT_TYPESCRIPT_PATH??null};\nprocess.stdout.write(JSON.stringify(result)+'\\n');\nconst at=result.args.indexOf('--fixture-exit'); process.exitCode=at<0?0:Number(result.args[at+1]);\n`);
    await fs.chmod(binary, options.executable === false ? 0o600 : 0o700);
  }
  if (options.compiler !== false) {
    const compiler = path.join(root, 'node_modules/typescript/lib/typescript.js');
    await fs.mkdir(path.dirname(compiler), { recursive: true });
    await fs.writeFile(compiler, '// controlled pinned compiler fixture\n');
  }
  return root;
}

function run(wrapper, args, options = {}) {
  const env = { ...process.env, ...options.env };
  for (const name of options.unset ?? []) delete env[name];
  return spawnSync(process.execPath, [wrapper, ...args], {
    cwd: options.cwd,
    env,
    encoding: 'utf8',
    timeout: 5000,
  });
}

function payload(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

async function waitForFile(file, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return await fs.readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${path.basename(file)}`);
}

test('repository entrypoint is executable', async () => {
  const mode = (await fs.stat(sourceWrapper)).mode & 0o777;
  assert.notEqual(mode & 0o111, 0, 'bin/rhubase must retain an executable bit in Git');
});

test('wrapper preserves caller cwd and argv when invoked through a symlink from a path with spaces', async (t) => {
  const root = await checkout(t);
  const caller = path.join(root, 'caller directory with spaces'); await fs.mkdir(caller);
  const link = path.join(root, 'linked rhubase'); await fs.symlink(path.join(root, 'bin/rhubase'), link);
  const value = payload(run(link, ['assess', './consumer app', '--source', '@demo/legacy', '--target', '@demo/foundation'], { cwd: caller }));
  assert.equal(value.cwd, await fs.realpath(caller));
  assert.deepEqual(value.args, ['assess', './consumer app', '--source', '@demo/legacy', '--target', '@demo/foundation']);
  assert.equal(value.marker, '1');
});

test('infer uses the checkout pinned compiler when no override is provided', async (t) => {
  const root = await checkout(t);
  const value = payload(run(path.join(root, 'bin/rhubase'), ['infer'], { cwd: root, unset: ['SHIFT_TYPESCRIPT_PATH'] }));
  assert.equal(value.compiler, await fs.realpath(path.join(root, 'node_modules/typescript/lib/typescript.js')));
});

test('assess does not inject a compiler environment override', async (t) => {
  const root = await checkout(t);
  const value = payload(run(path.join(root, 'bin/rhubase'), ['assess'], { cwd: root, unset: ['SHIFT_TYPESCRIPT_PATH'] }));
  assert.equal(value.compiler, null);
});

test('infer preserves an explicit compiler environment override', async (t) => {
  const root = await checkout(t);
  const explicit = path.join(root, 'operator compiler.js');
  const value = payload(run(path.join(root, 'bin/rhubase'), ['infer'], { cwd: root, env: { SHIFT_TYPESCRIPT_PATH: explicit } }));
  assert.equal(value.compiler, explicit);
});

test('infer compiler flag takes precedence without injecting the compiler environment', async (t) => {
  const root = await checkout(t);
  const explicit = path.join(root, 'flag compiler.js');
  const value = payload(run(path.join(root, 'bin/rhubase'), ['infer', '--compiler', explicit], { cwd: root, unset: ['SHIFT_TYPESCRIPT_PATH'] }));
  assert.equal(value.compiler, null);
  assert.deepEqual(value.args, ['infer', '--compiler', explicit]);
});

test('wrapper forwards the coordinator exit status', async (t) => {
  const root = await checkout(t);
  const result = run(path.join(root, 'bin/rhubase'), ['assess', '--fixture-exit', '7'], { cwd: root });
  assert.equal(result.status, 7, result.stderr);
});

test('wrapper forwards SIGINT to the coordinator and exits by SIGINT', async (t) => {
  const root = await checkout(t);
  const binary = path.join(root, 'target/release/ctrl-shift');
  const ready = path.join(root, 'ready'); const interrupted = path.join(root, 'interrupted');
  await fs.writeFile(binary, `#!${process.execPath}\nimport fs from 'node:fs';\nfs.writeFileSync(process.env.RHUBASE_FIXTURE_READY, 'ready');\nprocess.on('SIGINT',()=>{fs.writeFileSync(process.env.RHUBASE_FIXTURE_INTERRUPTED,'interrupted');process.removeAllListeners('SIGINT');process.kill(process.pid,'SIGINT');});\nsetInterval(()=>{},1000);\n`);
  await fs.chmod(binary, 0o700);
  const child = spawn(process.execPath, [path.join(root, 'bin/rhubase'), 'assess'], {
    cwd: root,
    env: { ...process.env, RHUBASE_FIXTURE_READY: ready, RHUBASE_FIXTURE_INTERRUPTED: interrupted },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let stdout = ''; let stderr = ''; child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
  await waitForFile(ready);
  child.kill('SIGINT');
  const outcome = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('wrapper did not exit after SIGINT')), 3000);
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  assert.deepEqual(outcome, { code: null, signal: 'SIGINT' }, stderr || stdout);
  assert.equal(await waitForFile(interrupted), 'interrupted');
});

test('missing build reports exact local recovery commands without attempting a build', async (t) => {
  const root = await checkout(t, { binary: false });
  const result = run(path.join(root, 'bin/rhubase'), ['--help'], { cwd: root });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /npm ci --ignore-scripts/);
  assert.match(result.stderr, /cargo build --release --locked --bin ctrl-shift/);
  assert.equal(result.stdout, '');
  await assert.rejects(fs.access(path.join(root, 'target')), { code: 'ENOENT' });
});

test('missing pinned compiler reports the dependency recovery command without starting infer', async (t) => {
  const root = await checkout(t, { compiler: false });
  const result = run(path.join(root, 'bin/rhubase'), ['infer'], { cwd: root, unset: ['SHIFT_TYPESCRIPT_PATH'] });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /pinned TypeScript runtime/);
  assert.match(result.stderr, /npm ci --ignore-scripts/);
  assert.equal(result.stdout, '');
});

test('coordinator startup failure includes actionable build recovery', async (t) => {
  const root = await checkout(t, { executable: false });
  const result = run(path.join(root, 'bin/rhubase'), ['assess'], { cwd: root });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /could not start its local coordinator/i);
  assert.match(result.stderr, /cargo build --release --locked --bin ctrl-shift/);
});
