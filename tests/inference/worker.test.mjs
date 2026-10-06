import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  handleWorkerText, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, PROTOCOL_VERSION,
  serializeWorkerOutcome, validateWorkerRequest, workerDiagnostic,
} from '../../src/inference-worker.mjs';

const compiler = process.env.SHIFT_TYPESCRIPT_PATH ?? path.resolve(import.meta.dirname, '../../node_modules/typescript/lib/typescript.js');
const requestId = 'a'.repeat(64);

async function fixture(version, declaration) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shift-worker-'));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: '@demo/worker', version, types: 'index.d.ts' }));
  await fs.writeFile(path.join(root, 'index.d.ts'), declaration);
  return root;
}

function request(from, to, overrides = {}) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    method: 'infer',
    params: { from, to, compiler },
    ...overrides,
  };
}

function runWorker(input, environment = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, ...environment }; if (!Object.hasOwn(environment, 'NODE_OPTIONS')) delete env.NODE_OPTIONS;
    const child = spawn(process.execPath, ['src/inference-worker.mjs'], { cwd: path.resolve(import.meta.dirname, '../..'), env });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') throw error; });
    child.on('close', (code) => resolve({ code, stdout, stderr, envelope: JSON.parse(stdout) }));
    child.stdin.end(input);
  });
}

test('handler preserves the existing inference result as the only success payload', async () => {
  const params = { from: '/old', to: '/new', compiler: '/typescript.js' };
  const contract = { schemaVersion: 1, kind: 'migration-contract', status: 'draft', executable: false };
  let received;
  const outcome = await handleWorkerText(JSON.stringify(request(params.from, params.to, { params })), {
    env: {}, infer: async (value) => { received = value; return contract; },
  });
  assert.equal(outcome.exitCode, 0);
  assert.deepEqual(received, params);
  assert.deepEqual(outcome.envelope, { protocolVersion: 1, requestId, ok: true, result: contract });
  assert.deepEqual(Object.keys(outcome.envelope).sort(), ['ok', 'protocolVersion', 'requestId', 'result']);
});

test('subprocess emits exactly one correlated envelope and no diagnostic on success', async (t) => {
  const from = await fixture('1.0.0', 'export declare const Old: string;');
  const to = await fixture('2.0.0', 'export declare const New: string;');
  t.after(() => Promise.all([fs.rm(from, { recursive: true, force: true }), fs.rm(to, { recursive: true, force: true })]));
  const result = await runWorker(JSON.stringify(request(from, to)));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, `${JSON.stringify(result.envelope)}\n`);
  assert.deepEqual(Object.keys(result.envelope).sort(), ['ok', 'protocolVersion', 'requestId', 'result']);
  assert.equal(result.envelope.requestId, requestId);
  assert.equal(result.envelope.result.kind, 'migration-contract');
  assert.equal(result.envelope.result.status, 'draft');
  assert.equal(result.envelope.result.executable, false);
});

test('strict request validation rejects unknown fields, bad versions, methods, IDs and paths', async () => {
  const base = request('/old', '/new');
  const cases = [
    [{ ...base, extra: true }, 'invalid-request', requestId],
    [{ ...base, params: { ...base.params, extra: true } }, 'invalid-request', requestId],
    [{ ...base, protocolVersion: 2 }, 'unsupported-version', requestId],
    [{ ...base, method: 'migrate' }, 'unsupported-method', requestId],
    [{ ...base, requestId: 'ABC' }, 'invalid-request', null],
    [{ ...base, params: { ...base.params, from: 'relative' } }, 'invalid-request', requestId],
    [{ ...base, params: { ...base.params, from: '/same', to: '/same' } }, 'invalid-request', requestId],
  ];
  for (const [value, code, correlation] of cases) {
    const outcome = await handleWorkerText(JSON.stringify(value), { env: {}, infer: async () => assert.fail('inference must not run') });
    assert.equal(outcome.exitCode, 1);
    assert.equal(outcome.envelope.ok, false);
    assert.equal(outcome.envelope.error.code, code);
    assert.equal(outcome.envelope.requestId, correlation);
    assert.deepEqual(Object.keys(outcome.envelope).sort(), ['error', 'ok', 'protocolVersion', 'requestId']);
  }
  assert.throws(() => validateWorkerRequest({}), /unexpected or missing fields/);
});

test('malformed and trailing JSON return one uncorrelated structured error', async () => {
  for (const input of ['{', `${JSON.stringify(request('/old', '/new'))}{}`]) {
    const result = await runWorker(input);
    assert.equal(result.code, 1);
    assert.equal(result.envelope.requestId, null);
    assert.equal(result.envelope.error.code, 'invalid-json');
    assert.equal(result.stdout, `${JSON.stringify(result.envelope)}\n`);
    assert.match(result.stderr, /^shift inference worker: invalid-json:/);
  }
});

test('request byte limit fails before parsing and emits no progress output', async () => {
  const result = await runWorker('x'.repeat(MAX_REQUEST_BYTES + 1));
  assert.equal(result.code, 1);
  assert.deepEqual(result.envelope, {
    protocolVersion: 1, requestId: null, ok: false,
    error: { code: 'input-too-large', message: `Request exceeds ${MAX_REQUEST_BYTES} bytes` },
  });
  assert.equal(result.stdout, `${JSON.stringify(result.envelope)}\n`);
});

test('worker refuses inherited NODE_OPTIONS and does not claim to sanitize startup', async () => {
  const result = await runWorker(JSON.stringify(request('/old', '/new')), { NODE_OPTIONS: '--no-warnings' });
  assert.equal(result.code, 1);
  assert.equal(result.envelope.requestId, requestId);
  assert.equal(result.envelope.error.code, 'unsafe-environment');
});

test('inference failures remain correlated and omit stacks', async () => {
  const oldSecret = '/definitely/private-customer/missing-old'; const newSecret = '/definitely/private-customer/missing-new';
  const result = await runWorker(JSON.stringify(request(oldSecret, newSecret)));
  assert.equal(result.code, 1);
  assert.equal(result.envelope.requestId, requestId);
  assert.equal(result.envelope.error.code, 'inference-failed');
  assert.equal(Object.hasOwn(result.envelope.error, 'stack'), false);
  assert.doesNotMatch(result.stdout + result.stderr, /\n\s+at\s/);
  assert.equal((result.stdout + result.stderr).includes(oldSecret), false);
  assert.equal((result.stdout + result.stderr).includes(newSecret), false);
  assert.equal((result.stdout + result.stderr).includes('private-customer'), false);
});

test('internal inference errors are redacted from both response and diagnostic', async () => {
  const secret = '/customer/private/source.ts: API_TOKEN=hidden';
  const outcome = await handleWorkerText(JSON.stringify(request('/old', '/new')), {
    env: {}, infer: async () => { throw new Error(secret); },
  });
  const serialized = serializeWorkerOutcome(outcome);
  const diagnostic = workerDiagnostic(serialized.envelope);
  assert.equal(serialized.envelope.error.code, 'inference-failed');
  assert.equal(serialized.envelope.error.message, 'Inference failed');
  assert.equal((serialized.text + diagnostic).includes(secret), false);
  assert.doesNotMatch(serialized.text + diagnostic, /source\.ts|API_TOKEN/);
});

test('response framing includes the newline in its bound and emits one correlated overflow envelope', () => {
  const value = { protocolVersion: 1, requestId, ok: true, result: { payload: '' } };
  const baseline = Buffer.byteLength(`${JSON.stringify(value)}\n`);
  value.result.payload = 'x'.repeat(64);
  const exact = serializeWorkerOutcome({ exitCode: 0, envelope: value }, baseline + 64);
  assert.equal(exact.exitCode, 0);
  assert.equal(Buffer.byteLength(exact.text), baseline + 64);
  assert.equal(exact.text.split('\n').length, 2);
  const overflow = serializeWorkerOutcome({ exitCode: 0, envelope: value }, baseline + 63);
  assert.equal(overflow.exitCode, 1);
  assert.equal(overflow.envelope.requestId, requestId);
  assert.equal(overflow.envelope.error.code, 'output-too-large');
  assert.equal(overflow.text, `${JSON.stringify(overflow.envelope)}\n`);
  assert.equal(overflow.text.split('\n').length, 2);
  assert.equal(MAX_RESPONSE_BYTES, 32 * 1024 * 1024);
});

test('serialization faults produce one fixed correlated envelope without object contents', () => {
  const result = { secret: '/private/customer.ts' }; result.circular = result;
  const serialized = serializeWorkerOutcome({ exitCode: 0, envelope: { protocolVersion: 1, requestId, ok: true, result } });
  assert.equal(serialized.exitCode, 1);
  assert.equal(serialized.envelope.requestId, requestId);
  assert.deepEqual(serialized.envelope.error, { code: 'serialization-failed', message: 'Response serialization failed' });
  assert.equal(serialized.text, `${JSON.stringify(serialized.envelope)}\n`);
  assert.equal(serialized.text.includes('customer.ts'), false);
});
