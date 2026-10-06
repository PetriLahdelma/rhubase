import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';

export const digest = (value) => createHash('sha256').update(value).digest('hex');
export const jsonDigest = (value) => digest(JSON.stringify(value));

export function demand(condition, message) {
  if (!condition) throw new Error(message);
}

export function relativePath(value) {
  demand(typeof value === 'string' && value.length > 0, 'Expected a relative path');
  demand(!path.isAbsolute(value) && !value.includes('\\') && !/[\x00-\x1f,]/.test(value), `Unsafe path: ${value}`);
  demand(value.split('/').every((part) => part && part !== '.' && part !== '..'), `Unsafe path: ${value}`);
  return value;
}

export async function readJson(file, maxBytes = 2_000_000) {
  const stat = await fs.lstat(file);
  demand(stat.isFile() && !stat.isSymbolicLink() && stat.size <= maxBytes, `Unsafe or oversized JSON: ${file}`);
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

// Reject links in every declared path segment. Configs are operator-selected inputs,
// never executed as JavaScript. Arbitrary consumer code is never imported here.
export async function safePath(root, rel) {
  relativePath(rel);
  let current = root;
  for (const part of rel.split('/')) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    demand(!stat.isSymbolicLink(), `Symlink not supported: ${current}`);
  }
  return current;
}

export async function snapshot(root) {
  demand((await fs.lstat(root)).isDirectory(), `Expected directory: ${root}`);
  const files = {};
  let total = 0;
  async function walk(dir, prefix = '') {
    for (const name of (await fs.readdir(dir)).sort()) {
      demand(!['.git', 'node_modules', '.shift'].includes(name) && !name.startsWith('.env'), `Unsupported input directory or secret file: ${name}`);
      const rel = relativePath(prefix + name);
      const file = path.join(dir, name);
      const stat = await fs.lstat(file);
      demand(!stat.isSymbolicLink(), `Symlink not supported: ${rel}`);
      if (stat.isDirectory()) await walk(file, rel + '/');
      else {
        demand(stat.isFile() && stat.size <= 1_000_000, `Unsupported or oversized file: ${rel}`);
        const content = await fs.readFile(file);
        total += content.length;
        demand(total <= 10_000_000 && Object.keys(files).length < 1000, 'Prototype snapshot budget exceeded');
        files[rel] = { sha256: digest(content), bytes: content.length };
      }
    }
  }
  await walk(root);
  return { digest: jsonDigest(files), files };
}

export async function writeJson(file, value) {
  await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}

export async function createOutput(dir, protectedRoots = []) {
  const absolute = path.resolve(dir);
  const parent = await fs.realpath(path.dirname(absolute));
  const resolved = path.join(parent, path.basename(absolute));
  for (const root of protectedRoots) {
    const base = await fs.realpath(root);
    demand(resolved !== base && !resolved.startsWith(base + path.sep), 'Output must be outside input roots');
  }
  await fs.mkdir(resolved, { mode: 0o700 }); // Exclusive creation; never overwrite a run.
  return resolved;
}

export async function copySnapshot(root, output, expected) {
  demand((await snapshot(root)).digest === expected.digest, 'Input changed since planning');
  for (const [rel, identity] of Object.entries(expected.files)) {
    const source = await safePath(root, rel);
    const content = await fs.readFile(source);
    demand(digest(content) === identity.sha256, `Input changed while copying: ${rel}`);
    const destination = path.join(output, rel);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, content, { flag: 'wx', mode: 0o644 });
  }
}
