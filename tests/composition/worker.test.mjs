import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleWorkerText, serializeWorkerOutcome, validateWorkerRequest } from '../../src/composition-worker.mjs';
import { createSource } from './fixture.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const worker = path.join(repository, 'src/composition-worker.mjs');
const compiler = path.join(repository, 'node_modules/typescript/lib/typescript.js');
const requestId = 'a'.repeat(64);
const request = {
  protocolVersion: 1,
  requestId,
  method: 'extract-composition',
  params: {
    compiler: '/private/compiler/typescript.js',
    sources: [{ id: 'a', root: '/private/a' }, { id: 'b', root: '/private/b' }],
  },
};

test('composition worker accepts an exact bounded extraction request', () => {
  assert.deepEqual(validateWorkerRequest(request), { requestId, params: request.params });
});

test('composition worker rejects an unsupported method', () => {
  assert.throws(() => validateWorkerRequest({ ...request, method: 'infer' }), /Unsupported method/);
});

test('composition worker rejects an unsupported protocol version', () => {
  assert.throws(() => validateWorkerRequest({ ...request, protocolVersion: 2 }), /Unsupported protocol version/);
});

test('composition worker rejects unknown request fields', () => {
  assert.throws(() => validateWorkerRequest({ ...request, worker: '/tmp/override' }), /unexpected or missing fields/);
});

test('composition worker rejects unknown params fields', () => {
  assert.throws(() => validateWorkerRequest({ ...request, params: { ...request.params, approved: true } }), /unexpected or missing fields/);
});

test('composition worker rejects fewer than two source bindings', () => {
  assert.throws(() => validateWorkerRequest({ ...request, params: { ...request.params, sources: [request.params.sources[0]] } }), /2 to 8/);
});

test('composition worker rejects more than eight source bindings', () => {
  const sources = Array.from({ length: 9 }, (_, index) => ({ id: `s${index}`, root: `/private/${index}` }));
  assert.throws(() => validateWorkerRequest({ ...request, params: { ...request.params, sources } }), /2 to 8/);
});

test('composition worker rejects duplicate source IDs', () => {
  const sources = [{ id: 'a', root: '/private/a' }, { id: 'a', root: '/private/b' }];
  assert.throws(() => validateWorkerRequest({ ...request, params: { ...request.params, sources } }), /source IDs.*unique/);
});

test('composition worker rejects duplicate source roots', () => {
  const sources = [{ id: 'a', root: '/private/a' }, { id: 'b', root: '/private/a' }];
  assert.throws(() => validateWorkerRequest({ ...request, params: { ...request.params, sources } }), /source roots.*distinct/);
});

test('composition worker preserves correlation on a validated extraction error', async () => {
  const outcome = await handleWorkerText(JSON.stringify(request), {
    env: {}, extract: async () => { throw new Error('sensitive extractor detail'); },
  });
  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.envelope.requestId, requestId);
  assert.equal(outcome.envelope.error.code, 'composition-failed');
  assert.doesNotMatch(outcome.envelope.error.message, /sensitive extractor detail/);
});

test('composition worker rejects NODE_OPTIONS before extraction', async () => {
  let called = false;
  const outcome = await handleWorkerText(JSON.stringify(request), {
    env: { NODE_OPTIONS: '--require=x' }, extract: async () => { called = true; return {}; },
  });
  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.envelope.error.code, 'unsafe-environment');
  assert.equal(called, false);
});

test('composition worker returns observed source facts without approval policy', async () => {
  const observed = { schemaVersion: 1, kind: 'rhubase-composition-extraction', sources: [] };
  const outcome = await handleWorkerText(JSON.stringify(request), { env: {}, extract: async () => observed });
  assert.equal(outcome.exitCode, 0);
  assert.deepEqual(outcome.envelope.result, observed);
  assert.equal(Object.hasOwn(outcome.envelope.result, 'approved'), false);
});

test('composition worker replaces an oversized success with one correlated overflow envelope', () => {
  const outcome = { exitCode: 0, envelope: { protocolVersion: 1, requestId, ok: true, result: { body: 'x'.repeat(100) } } };
  const serialized = serializeWorkerOutcome(outcome, 160);
  assert.equal(serialized.exitCode, 1);
  assert.equal(serialized.envelope.requestId, requestId);
  assert.equal(serialized.envelope.error.code, 'output-too-large');
  assert.equal(serialized.text, `${JSON.stringify(serialized.envelope)}\n`);
});

test('composition worker subprocess rejects malformed UTF-8 with one uncorrelated envelope', () => {
  const result = spawnSync(process.execPath, [worker], {
    input: Buffer.from([0xc3, 0x28]), encoding: 'utf8', env: { PATH: process.env.PATH ?? '' }, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 1);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.requestId, null);
  assert.match(result.stdout, /\n$/);
  assert.doesNotMatch(result.stdout + result.stderr, /TypeError|stack/i);
});

test('composition worker extracts real static facts without executing modules or lifecycle scripts', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhubase-composition-worker-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const a = await createSource(root, 'a');
  const b = await createSource(root, 'b');
  const realRequest = {
    ...request,
    params: { compiler, sources: [{ id: 'a', root: a.root }, { id: 'b', root: b.root }] },
  };
  const outcome = await handleWorkerText(JSON.stringify(realRequest), { env: {} });
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.envelope.result.kind, 'rhubase-composition-extraction');
  assert.deepEqual(outcome.envelope.result.sources.map((source) => source.id), ['a', 'b']);
  assert.ok(outcome.envelope.result.sources.every((source) => source.snapshot.exports.some((item) => item.name === 'Button')));
  assert.ok(outcome.envelope.result.sources.every((source) => source.snapshot.coverage.excludedFiles.some((item) => item.file === 'runtime.js')));
  await assert.rejects(fs.lstat(a.marker), { code: 'ENOENT' });
  await assert.rejects(fs.lstat(b.marker), { code: 'ENOENT' });
});
