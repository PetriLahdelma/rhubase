import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = path.join(repository, 'Cargo.toml');
const compiler = process.env.SHIFT_TYPESCRIPT_PATH;
const hangWorker = path.join(repository, 'tests/rust/workers/hang-with-child.mjs');
const ptyHarness = path.join(repository, 'tests/rust/fixtures/pty_capture.py');
const ansi = /\x1b\[[0-9;]*m/;
const stripAnsi = (value) => value.replaceAll(/\x1b\[[0-9;]*m/g, '');
let root; let from; let to; let binary;

function args(output, extras = []) {
  return ['infer', '--from', from, '--to', to, '--compiler', compiler, '--out', output, '--node', process.execPath, ...extras];
}
function run(argv, options = {}) {
  const env = { ...process.env, ...(options.env ?? {}) };
  for (const key of options.unsetEnv ?? []) delete env[key];
  return spawnSync(binary, argv, { cwd: options.cwd ?? root, env, encoding: 'utf8', timeout: options.timeout ?? 15000, maxBuffer: 8 * 1024 * 1024 });
}
function runPty(argv, options = {}) {
  const selectedEnv = { TERM: 'xterm-256color', LC_ALL: 'C.UTF-8', ...(options.env ?? {}) };
  const unsetEnv = [...(options.unsetEnv ?? [])]; if (!Object.hasOwn(selectedEnv, 'NO_COLOR')) unsetEnv.push('NO_COLOR');
  const request = { argv: [binary, ...argv], width: options.width ?? 80, env: selectedEnv, unsetEnv };
  const result = spawnSync('python3', [ptyHarness], { input: JSON.stringify(request), cwd: root, encoding: 'utf8', timeout: options.timeout ?? 15000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  return { status: response.exitCode, raw: Buffer.from(response.outputBase64, 'base64'), text: Buffer.from(response.outputBase64, 'base64').toString('utf8').replaceAll('\r', '') };
}
function assertOneJson(result, expectedKind) {
  assert.equal(result.stderr, ''); assert.equal(ansi.test(result.stdout), false); assert.match(result.stdout, /^[^\r\n]+\n$/);
  const value = JSON.parse(result.stdout); assert.equal(value.schemaVersion, 1); assert.equal(value.kind, expectedKind); return value;
}
async function waitForFile(file, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timeout waiting for ${path.basename(file)}`);
}
function processExists(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } }
function collectProcess(child, timeoutMs = 10000) {
  let stderr = ''; child.stderr?.on('data', (chunk) => { stderr += chunk; });
  return Promise.race([
    new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal, stderr }))),
    new Promise((_, reject) => setTimeout(() => reject(new Error('CLI did not exit after its output pipe closed')), timeoutMs)),
  ]);
}
async function waitForExit(pid, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && processExists(pid)) await new Promise((resolve) => setTimeout(resolve, 20));
  return !processExists(pid);
}

before(async () => {
  assert.ok(compiler && path.isAbsolute(compiler), 'SHIFT_TYPESCRIPT_PATH must be explicit');
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'shift-cli-experience-'));
  from = path.join(root, 'old'); to = path.join(root, 'new'); await fs.mkdir(from); await fs.mkdir(path.join(to, 'docs'), { recursive: true });
  await fs.writeFile(path.join(from, 'package.json'), '{"name":"@experience/ui","version":"1.0.0","types":"index.d.ts"}');
  await fs.writeFile(path.join(from, 'index.d.ts'), "export declare function OldAction(props: { label: string }): unknown;\nexport declare function Removed(props: {}): unknown;\n");
  await fs.writeFile(path.join(to, 'package.json'), '{"name":"@experience/ui","version":"2.0.0","types":"index.d.ts"}');
  await fs.writeFile(path.join(to, 'index.d.ts'), "export declare function PrimaryAction(props: { label: string }): unknown;\nexport declare function Added(props: {}): unknown;\n");
  await fs.writeFile(path.join(to, 'docs/migration.md'), 'Replace `OldAction` with `PrimaryAction`.\n');
  const fresh = path.join(root, 'build-cwd'); await fs.mkdir(fresh);
  const build = spawnSync('cargo', ['build', '--locked', '--release', '--manifest-path', manifest, '--bin', 'ctrl-shift'], { cwd: fresh, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  assert.equal(build.status, 0, build.stdout + build.stderr);
  binary = path.join(repository, 'target/release/ctrl-shift');
});
after(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });

test('no arguments and top-level help render branded TTY help without validating paths', () => {
  for (const argv of [[], ['--help']]) {
    const result = runPty(argv, { width: 80 }); assert.equal(result.status, 0);
    const plain = stripAnsi(result.text); assert.match(plain, /╭ ctrl ╮\s+╭ shift ╮/); assert.match(plain, /read-only design-system comparison/);
    assert.match(plain, /ctrl-shift infer\s+compare two package snapshots/); assert.match(plain, /ctrl-shift assess\s+inventory one consumer repository/);
    assert.match(plain, /ctrl-shift infer --help/); assert.match(plain, /ctrl-shift assess --help/); assert.equal(ansi.test(result.text), true);
  }
});

test('narrow TTY help uses stacked ASCII fallback and remains readable', () => {
  const result = runPty(['--help', '--color', 'never'], { width: 40 }); assert.equal(result.status, 0);
  assert.match(result.text, /\[ ctrl \] \+ \[ shift \]/); assert.doesNotMatch(result.text, /╭|◆|✓/); assert.equal(ansi.test(result.text), false);
  assert.match(result.text, /ctrl-shift infer\n\s+compare two package snapshots/); assert.match(result.text, /ctrl-shift assess\n\s+inventory one consumer repository/);
  for (const line of result.text.split('\n')) assert.ok([...line].length <= 40, `unbounded narrow help line: ${line}`);
  const colored = runPty(['--help'], { width: 40 }); assert.equal(ansi.test(colored.text), true); assert.match(stripAnsi(colored.text), /\[ ctrl \] \+ \[ shift \]/);
  assert.match(colored.text, /\[ \x1b\[1mctrl\x1b\[0m \] \x1b\[36m\+\x1b\[0m \[ \x1b\[1mshift\x1b\[0m \]/);
});

test('infer help groups options and version exits zero without path validation', () => {
  const help = run(['infer', '--help'], { unsetEnv: ['SHIFT_TYPESCRIPT_PATH'] }); assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Inputs/); assert.match(help.stdout, /Runtime/); assert.match(help.stdout, /Output/); assert.match(help.stdout, /trusted[- ]operator/i);
  assert.match(help.stdout, /parent\s+(?:directory\s+)?must\s+(?:already\s+)?exist/i);
  for (const width of [80, 40]) {
    const ttyHelp = stripAnsi(runPty(['infer', '--help'], { width }).text);
    assert.match(ttyHelp, /parent\s+(?:directory\s+)?must\s+(?:already\s+)?exist/i);
  }
  const version = run(['--version'], { unsetEnv: ['SHIFT_TYPESCRIPT_PATH'] }); assert.equal(version.status, 0); assert.match(version.stdout, /^ctrl-shift 0\.1\.0\n$/);
});

test('non-TTY auto output is plain, banner-free, and stage-free', async () => {
  const output = path.join(root, 'plain.json'); const result = run(args(output)); assert.equal(result.status, 0, result.stderr);
  assert.equal(ansi.test(result.stdout + result.stderr), false); assert.doesNotMatch(result.stdout, /╭ ctrl|\[ctrl\]/); assert.doesNotMatch(result.stderr, /Inspecting|Comparing|Validating|Saving/);
  assert.match(result.stdout, /Draft contract saved/); assert.equal((await fs.stat(output)).isFile(), true);
});

test('TTY success shows real stages and summary counts equal the artifact', () => {
  const output = path.join(root, 'tty-success.json'); const result = runPty(args(output), { width: 80 }); assert.equal(result.status, 0, result.text);
  assert.equal(ansi.test(result.text), true); const plain = stripAnsi(result.text);
  for (const stage of ['Inspecting snapshots', 'Inputs accepted', 'Comparing public APIs and tokens', 'Worker response received', 'Validating contract evidence', 'Evidence references accepted', 'Saving draft contract']) assert.match(plain, new RegExp(stage));
  assert.match(plain, /Draft contract saved/); assert.match(plain, /Read-only: no migration was run\. Input snapshots are unchanged\./); assert.doesNotMatch(plain, /migration complete|ready to merge|safe to migrate/i);
  const contract = JSON.parse(readFileSync(output, 'utf8'));
  assert.match(plain, new RegExp(`Changes found\\s+${contract.changes.length}`));
  assert.match(plain, new RegExp(`Mappings to review\\s+${contract.proposals.length}`));
  assert.match(plain, new RegExp(`Unresolved items\\s+${contract.unresolved.length}`));
  assert.match(plain, /Next: review 1 mapping proposal and 1 unresolved item\./);
});

test('zero-review success points to draft inspection without zero-task prose', async () => {
  const oldSame = path.join(root, 'old-same'); const newSame = path.join(root, 'new-same'); await fs.mkdir(oldSame); await fs.mkdir(newSame);
  for (const [directory, version] of [[oldSame, '1.0.0'], [newSame, '2.0.0']]) {
    await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: '@experience/same', version, types: 'index.d.ts' }));
    await fs.writeFile(path.join(directory, 'index.d.ts'), 'export declare const value: string;\n');
  }
  const output = path.join(root, 'zero-review.json');
  const result = runPty(['infer', '--from', oldSame, '--to', newSame, '--compiler', compiler, '--out', output, '--node', process.execPath]); assert.equal(result.status, 0, result.text);
  const plain = stripAnsi(result.text); assert.match(plain, /Mappings to review\s+0/); assert.match(plain, /Unresolved items\s+0/);
  const next = plain.split('\n').find((line) => line.startsWith('Next:')) ?? '';
  assert.equal(next, 'Next: inspect the draft contract before using it to plan migration work.'); assert.doesNotMatch(next, /review 0|0 mapping|0 unresolved/i);
});

test('auto/always/never, NO_COLOR and TERM=dumb follow stream precedence', () => {
  const pipedAuto = run(['--help']); assert.equal(ansi.test(pipedAuto.stdout), false); assert.doesNotMatch(pipedAuto.stdout, /╭ ctrl/);
  const pipedAlways = run(['--color', 'always', '--help']); assert.equal(ansi.test(pipedAlways.stdout), true); assert.doesNotMatch(pipedAlways.stdout, /╭ ctrl/);
  const ttyNever = runPty(['--help', '--color', 'never']); assert.equal(ansi.test(ttyNever.text), false);
  const noColor = runPty(['--help'], { env: { NO_COLOR: '1' } }); assert.equal(ansi.test(noColor.text), false); assert.match(noColor.text, /\[ ctrl \]/);
  const emptyNoColor = runPty(['--help'], { env: { NO_COLOR: '' } }); assert.equal(ansi.test(emptyNoColor.text), true);
  const forced = runPty(['--help', '--color', 'always'], { env: { NO_COLOR: '1' } }); assert.equal(ansi.test(forced.text), true);
  const dumb = runPty(['--help'], { env: { TERM: 'dumb' } }); assert.equal(ansi.test(dumb.text), false); assert.doesNotMatch(dumb.text, /╭ ctrl/);
});

test('missing compiler and typo errors are corrective and nonzero', () => {
  const missing = run(['infer', '--from', from, '--to', to, '--out', path.join(root, 'missing-compiler.json')], { unsetEnv: ['SHIFT_TYPESCRIPT_PATH'] });
  assert.equal(missing.status, 2); assert.equal(missing.stdout, ''); assert.match(missing.stderr, /TypeScript compiler is required/); assert.match(missing.stderr, /--compiler FILE|SHIFT_TYPESCRIPT_PATH/);
  assert.match(missing.stderr, /required\.\n\nPass/); assert.equal(missing.stderr.includes('\\n'), false);
  const typo = run(['infer', '--form', from]); assert.equal(typo.status, 2); assert.match(typo.stderr, /unknown option `--form`/); assert.match(typo.stderr, /Did you mean `--from`/);
});

test('generic missing required arguments point to infer help with real line breaks', () => {
  for (const argv of [
    ['infer', '--to', to, '--out', path.join(root, 'missing-from.json'), '--compiler', compiler],
    ['infer', '--from', from, '--to', to, '--compiler', compiler],
  ]) {
    const result = run(argv); assert.equal(result.status, 2); assert.equal(result.stdout, '');
    assert.match(result.stderr, /ctrl-shift infer --help/); assert.equal(result.stderr.includes('\\n'), false); assert.match(result.stderr, /\n/);
  }
});

test('compiler CLI flag overrides environment and environment supplies omitted flag', () => {
  const explicit = path.join(root, 'compiler-explicit.json'); const byEnv = path.join(root, 'compiler-env.json');
  const one = run(args(explicit), { env: { SHIFT_TYPESCRIPT_PATH: '/invalid/compiler.js' } }); assert.equal(one.status, 0, one.stderr);
  const withoutCompiler = ['infer', '--from', from, '--to', to, '--out', byEnv, '--node', process.execPath];
  const two = run(withoutCompiler, { env: { SHIFT_TYPESCRIPT_PATH: compiler } }); assert.equal(two.status, 0, two.stderr);
});

test('quiet success emits nothing while quiet failure keeps stderr', () => {
  const output = path.join(root, 'quiet.json'); const success = run(args(output, ['--quiet'])); assert.equal(success.status, 0); assert.equal(success.stdout, ''); assert.equal(success.stderr, '');
  const failure = run(['--quiet', 'infer', '--from', from, '--to', to, '--out', output, '--compiler', compiler]); assert.equal(failure.status, 1); assert.equal(failure.stdout, ''); assert.notEqual(failure.stderr, ''); assert.doesNotMatch(failure.stderr, /Draft contract saved/);
});

test('JSON success is one ANSI-free object and counts/path equal the artifact', async () => {
  const output = path.join(root, 'json-success.json'); const result = run(['--json', ...args(output), '--color', 'always', '--quiet']); assert.equal(result.status, 0, result.stderr);
  const value = assertOneJson(result, 'ctrl-shift-run-summary'); const contract = JSON.parse(await fs.readFile(output, 'utf8'));
  assert.deepEqual(value, { schemaVersion: 1, kind: 'ctrl-shift-run-summary', command: 'infer', status: 'draft-contract-saved', contractPath: await fs.realpath(output), counts: { changes: contract.changes.length, proposalsNeedingReview: contract.proposals.length, unresolved: contract.unresolved.length }, inputsChanged: false });
});

test('JSON error, help and version each use one stdout object with empty stderr', () => {
  const error = run(['--json', 'infer', '--from', from], { unsetEnv: ['SHIFT_TYPESCRIPT_PATH'] }); assert.equal(error.status, 2); const errorValue = assertOneJson(error, 'ctrl-shift-error'); assert.equal(errorValue.exitCode, 2); assert.ok(errorValue.error.code); assert.ok(errorValue.error.message);
  const help = run(['infer', '--json', '--help']); assert.equal(help.status, 0); const helpValue = assertOneJson(help, 'ctrl-shift-help'); assert.equal(helpValue.command, 'infer'); assert.match(helpValue.text, /Inputs/);
  const version = run(['--json', '--version']); assert.equal(version.status, 0); const versionValue = assertOneJson(version, 'ctrl-shift-version'); assert.equal(versionValue.version, '0.1.0');
  const parseAfter = run(['infer', '--form', from, '--json']); assert.equal(parseAfter.status, 2); assertOneJson(parseAfter, 'ctrl-shift-error');
});

test('global JSON and color flags work before or after infer', () => {
  const first = path.join(root, 'flags-before.json'); const second = path.join(root, 'flags-after.json');
  const a = assertOneJson(run(['--json', '--color', 'never', ...args(first)]), 'ctrl-shift-run-summary');
  const b = assertOneJson(run([...args(second), '--json', '--color', 'never']), 'ctrl-shift-run-summary');
  assert.deepEqual(a.counts, b.counts);
});

test('display escapes terminal controls and bidi while filesystem uses the exact path', async () => {
  const malicious = path.join(root, 'report\x1b[31m\nline\rreturn\x7f\x9b\u202e\u2066.json');
  const human = run(args(malicious, ['--color', 'never'])); assert.equal(human.status, 0, human.stderr);
  for (const raw of ['\x1b', '\r', '\x7f', '\x9b', '\u202e', '\u2066']) assert.equal(human.stdout.includes(raw), false);
  for (const escaped of [/\\x1b/i, /\\n/, /\\r/, /\\x7f|\\u\{7f\}/i, /\\x9b|\\u\{9b\}/i, /\\u\{202e\}/i, /\\u\{2066\}/i]) assert.match(human.stdout, escaped);
  assert.equal((await fs.stat(malicious)).isFile(), true);
  const jsonPath = path.join(root, 'json\x1b\n\x7f\x9b\u202e\u2066.json'); const json = run(['--json', ...args(jsonPath)]); assert.equal(json.status, 0);
  for (const raw of ['\x1b', '\x7f', '\x9b', '\u202e', '\u2066']) assert.equal(json.stdout.includes(raw), false);
  assert.equal(JSON.parse(json.stdout).contractPath, await fs.realpath(jsonPath));
});

test('long package identities do not flood the bounded human summary', async () => {
  const oldLong = path.join(root, 'old-long'); const newLong = path.join(root, 'new-long'); await fs.mkdir(oldLong); await fs.mkdir(newLong);
  const longName = `@experience/${'identity'.repeat(60)}`;
  await fs.writeFile(path.join(oldLong, 'package.json'), JSON.stringify({ name: longName, version: '1.0.0', types: 'index.d.ts' }));
  await fs.writeFile(path.join(newLong, 'package.json'), JSON.stringify({ name: longName, version: '2.0.0', types: 'index.d.ts' }));
  await fs.writeFile(path.join(oldLong, 'index.d.ts'), 'export declare const value: string;\n'); await fs.writeFile(path.join(newLong, 'index.d.ts'), 'export declare const value: number;\n');
  const output = path.join(root, 'long-identity.json');
  const result = run(['infer', '--from', oldLong, '--to', newLong, '--compiler', compiler, '--out', output, '--node', process.execPath]);
  assert.equal(result.status, 0, result.stderr); assert.doesNotMatch(result.stdout, new RegExp(longName)); assert.ok(result.stdout.length < 4000); assert.equal((await fs.stat(output)).isFile(), true);
});

test('TTY error is bounded, styled, and never prints false completion', () => {
  const existing = path.join(root, 'tty-existing.json');
  const seed = run(args(existing, ['--quiet'])); assert.equal(seed.status, 0);
  const result = runPty(args(existing), { width: 40 }); assert.equal(result.status, 1); assert.equal(ansi.test(result.text), true);
  const plain = stripAnsi(result.text); assert.match(plain, /Error:/); assert.match(plain, /the output file already exists/); assert.doesNotMatch(plain, /Draft contract saved/);
});

test('closed output pipes do not panic or invalidate a successfully written artifact', async () => {
  const help = spawn(binary, ['--help'], { cwd: root, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  help.stdout.destroy(); const helpResult = await collectProcess(help); assert.equal(helpResult.code, 0, helpResult.stderr); assert.doesNotMatch(helpResult.stderr, /panic|backtrace/i);

  const output = path.join(root, 'broken-pipe-success.json');
  const infer = spawn(binary, args(output), { cwd: root, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  infer.stdout.destroy(); const inferResult = await collectProcess(infer, 15000);
  assert.equal(inferResult.code, 0, inferResult.stderr); assert.doesNotMatch(inferResult.stderr, /panic|contract was not written/i); assert.equal((await fs.stat(output)).isFile(), true);
});

test('SIGINT returns 130, writes no artifact and never prints false completion', { skip: process.platform === 'win32' }, async () => {
  const output = path.join(root, 'cancelled.json'); const marker = path.join(root, 'hang-pids.json');
  const child = spawn(binary, args(output, ['--worker', hangWorker, '--timeout-ms', '10000']), { cwd: root, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = ''; child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
  const pids = await waitForFile(marker); child.kill('SIGINT'); const code = await Promise.race([new Promise((resolve) => child.once('close', resolve)), new Promise((_, reject) => setTimeout(() => reject(new Error('SIGINT ignored')), 5000))]);
  assert.equal(code, 130); assert.doesNotMatch(stdout + stderr, /Draft contract saved/); await assert.rejects(fs.lstat(output), { code: 'ENOENT' }); assert.equal(await waitForExit(pids.worker), true); assert.equal(await waitForExit(pids.child), true);
});
