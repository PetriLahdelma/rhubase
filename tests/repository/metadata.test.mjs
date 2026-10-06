import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (relative) => fs.readFile(path.join(repository, relative), 'utf8');
const json = async (relative) => JSON.parse(await read(relative));

test('package metadata describes a private GitHub-only RhuBase checkout', async () => {
  const manifest = await json('package.json');
  assert.equal(manifest.name, 'rhubase');
  assert.equal(manifest.private, true, 'private:true prevents accidental npm publication');
  assert.equal(manifest.license, 'MIT');
  assert.deepEqual(manifest.bin, { rhubase: 'bin/rhubase' });
  assert.equal(manifest.repository.url, 'git+https://github.com/PetriLahdelma/rhubase.git');
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepublishOnly']) {
    assert.equal(Object.hasOwn(manifest.scripts, hook), false, `package must not execute ${hook} during installation`);
  }
});

test('package lock preserves the public package identity and pinned compiler', async () => {
  const manifest = await json('package.json');
  const lock = await json('package-lock.json');
  assert.equal(lock.name, manifest.name);
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[''].name, manifest.name);
  assert.equal(lock.packages[''].version, manifest.version);
  assert.equal(lock.packages[''].dependencies.typescript, '5.9.3');
  assert.equal(lock.packages['node_modules/typescript'].version, '5.9.3');
  assert.equal(lock.packages['node_modules/typescript'].license, 'Apache-2.0');
});

test('public verification scripts exclude legacy Docker, browser, workflow and agent execution', async () => {
  const manifest = await json('package.json');
  assert.deepEqual(Object.keys(manifest.scripts).sort(), ['check', 'example:assess', 'test', 'test:cli', 'verify']);
  assert.equal(manifest.scripts.verify, 'node scripts/verify.mjs');
  assert.equal(manifest.scripts['test:cli'], 'node scripts/test-cli.mjs');
  assert.equal(manifest.scripts['example:assess'], 'node scripts/example-assess.mjs');
  const source = await read('scripts/verify.mjs');
  assert.doesNotMatch(source, /test-all|tests\/(?:docker|browser|workflow)|workflow-agent|demo:agent|claude/i);
});

test('controlled example contains no package script, network or model invocation', async () => {
  const source = await read('scripts/example-assess.mjs');
  assert.doesNotMatch(source, /\b(?:npm|pnpm|yarn|bun)\b.*\brun\b|child_process.*exec|\bfetch\s*\(|https?:\/\/|\b(?:claude|openai|anthropic)\b/i);
  assert.match(source, /spawnSync\(wrapper/);
  assert.match(source, /'assess'/);
});

test('root license and third-party notices cover original code, fixtures and pinned dependencies', async () => {
  const license = await read('LICENSE');
  const notices = await read('THIRD_PARTY_NOTICES.md');
  assert.match(license, /^MIT License/m);
  assert.match(license, /Copyright \(c\) 2026 Petri Lahdelma/);
  assert.match(notices, /Apache Superset/i);
  assert.match(notices, /Ant Design/i);
  assert.match(notices, /TypeScript 5\.9\.3/i);
  assert.match(notices, /Rust dependencies/i);
  assert.match(notices, /Brand assets/i);
});

test('Rust package metadata preserves the first-party license and disables registry publication', async () => {
  const manifest = await read('rust/ctrl-shift/Cargo.toml');
  assert.match(manifest, /^license\s*=\s*"MIT"$/m);
  assert.match(manifest, /^publish\s*=\s*false$/m);
});

test('GitHub verification uses pinned actions, read-only credentials and public local commands', async () => {
  const workflow = await read('.github/workflows/ci.yml');
  assert.match(workflow, /permissions:\s*\n\s*contents: read/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /npm ci --ignore-scripts/);
  for (const command of ['npm run verify', 'npm run test:cli', 'npm run example:assess']) assert.match(workflow, new RegExp(command.replaceAll(' ', '\\s+')));
  assert.doesNotMatch(workflow, /\$\{\{\s*secrets\.|permissions:\s*write|pull-requests:\s*write/i);
  const actions = [...workflow.matchAll(/uses:\s*([^\s#]+)(?:\s*#.*)?$/gm)].map((match) => match[1]);
  assert.ok(actions.length >= 2);
  for (const action of actions) assert.match(action, /^[^@\s]+@[a-f0-9]{40}$/, `action must be pinned to a full commit: ${action}`);
});
