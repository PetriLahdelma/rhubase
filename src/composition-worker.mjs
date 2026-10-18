#!/usr/bin/env node
import { TextDecoder } from 'node:util';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extractSnapshot } from './snapshot-api.mjs';

export const PROTOCOL_VERSION = 1;
export const MAX_REQUEST_BYTES = 64 * 1024;
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const REQUEST_ID = /^[a-f0-9]{64}$/;
class ProtocolError extends Error { constructor(code, message) { super(message); this.code = code; } }
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function exact(value, fields, label) {
  if (!plain(value)) throw new ProtocolError('invalid-request', `${label} must be an object`);
  const actual = Object.keys(value).sort(); const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new ProtocolError('invalid-request', `${label} has unexpected or missing fields`);
}
function absolute(value, label) {
  if (typeof value !== 'string' || !value || value.includes('\0') || !path.isAbsolute(value) || path.normalize(value) !== value) throw new ProtocolError('invalid-request', `${label} must be a canonical absolute path`);
  return value;
}
export function validateWorkerRequest(request) {
  exact(request, ['protocolVersion', 'requestId', 'method', 'params'], 'request');
  if (request.protocolVersion !== 1) throw new ProtocolError('unsupported-version', 'Unsupported protocol version');
  if (typeof request.requestId !== 'string' || !REQUEST_ID.test(request.requestId)) throw new ProtocolError('invalid-request', 'Invalid requestId');
  if (request.method !== 'extract-composition') throw new ProtocolError('unsupported-method', 'Unsupported method');
  exact(request.params, ['compiler', 'sources'], 'params');
  const compiler = absolute(request.params.compiler, 'params.compiler');
  if (!Array.isArray(request.params.sources) || request.params.sources.length < 2 || request.params.sources.length > 8) throw new ProtocolError('invalid-request', 'params.sources must contain 2 to 8 bindings');
  const ids = new Set(); const roots = new Set();
  const sources = request.params.sources.map((source, index) => {
    exact(source, ['id', 'root'], `params.sources[${index}]`);
    if (typeof source.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(source.id) || ids.has(source.id)) throw new ProtocolError('invalid-request', 'source IDs must be unique valid identifiers');
    const root = absolute(source.root, `params.sources[${index}].root`);
    if (roots.has(root)) throw new ProtocolError('invalid-request', 'source roots must be distinct');
    ids.add(source.id); roots.add(root); return { id: source.id, root };
  });
  return { requestId: request.requestId, params: { compiler, sources } };
}
async function extract(params) {
  const ts = await import(pathToFileURL(params.compiler).href);
  const api = ts.default ?? ts;
  const sources = [];
  for (const source of params.sources) {
    const extracted = await extractSnapshot(source.root, api);
    const snapshot = {
      identity: { name: extracted.identity.name, version: extracted.identity.version, digest: extracted.identity.digest },
      exports: extracted.exports.map(({ name, entrypoint, kind, incomplete = false, evidence }) => ({ name, entrypoint, kind, incomplete, evidence })),
      tokens: extracted.tokens.map(({ name, value, evidence }) => ({ name, value, evidence })),
      coverage: {
        componentsUnsupported: extracted.coverage.entrypoints.unsupported.length
          + extracted.coverage.exports.unsupported.length
          + extracted.coverage.propSurfaces.unsupported.length,
        tokensUnsupported: extracted.coverage.tokenFiles.unsupported.length + extracted.coverage.tokens.unsupported.length,
        excludedFiles: extracted.coverage.excludedFiles.map(({ file, reason }) => ({ file, reason })),
      },
    };
    sources.push({ id: source.id, snapshot });
  }
  return { schemaVersion: 1, kind: 'rhubase-composition-extraction', sources };
}
const correlated = (value) => plain(value) && typeof value.requestId === 'string' && REQUEST_ID.test(value.requestId) ? value.requestId : null;
const failure = (requestId, error) => ({ protocolVersion: 1, requestId, ok: false, error: { code: error.code ?? 'composition-failed', message: error.message || 'Composition extraction failed' } });
export async function handleWorkerText(text, options = {}) {
  let request;
  try { request = JSON.parse(text); } catch { return { exitCode: 1, envelope: failure(null, new ProtocolError('invalid-json', 'stdin must contain one JSON request')) }; }
  const requestId = correlated(request);
  try {
    const validated = validateWorkerRequest(request);
    const env = options.env ?? process.env;
    if (typeof env.NODE_OPTIONS === 'string' && env.NODE_OPTIONS.length) throw new ProtocolError('unsafe-environment', 'NODE_OPTIONS must be absent');
    const result = await (options.extract ?? extract)(validated.params);
    return { exitCode: 0, envelope: { protocolVersion: 1, requestId: validated.requestId, ok: true, result } };
  } catch (error) { return { exitCode: 1, envelope: failure(requestId, error instanceof ProtocolError ? error : new ProtocolError('composition-failed', 'Composition extraction failed')) }; }
}
export function serializeWorkerOutcome(outcome, maxBytes = MAX_RESPONSE_BYTES) {
  const requestId = correlated(outcome?.envelope); let text;
  try { text = `${JSON.stringify(outcome.envelope)}\n`; } catch { const envelope = failure(requestId, new ProtocolError('serialization-failed', 'Response serialization failed')); return { exitCode: 1, envelope, text: `${JSON.stringify(envelope)}\n` }; }
  if (Buffer.byteLength(text) <= maxBytes) return { ...outcome, text };
  const envelope = failure(requestId, new ProtocolError('output-too-large', `Response exceeds ${maxBytes} bytes`));
  return { exitCode: 1, envelope, text: `${JSON.stringify(envelope)}\n` };
}
async function readStdin() { const chunks = []; let bytes = 0; for await (const chunk of process.stdin) { bytes += chunk.length; if (bytes > MAX_REQUEST_BYTES) throw new ProtocolError('input-too-large', 'Request exceeds 65536 bytes'); chunks.push(chunk); } return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
async function main() {
  let outcome; try { outcome = await handleWorkerText(await readStdin()); } catch (error) { outcome = { exitCode: 1, envelope: failure(null, error) }; }
  const serialized = serializeWorkerOutcome(outcome); process.stdout.write(serialized.text);
  if (!serialized.envelope.ok) process.stderr.write(`ctrl+shift composition worker: ${serialized.envelope.error.code}: ${serialized.envelope.error.message}\n`);
  process.exitCode = serialized.exitCode;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
