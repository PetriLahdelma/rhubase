import * as fs from 'node:fs/promises';
import path from 'node:path';
import { readRequest, validEnvelope, writeJson } from './_worker-helper.mjs';
const request = await readRequest();
const parent = path.dirname(await fs.realpath(request.params.from));
const marker = path.join(parent, 'drift-ready.json'); const release = path.join(parent, 'drift-release');
await fs.writeFile(marker, JSON.stringify({ worker: process.pid }) + '\n', { flag: 'wx' });
while (true) {
  try { await fs.access(release); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await new Promise((resolve) => setTimeout(resolve, 10));
}
writeJson(await validEnvelope(request));
