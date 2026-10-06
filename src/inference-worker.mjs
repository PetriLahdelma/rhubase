#!/usr/bin/env node
import { TextDecoder } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inferContract } from './inference.mjs';

export const PROTOCOL_VERSION = 1;
export const MAX_REQUEST_BYTES = 64 * 1024;
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const REQUEST_ID = /^[a-f0-9]{64}$/;

class ProtocolError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected, label) {
  if (!plainObject(value)) throw new ProtocolError('invalid-request', `${label} must be an object`);
  const actual = Object.keys(value).sort(); const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new ProtocolError('invalid-request', `${label} has unexpected or missing fields`);
  }
}

function canonicalAbsolute(value, label) {
  if (typeof value !== 'string' || !value || value.includes('\0') || !path.isAbsolute(value) || path.normalize(value) !== value) {
    throw new ProtocolError('invalid-request', `${label} must be a canonical absolute path`);
  }
  return value;
}

export function validateWorkerRequest(request) {
  exactKeys(request, ['protocolVersion', 'requestId', 'method', 'params'], 'request');
  if (!Number.isInteger(request.protocolVersion) || request.protocolVersion !== PROTOCOL_VERSION) {
    throw new ProtocolError('unsupported-version', 'Unsupported protocol version');
  }
  if (typeof request.requestId !== 'string' || !REQUEST_ID.test(request.requestId)) {
    throw new ProtocolError('invalid-request', 'requestId must be 64 lowercase hexadecimal characters');
  }
  if (request.method !== 'infer') throw new ProtocolError('unsupported-method', 'Unsupported method');
  exactKeys(request.params, ['from', 'to', 'compiler'], 'params');
  const params = {
    from: canonicalAbsolute(request.params.from, 'params.from'),
    to: canonicalAbsolute(request.params.to, 'params.to'),
    compiler: canonicalAbsolute(request.params.compiler, 'params.compiler'),
  };
  if (params.from === params.to) throw new ProtocolError('invalid-request', 'params.from and params.to must differ');
  return { protocolVersion: PROTOCOL_VERSION, requestId: request.requestId, method: 'infer', params };
}

function correlatedId(value) {
  return plainObject(value) && typeof value.requestId === 'string' && REQUEST_ID.test(value.requestId) ? value.requestId : null;
}

function failure(requestId, error) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    ok: false,
    error: { code: error.code ?? 'inference-failed', message: error.message || 'Inference failed' },
  };
}

export async function handleWorkerText(text, { env = process.env, infer = inferContract } = {}) {
  let request;
  try { request = JSON.parse(text); }
  catch { return { exitCode: 1, envelope: failure(null, new ProtocolError('invalid-json', 'stdin must contain exactly one UTF-8 JSON request')) }; }
  const requestId = correlatedId(request);
  try {
    const validated = validateWorkerRequest(request);
    if (typeof env.NODE_OPTIONS === 'string' && env.NODE_OPTIONS.length > 0) {
      throw new ProtocolError('unsafe-environment', 'NODE_OPTIONS must be absent when the worker is started');
    }
    const result = await infer(validated.params);
    return { exitCode: 0, envelope: { protocolVersion: PROTOCOL_VERSION, requestId: validated.requestId, ok: true, result } };
  } catch (error) {
    const protocolError = error instanceof ProtocolError ? error : new ProtocolError('inference-failed', 'Inference failed');
    return { exitCode: 1, envelope: failure(requestId, protocolError) };
  }
}

export function serializeWorkerOutcome(outcome, maxBytes = MAX_RESPONSE_BYTES) {
  let requestId = null;
  try { requestId = correlatedId(outcome?.envelope); } catch { /* fixed uncorrelated fallback below */ }
  try {
    const json = JSON.stringify(outcome.envelope);
    if (typeof json !== 'string') throw new TypeError('Envelope is not serializable');
    const text = `${json}\n`;
    if (Buffer.byteLength(text) <= maxBytes) return { ...outcome, text };
    const envelope = failure(requestId, new ProtocolError('output-too-large', `Response exceeds ${maxBytes} bytes`));
    return { exitCode: 1, envelope, text: `${JSON.stringify(envelope)}\n` };
  } catch {
    const envelope = failure(requestId, new ProtocolError('serialization-failed', 'Response serialization failed'));
    return { exitCode: 1, envelope, text: `${JSON.stringify(envelope)}\n` };
  }
}

export function workerDiagnostic(envelope) {
  if (envelope?.ok !== false) return '';
  const diagnostic = `${envelope.error.code}: ${envelope.error.message}`.replace(/[\r\n]+/g, ' ').slice(0, 1000);
  return `shift inference worker: ${diagnostic}\n`;
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
  try { outcome = await handleWorkerText(await readBoundedStdin()); }
  catch (error) {
    const protocolError = error instanceof ProtocolError ? error : new ProtocolError('invalid-request', 'Failed to read request');
    outcome = { exitCode: 1, envelope: failure(null, protocolError) };
  }
  const serialized = serializeWorkerOutcome(outcome);
  process.stdout.write(serialized.text);
  const diagnostic = workerDiagnostic(serialized.envelope); if (diagnostic) process.stderr.write(diagnostic);
  process.exitCode = serialized.exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
