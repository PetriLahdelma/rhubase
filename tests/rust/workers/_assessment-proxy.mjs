import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const productionWorker = path.join(repository, 'src/assessment-worker.mjs');

export async function proxyAssessment(mutate) {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  const request = JSON.parse(text);
  const result = spawnSync(process.execPath, [productionWorker], { input: text, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: process.env });
  if (![0, 1].includes(result.status)) throw new Error('production worker transport failed in fixture');
  const envelope = JSON.parse(result.stdout);
  if (request.method === 'assess' && envelope.ok) mutate(envelope.result.assessment, envelope.result);
  process.stdout.write(JSON.stringify(envelope) + '\n');
}
