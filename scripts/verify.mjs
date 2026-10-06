#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compiler = path.join(checkout, 'node_modules', 'typescript', 'lib', 'typescript.js');
const nodeOnly = process.argv.slice(2).includes('--node-only');

try {
  await fs.access(compiler);
} catch {
  process.stderr.write('Pinned TypeScript is missing. Run `npm ci --ignore-scripts` first.\n');
  process.exit(1);
}

function run(command, args, env = process.env) {
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

async function testsUnder(relative) {
  const directory = path.join(checkout, relative);
  try {
    return (await fs.readdir(directory, { recursive: true }))
      .filter((file) => file.endsWith('.test.mjs'))
      .map((file) => path.join(relative, file))
      .sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

const nodeTests = (
  await Promise.all([
    'tests/inference',
    'tests/assessment',
    'tests/recipes',
    'tests/repository',
  ].map(testsUnder))
).flat();
nodeTests.push('tests/source/analysis.test.mjs');
nodeTests.sort();
if (nodeTests.length === 0) throw new Error('No supported Node tests were found.');
const env = { ...process.env, SHIFT_TYPESCRIPT_PATH: process.env.SHIFT_TYPESCRIPT_PATH || compiler };

run(process.execPath, ['scripts/check.mjs'], env);
run(process.execPath, ['--test', ...nodeTests], env);
if (!nodeOnly) {
  run('cargo', ['fmt', '--all', '--', '--check'], env);
  run('cargo', ['clippy', '--locked', '--offline', '--workspace', '--all-targets', '--', '-D', 'warnings'], env);
  run('cargo', ['test', '--locked', '--offline', '--workspace', '--all-targets'], env);
}

process.stdout.write(`\nRhuBase verification passed (${nodeTests.length} Node test files${nodeOnly ? '' : ' plus Rust checks'}).\n`);
