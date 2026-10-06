#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') {
  process.stderr.write('RhuBase CLI release integration is currently verified on macOS only.\n');
  process.exit(1);
}

const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compiler = path.join(checkout, 'node_modules', 'typescript', 'lib', 'typescript.js');
try {
  await fs.access(compiler);
} catch {
  process.stderr.write('Pinned TypeScript is missing. Run `npm ci --ignore-scripts` first.\n');
  process.exit(1);
}
const env = {
  ...process.env,
  SHIFT_TYPESCRIPT_PATH: compiler,
  SHIFT_RUST_PROFILE: 'release',
};

function run(command, args) {
  process.stdout.write(`\n> ${command} ${args.join(' ')}\n`);
  const result = spawnSync(command, args, {
    cwd: checkout,
    env,
    shell: false,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run('cargo', ['build', '--release', '--locked', '--bin', 'ctrl-shift']);
const files = (await fs.readdir(path.join(checkout, 'tests', 'rust')))
  .filter((file) => file.endsWith('.test.mjs'))
  .sort();
for (const file of files) run(process.execPath, ['--test', path.join('tests', 'rust', file)]);
process.stdout.write(`\nRhuBase release CLI tests passed (${files.length} files, sequential).\n`);
