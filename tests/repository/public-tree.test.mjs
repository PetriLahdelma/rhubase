import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function git(args) {
  const result = spawnSync('git', args, { cwd: repository, encoding: 'buffer' });
  assert.equal(result.status, 0, Buffer.concat([result.stdout ?? Buffer.alloc(0), result.stderr ?? Buffer.alloc(0)]).toString());
  return result.stdout;
}

function publicCandidates() {
  return git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
    .toString().split('\0').filter(Boolean).sort();
}

test('public candidate excludes local state, build output, raw evidence and generation scratch', () => {
  const prohibited = ['.omx/', '.shift/', 'node_modules/', 'target/', 'output/', 'experiments/results/', 'assets/brand/rhubase-v1.zip'];
  const candidates = publicCandidates();
  for (const prefix of prohibited) {
    assert.equal(candidates.some((file) => file === prefix.slice(0, -1) || file.startsWith(prefix)), false, `public candidate includes ${prefix}`);
  }
});

test('public candidate retains only the selected inference study inputs from validation history', () => {
  const actual = publicCandidates().filter((file) => file.startsWith('validation/'));
  assert.deepEqual(actual, [
    'validation/README.md',
    'validation/inference-blind/corpus.json',
    'validation/inference-blind/expectations.json',
    'validation/inference-followup-v2/corpus.json',
    'validation/inference-followup-v2/expectations.json',
  ]);
});

test('public candidate has no symlinks, oversized files or machine-specific absolute paths', async () => {
  const privatePrefixes = ['/' + 'Users/', '/' + 'home/', 'C:' + '\\' + 'Users' + '\\'];
  for (const relative of publicCandidates()) {
    const file = path.join(repository, relative);
    const stat = await fs.lstat(file);
    assert.equal(stat.isSymbolicLink(), false, `${relative} is a symlink`);
    assert.ok(stat.size <= 1024 * 1024, `${relative} exceeds the 1 MiB public source limit`);
    if (!stat.isFile() || stat.size === 0) continue;
    const bytes = await fs.readFile(file);
    if (bytes.includes(0)) continue;
    const text = bytes.toString('utf8');
    for (const prefix of privatePrefixes) assert.equal(text.includes(prefix), false, `${relative} contains ${prefix}`);
  }
});
