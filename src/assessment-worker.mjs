#!/usr/bin/env node
import { TextDecoder } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessConsumer, resolveAssessment } from './consumer-assessment.mjs';
import { MAX_REQUEST_BYTES, PROTOCOL_VERSION, serializeWorkerOutcome, workerDiagnostic } from './inference-worker.mjs';

const REQUEST_ID = /^[a-f0-9]{64}$/;
const SHA256 = /^[a-f0-9]{64}$/;

class ProtocolError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function plainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exactKeys(value, expected, label) {
  if (!plainObject(value)) throw new ProtocolError('invalid-request', `${label} must be an object`);
  const actual = Object.keys(value).sort(); const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new ProtocolError('invalid-request', `${label} has unexpected or missing fields`);
}
function canonicalAbsolute(value, label) {
  if (typeof value !== 'string' || !value || value.includes('\0') || !path.isAbsolute(value) || path.normalize(value) !== value) throw new ProtocolError('invalid-request', `${label} must be a canonical absolute path`);
  return value;
}
function selectors(value, label) {
  if (!Array.isArray(value) || value.length < 1 || value.some((item) => typeof item !== 'string' || !item || item.includes('\0')) || new Set(value).size !== value.length) {
    throw new ProtocolError('invalid-request', `${label} must contain unique nonempty selectors`);
  }
  return [...value];
}
function selector(value, label) {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new ProtocolError('invalid-request', `${label} must be a nonempty selector`);
  return value;
}

export function validateAssessmentWorkerRequest(request) {
  exactKeys(request, ['protocolVersion', 'requestId', 'method', 'params'], 'request');
  if (request.protocolVersion !== PROTOCOL_VERSION) throw new ProtocolError('unsupported-version', 'Unsupported protocol version');
  if (typeof request.requestId !== 'string' || !REQUEST_ID.test(request.requestId)) throw new ProtocolError('invalid-request', 'requestId must be 64 lowercase hexadecimal characters');
  if (!['resolve-assessment', 'assess'].includes(request.method)) throw new ProtocolError('unsupported-method', 'Unsupported method');
  if (request.method === 'resolve-assessment') {
    exactKeys(request.params, ['repo', 'sources', 'target'], 'params');
    return { protocolVersion: PROTOCOL_VERSION, requestId: request.requestId, method: request.method, params: {
      repo: canonicalAbsolute(request.params.repo, 'params.repo'), sources: selectors(request.params.sources, 'params.sources'), target: selector(request.params.target, 'params.target'),
    } };
  }
  exactKeys(request.params, ['repo', 'sources', 'target', 'compiler', 'expectedResolutionDigest'], 'params');
  if (typeof request.params.expectedResolutionDigest !== 'string' || !SHA256.test(request.params.expectedResolutionDigest)) throw new ProtocolError('invalid-request', 'params.expectedResolutionDigest must be lowercase SHA-256');
  return { protocolVersion: PROTOCOL_VERSION, requestId: request.requestId, method: request.method, params: {
    repo: canonicalAbsolute(request.params.repo, 'params.repo'), sources: selectors(request.params.sources, 'params.sources'), target: selector(request.params.target, 'params.target'),
    compiler: canonicalAbsolute(request.params.compiler, 'params.compiler'), expectedResolutionDigest: request.params.expectedResolutionDigest,
  } };
}

function correlatedId(value) { return plainObject(value) && typeof value.requestId === 'string' && REQUEST_ID.test(value.requestId) ? value.requestId : null; }
function failure(requestId, code, message) { return { protocolVersion: PROTOCOL_VERSION, requestId, ok: false, error: { code, message } }; }

export async function handleAssessmentWorkerText(text, { env = process.env, resolve = resolveAssessment, assess = assessConsumer } = {}) {
  let request;
  try { request = JSON.parse(text); }
  catch { return { exitCode: 1, envelope: failure(null, 'invalid-json', 'stdin must contain exactly one UTF-8 JSON request') }; }
  const requestId = correlatedId(request);
  try {
    const validated = validateAssessmentWorkerRequest(request);
    if (typeof env.NODE_OPTIONS === 'string' && env.NODE_OPTIONS.length > 0) throw new ProtocolError('unsafe-environment', 'NODE_OPTIONS must be absent when the worker is started');
    const result = validated.method === 'resolve-assessment' ? await resolve(validated.params) : await assess(validated.params);
    return { exitCode: 0, envelope: { protocolVersion: PROTOCOL_VERSION, requestId: validated.requestId, ok: true, result } };
  } catch (error) {
    if (error instanceof ProtocolError) return { exitCode: 1, envelope: failure(requestId, error.code, error.message) };
    const resolving = request?.method === 'resolve-assessment';
    const code = resolving ? 'resolution-failed' : 'assessment-failed';
    return { exitCode: 1, envelope: failure(requestId, code, resolving ? 'Assessment resolution failed' : 'Assessment failed') };
  }
}

async function readBoundedStdin(input = process.stdin) {
  const chunks = []; let bytes = 0;
  for await (const chunk of input) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) throw new ProtocolError('input-too-large', `Request exceeds ${MAX_REQUEST_BYTES} bytes`);
    chunks.push(chunk);
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { throw new ProtocolError('invalid-json', 'stdin must be valid UTF-8 JSON'); }
}

async function main() {
  let outcome;
  try { outcome = await handleAssessmentWorkerText(await readBoundedStdin()); }
  catch (error) {
    const protocolError = error instanceof ProtocolError ? error : new ProtocolError('invalid-request', 'Failed to read request');
    outcome = { exitCode: 1, envelope: failure(null, protocolError.code, protocolError.message) };
  }
  const serialized = serializeWorkerOutcome(outcome);
  process.stdout.write(serialized.text);
  const diagnostic = workerDiagnostic(serialized.envelope); if (diagnostic) process.stderr.write(diagnostic.replace('shift inference worker:', 'ctrl+shift assessment worker:'));
  process.exitCode = serialized.exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
