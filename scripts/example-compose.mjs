#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const example = path.join(checkout, 'examples', 'composition');
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'rhubase-compose-example-'));
const output = path.join(scratch, 'plan');
const command = [
  'compose', '--project', path.join(example, 'project.json'),
  '--source', `a=${path.join(example, 'a')}`,
  '--source', `b=${path.join(example, 'b')}`,
  '--source', `c=${path.join(example, 'c')}`,
  '--out', output,
];

const result = spawnSync(path.join(checkout, 'bin', 'rhubase'), command, {
  cwd: checkout, env: process.env, shell: false, stdio: 'inherit',
});
if (result.error || result.status !== 0) {
  await fs.rm(scratch, { recursive: true, force: true });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
process.stdout.write(`\nWorkspace: ${path.join(output, 'workspace.html')}\nReview: ${path.join(output, 'review.md')}\nBlueprint: ${path.join(output, 'blueprint.json')}\nPinned project: ${path.join(output, 'project.json')}\nScratch workspace: ${scratch}\n`);
