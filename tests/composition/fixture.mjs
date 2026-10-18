import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const sentinelText = 'RHUBASE_COMPOSITION_SCRIPT_MUST_NOT_RUN';

async function write(root, relative, content, mode) {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, mode ? { mode } : undefined);
  return file;
}

export async function createSource(root, id, options = {}) {
  const source = path.join(root, `source-${id}`);
  const marker = path.join(source, 'EXECUTED-SENTINEL');
  await fs.mkdir(source, { recursive: true });
  await write(source, 'package.json', JSON.stringify({
    name: options.packageName ?? `@fixture/${id}`,
    version: options.version ?? '1.0.0',
    types: 'index.d.ts',
    scripts: {
      preinstall: `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, ${JSON.stringify(sentinelText)})"`,
      test: `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, ${JSON.stringify(sentinelText)})"`,
    },
  }, null, 2));
  await write(source, 'index.d.ts', options.types ?? `
export interface ${id.toUpperCase()}ButtonProps { label?: string; }
export declare function Button(props: ${id.toUpperCase()}ButtonProps): unknown;
`);
  await write(source, 'tokens.json', JSON.stringify(options.tokens ?? {
    color: { action: { $type: 'color', $value: options.color ?? '#e31238' } },
    alias: { action: { $type: 'color', $value: '{color.action}' } },
  }, null, 2));
  await write(source, 'runtime.js', `throw new Error(${JSON.stringify(sentinelText)});\n`);
  return { id, root: source, marker };
}

export function selection(id, source, kind, name, extra = {}) {
  return {
    id, source, kind, name,
    targetName: extra.targetName ?? name,
    disposition: extra.disposition ?? 'retain',
    rationale: extra.rationale ?? `Review ${source}/${name} for the shared foundation.`,
  };
}

export function scenario(id, includedSources, selections, extra = {}) {
  return {
    id,
    title: extra.title ?? id.toUpperCase(),
    includedSources,
    target: extra.target ?? { name: '@fixture/foundation', mode: 'new', baseSource: null },
    selections,
    dependencies: extra.dependencies ?? [],
    architecture: extra.architecture ?? {
      layout: 'colocated', topology: 'single-package', delivery: 'minimal', deliverySource: null,
    },
  };
}

export function project(sourceIds, scenarios, extra = {}) {
  return {
    schemaVersion: 1,
    kind: 'rhubase-composition-project',
    title: extra.title ?? 'Shared foundation',
    sources: sourceIds.map((id) => ({ id, digest: null, declaredModes: id === 'b' ? ['light', 'dark'] : [] })),
    scenarios,
  };
}

export async function createCompositionFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhubase-composition-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sources = {
    a: await createSource(root, 'a', { color: '#e31238' }),
    b: await createSource(root, 'b', { color: '#74b61b' }),
    c: await createSource(root, 'c', {
      color: '#111618',
      types: 'export declare function Card(props: { title?: string }): unknown;\nexport declare function Button(props: { pressed?: boolean }): unknown;\n',
    }),
  };
  const projectFile = path.join(root, 'project.json');
  const defaultProject = project(['a', 'b'], [scenario('ab', ['a', 'b'], [
    selection('a-button', 'a', 'component', 'Button'),
    selection('b-dark', 'b', 'mode', 'dark'),
    selection('b-color', 'b', 'token', 'color.action'),
  ])]);
  await fs.writeFile(projectFile, JSON.stringify(defaultProject, null, 2));
  return { root, sources, projectFile, project: defaultProject };
}

export async function treeDigest(root) {
  const entries = [];
  async function visit(directory, prefix = '') {
    for (const name of (await fs.readdir(directory)).sort()) {
      const file = path.join(directory, name);
      const relative = prefix + name;
      const stat = await fs.lstat(file);
      if (stat.isDirectory()) await visit(file, `${relative}/`);
      else if (stat.isSymbolicLink()) entries.push([relative, 'link', await fs.readlink(file)]);
      else entries.push([relative, stat.mode & 0o777, createHash('sha256').update(await fs.readFile(file)).digest('hex')]);
    }
  }
  await visit(root);
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

export async function fileMap(root) {
  const result = {};
  async function visit(directory, prefix = '') {
    for (const name of (await fs.readdir(directory)).sort()) {
      const file = path.join(directory, name);
      const relative = prefix + name;
      const stat = await fs.lstat(file);
      if (stat.isDirectory()) await visit(file, `${relative}/`);
      else result[relative] = await fs.readFile(file);
    }
  }
  await visit(root);
  return result;
}
