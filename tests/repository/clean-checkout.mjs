#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'rhubase clean checkout with spaces-'));
const checkout = path.join(scratch, 'rhubase checkout');
const caller = path.join(scratch, 'unrelated caller');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd ?? checkout,
    env: options.env ?? process.env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: options.timeout ?? 180_000,
  });
  assert.equal(result.status, 0, `${executable} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result;
}

try {
  const listing = command('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: repository });
  const files = listing.stdout.split('\0').filter(Boolean).sort();
  assert.ok(files.length > 0, 'public candidate is empty');
  const before = new Map();
  for (const relative of files) {
    const source = path.join(repository, relative);
    const stat = await fs.lstat(source);
    assert.equal(stat.isFile(), true, `public candidate must contain regular files only: ${relative}`);
    const bytes = await fs.readFile(source); before.set(relative, digest(bytes));
    const target = path.join(checkout, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes, { mode: stat.mode & 0o777 });
  }
  await fs.mkdir(caller);

  command('npm', ['ci', '--ignore-scripts', '--offline'], { timeout: 60_000 });
  command('cargo', ['build', '--release', '--locked', '--offline', '--bin', 'ctrl-shift']);
  const version = command(path.join(checkout, 'bin/rhubase'), ['--version'], { cwd: caller });
  assert.match(version.stdout, /rhubase|ctrl-shift/i);

  for (const [relative, expected] of before) {
    assert.equal(digest(await fs.readFile(path.join(repository, relative))), expected, `source changed: ${relative}`);
  }
  process.stdout.write(`clean checkout verified: ${files.length} files; offline npm install; locked offline Rust build; wrapper version from unrelated cwd\n`);
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
}
