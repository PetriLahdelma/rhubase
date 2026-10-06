import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { digest, demand, jsonDigest, relativePath } from './files.mjs';

const ignoredDirectories = new Set(['.git', 'node_modules', '.shift', '.claude', '.codex', '.omx', '.next', 'dist', 'build', 'coverage']);
const sensitive = (name) => /^\.env(?:\.|$)/.test(name) || ['.npmrc', '.netrc', '.aws', '.ssh', 'id_rsa', 'id_ed25519'].includes(name) || /\.(?:pem|key|p12|pfx)$/i.test(name);

export async function treeSnapshot(root, { excludeGenerated = true, rejectGit = false } = {}) {
  root = path.resolve(root);
  const rootStat = await fs.lstat(root);
  demand(rootStat.isDirectory() && !rootStat.isSymbolicLink(), `Expected real directory: ${root}`);
  const files = Object.create(null); const excluded = []; let bytes = 0;
  async function visit(dir, prefix = '') {
    for (const name of (await fs.readdir(dir)).sort()) {
      const rel = relativePath(prefix + name);
      const item = path.join(dir, name);
      const stat = await fs.lstat(item);
      demand(!(rejectGit && name === '.git'), `Unexpected Git metadata in agent workspace: ${rel}`);
      if (name === '.git' || (excludeGenerated && (ignoredDirectories.has(name) || sensitive(name)))) {
        excluded.push(rel); continue;
      }
      demand(!stat.isSymbolicLink(), `Symlink is outside the supported source boundary: ${rel}`);
      if (stat.isDirectory()) await visit(item, rel + '/');
      else {
        demand(stat.isFile() && stat.size <= 5_000_000, `Unsupported or oversized file: ${rel}`);
        bytes += stat.size;
        demand(bytes <= 100_000_000 && Object.keys(files).length < 10000, 'Source scope exceeds the 10,000-file/100 MB run budget');
        const content = await fs.readFile(item);
        files[rel] = { sha256: digest(content), bytes: content.length, mode: stat.mode & 0o111 ? 0o755 : 0o644 };
      }
    }
  }
  await visit(root);
  return { digest: jsonDigest(files), files, excluded };
}

export async function copyTree(root, destination, snapshot) {
  await fs.mkdir(destination, { recursive: true });
  for (const [rel, info] of Object.entries(snapshot.files)) {
    const source = path.join(root, rel);
    demand(!(await fs.lstat(source)).isSymbolicLink(), `Source became a symlink: ${rel}`);
    const content = await fs.readFile(source);
    demand(digest(content) === info.sha256, `Source changed during snapshot: ${rel}`);
    const target = path.join(destination, rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, { flag: 'wx', mode: info.mode ?? 0o644 });
    await fs.chmod(target, info.mode ?? 0o644);
  }
}

export async function resolveOutputRoot(output, protectedRoots) {
  output = path.resolve(output);
  let existing = output; const missing = [];
  for (;;) {
    try { await fs.lstat(existing); break; }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      missing.unshift(path.basename(existing)); existing = path.dirname(existing);
    }
  }
  const canonical = path.join(await fs.realpath(existing), ...missing);
  demand((await fs.stat(existing)).isDirectory(), 'Output ancestor is not a directory');
  for (const root of protectedRoots) {
    const source = await fs.realpath(root);
    demand(canonical !== source && !canonical.startsWith(source + path.sep), 'Output must be outside source and reference roots');
  }
  return canonical;
}

export async function ensureOutputRoot(output, protectedRoots) {
  const canonical = await resolveOutputRoot(output, protectedRoots);
  await fs.mkdir(canonical, { recursive: true, mode: 0o700 });
  return canonical;
}

export async function readSources(root, snapshot) {
  const contents = new Map();
  for (const [rel, info] of Object.entries(snapshot.files)) {
    if (!/\.[cm]?[jt]sx?$/.test(rel) || rel.endsWith('.d.ts')) continue;
    const text = await fs.readFile(path.join(root, rel), 'utf8');
    demand(digest(text) === info.sha256, `Source changed while reading: ${rel}`);
    contents.set(rel, text);
  }
  return contents;
}

export async function artifactSnapshot(root) {
  // Evidence contains multiple source copies, bundles, logs and full-file patches.
  // Do not apply single-input admission limits a second time to the aggregate.
  const files = Object.create(null);
  async function visit(directory, prefix = '') {
    for (const name of (await fs.readdir(directory)).sort()) {
      if (name === '.git' || (!prefix && name === 'manifest.json')) continue;
      const rel = relativePath(prefix + name); const file = path.join(directory, name);
      const stat = await fs.lstat(file);
      demand(!stat.isSymbolicLink(), `Unexpected symlink in run evidence: ${rel}`);
      if (stat.isDirectory()) await visit(file, rel + '/');
      else {
        demand(stat.isFile(), `Unexpected special file in run evidence: ${rel}`);
        const hash = createHash('sha256'); let bytes = 0;
        for await (const chunk of createReadStream(file)) { hash.update(chunk); bytes += chunk.length; }
        demand(bytes === stat.size, `Evidence changed while hashing: ${rel}`);
        files[rel] = { sha256: hash.digest('hex'), bytes, mode: stat.mode & 0o111 ? 0o755 : 0o644 };
      }
    }
  }
  await visit(root);
  return { digest: jsonDigest(files), files };
}

export async function fileDigest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
