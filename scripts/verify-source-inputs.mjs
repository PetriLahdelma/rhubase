import * as fs from 'node:fs/promises';
import path from 'node:path';
import { digest, demand, readJson, safePath } from '../src/files.mjs';

const root = path.resolve('experiments/superset-dropdown');
const manifest = await readJson(path.join(root, 'manifest.json'));
for (const item of manifest.files) {
  const content = await fs.readFile(await safePath(root, item.local));
  demand(content.length === item.bytes && digest(content) === item.sha256, `Pinned source mismatch: ${item.local}`);
}
console.log(`Verified ${manifest.files.length} pinned public source/license files. No source executed or fetched.`);
