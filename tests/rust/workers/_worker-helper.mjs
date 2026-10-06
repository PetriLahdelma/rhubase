import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export async function readRequest() {
  let text = '';
  for await (const chunk of process.stdin) {
    text += chunk;
    if (Buffer.byteLength(text) > 65536) throw new Error('test worker request exceeded protocol cap');
  }
  return JSON.parse(text);
}

export async function validEnvelope(request) {
  const { inferContract } = await import(pathToFileURL(path.join(repository, 'src/inference.mjs')));
  const result = await inferContract(request.params);
  return { protocolVersion: 1, requestId: request.requestId, ok: true, result };
}

export function writeJson(value) {
  process.stdout.write(JSON.stringify(value) + '\n');
}

export async function firstEvidence(result) {
  const item = [...result.changes, ...result.proposals, ...result.unresolved].find((entry) => entry.evidence?.length);
  if (!item) throw new Error('fixture contract has no evidence');
  return item.evidence[0];
}

export async function recordRequest(request) {
  const parent = path.dirname(await fs.realpath(request.params.from));
  await fs.writeFile(path.join(parent, 'recorded-request.json'), JSON.stringify(request, null, 2) + '\n', { flag: 'wx' });
  await fs.writeFile(path.join(parent, 'recorded-worker-env.json'), JSON.stringify(process.env, null, 2) + '\n', { flag: 'wx' });
}
