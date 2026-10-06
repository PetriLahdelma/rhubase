import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadCompiler } from '../../src/source-analysis.mjs';
import { extractSnapshot } from '../../src/snapshot-api.mjs';
import { digest } from '../../src/files.mjs';

const { ts } = await loadCompiler(process.env.SHIFT_TYPESCRIPT_PATH);
async function fixture(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shift-extraction-'));
  for (const [file, text] of Object.entries(files)) {
    const target = path.join(root, file); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, text);
  }
  return root;
}
const packageJson = (extra = {}) => JSON.stringify({ name: '@demo/system', version: '2.0.0', ...extra }, null, 2);

test('extracts local re-exports, aliases, inherited props, canonical types, defaults and JSDoc', async (t) => {
  const root = await fixture({
    'package.json': packageJson({ exports: { '.': { types: './types/index.d.ts' }, './extra': { types: './types/extra.d.ts' } } }),
    'types/index.d.ts': `export { Button as PrimaryButton } from './button';\nexport type { ButtonProps } from './button';\n`,
    'types/button.d.ts': `
      interface BaseProps { /** identifier */ id: string; }
      type Intent = 'quiet' | ('strong' | 'quiet');
      export interface ButtonProps extends BaseProps {
        /** Button intent. @defaultValue "quiet" */
        intent?: undefined | Intent;
        callback: (value: string) => void;
        requiredMaybe: string | undefined;
        options?: { z: number; a: string };
      }
      /** Primary action. @deprecated Use Action. */
      export declare function Button({ intent = 'quiet' }: ButtonProps): unknown;
    `,
    'types/extra.d.ts': `export declare const Badge: (props: { tone?: 'info' | 'warning' }) => unknown;`,
    'README.md': '# Demo\nUse `PrimaryButton`.',
    'docs/MIGRATION.md': 'PrimaryButton replaces LegacyButton.',
    'notes.md': 'not selected',
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const snapshot = await extractSnapshot(root, ts);
  assert.deepEqual(snapshot.identity.entrypoints, [{ name: '.', file: 'types/index.d.ts' }, { name: './extra', file: 'types/extra.d.ts' }]);
  const button = snapshot.exports.find((item) => item.name === 'PrimaryButton');
  assert.equal(button.kind, 'component');
  assert.ok(button.evidence.some((item) => item.file === 'types/index.d.ts' && item.quote.includes('Button as PrimaryButton')));
  assert.match(button.docs.description, /Primary action/);
  assert.deepEqual(button.props.map((prop) => prop.name), ['callback', 'id', 'intent', 'options', 'requiredMaybe']);
  assert.deepEqual(button.props.find((prop) => prop.name === 'intent'), {
    name: 'intent', type: '"quiet" | "strong"', literals: ['quiet', 'strong'], required: false,
    default: { known: true, value: 'quiet' },
    docs: button.props.find((prop) => prop.name === 'intent').docs,
    evidence: button.props.find((prop) => prop.name === 'intent').evidence,
  });
  assert.equal(button.props.find((prop) => prop.name === 'requiredMaybe').type, 'string | undefined');
  assert.equal(button.props.find((prop) => prop.name === 'requiredMaybe').required, true);
  assert.equal(button.props.find((prop) => prop.name === 'options').type, '{ a: string; z: number }');
  const typeExport = snapshot.exports.find((item) => item.name === 'ButtonProps');
  assert.equal(typeExport.kind, 'type'); assert.deepEqual(typeExport.props, []);
  assert.deepEqual(snapshot.documents.map((document) => document.file), ['README.md', 'docs/MIGRATION.md']);
  assert.ok(snapshot.coverage.excludedFiles.some((item) => item.file === 'notes.md'));
  for (const item of [...snapshot.exports, ...snapshot.exports.flatMap((entry) => entry.props)]) for (const evidence of item.evidence) {
    const file = snapshot.files.find((candidate) => candidate.file === evidence.file);
    assert.equal(file.sha256, digest(file.text));
    assert.ok(file.text.includes(evidence.quote));
  }
});

test('extracts inline property JSDoc defaults with exact evidence', async (t) => {
  const root = await fixture({
    'package.json': packageJson({ types: 'index.d.ts' }),
    'index.d.ts': `export interface AvatarProps { /** @default "sm" */ size?: 'sm' | 'md'; }\nexport declare function Avatar(props: AvatarProps): unknown;`,
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const size = (await extractSnapshot(root, ts)).exports.find((item) => item.name === 'Avatar').props.find((prop) => prop.name === 'size');
  const snapshot = await extractSnapshot(root, ts);
  assert.deepEqual(size.default, { known: true, value: 'sm' });
  assert.ok(size.evidence.some((item) => item.quote.includes('@default "sm"')));
  assert.ok(snapshot.coverage.documentationFiles.extracted.includes('index.d.ts'));
});

test('extracts React FC, callable and class prop surfaces without suffix ownership inference', async (t) => {
  const root = await fixture({
    'package.json': packageJson({ types: 'index.d.ts' }),
    'index.d.ts': `
      import type { FC, Component } from 'react';
      interface PanelProps { open: boolean }
      export declare const Panel: FC<PanelProps>;
      export declare const Callable: (props: { count?: number }) => unknown;
      interface CallableInterface { (props: { mode: 'a' | 'b' }): unknown }
      export declare const InterfaceCallable: CallableInterface;
      export declare class Legacy extends Component<{ label: string }> {}
      export interface OrphanProps { ignored: string }
    `,
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const snapshot = await extractSnapshot(root, ts);
  assert.deepEqual(snapshot.exports.find((item) => item.name === 'Panel').props.map((prop) => prop.name), ['open']);
  assert.deepEqual(snapshot.exports.find((item) => item.name === 'Callable').props.map((prop) => prop.name), ['count']);
  assert.deepEqual(snapshot.exports.find((item) => item.name === 'InterfaceCallable').props.map((prop) => prop.name), ['mode']);
  assert.deepEqual(snapshot.exports.find((item) => item.name === 'Legacy').props.map((prop) => prop.name), ['label']);
  assert.equal(snapshot.exports.find((item) => item.name === 'OrphanProps').kind, 'type');
  assert.deepEqual(snapshot.exports.find((item) => item.name === 'OrphanProps').props, []);
});

test('extracts DTCG, legacy and primitive token leaves with exact source evidence', async (t) => {
  const root = await fixture({
    'package.json': packageJson({ types: 'index.d.ts' }),
    'index.d.ts': 'export declare const Theme: unique symbol;',
    'tokens.json': JSON.stringify({ color: { $type: 'color', action: { $value: '#06f' } }, shadow: { $type: 'shadow', $value: { x: 0, blur: 4 } } }, null, 2),
    'tokens/spacing.json': JSON.stringify({ spacing: { small: { value: 4, type: 'dimension' }, raw: 8 } }, null, 2),
    'theme.tokens.json': JSON.stringify({ radius: { $value: 3, $type: 'dimension' } }, null, 2),
    'other.json': '{"ignored":true}',
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const snapshot = await extractSnapshot(root, ts);
  assert.deepEqual(snapshot.tokens.map((token) => token.name), ['color.action', 'radius', 'shadow', 'spacing.raw', 'spacing.small']);
  assert.deepEqual(snapshot.tokens.find((token) => token.name === 'shadow').value, { x: 0, blur: 4 });
  assert.equal(snapshot.tokens.find((token) => token.name === 'color.action').type, 'color');
  assert.deepEqual(snapshot.coverage.tokenFiles.extracted, ['theme.tokens.json', 'tokens.json', 'tokens/spacing.json']);
  assert.ok(snapshot.coverage.excludedFiles.some((item) => item.file === 'other.json'));
});

test('reports unsupported external bases and type surfaces without dropping the export', async (t) => {
  const root = await fixture({
    'package.json': packageJson({ types: 'index.d.ts' }),
    'index.d.ts': `
      import type { ExternalProps } from 'vendor';
      export { ExternalWidget } from 'vendor';
      interface Props extends ExternalProps { local: string }
      export declare function Widget(props: Props): unknown;
      export declare function Dynamic(props: { value: ExternalProps }): unknown;
    `,
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const snapshot = await extractSnapshot(root, ts);
  assert.equal(snapshot.exports.find((item) => item.name === 'Widget').incomplete, true);
  assert.equal(snapshot.exports.find((item) => item.name === 'Dynamic').incomplete, true);
  assert.ok(snapshot.coverage.propSurfaces.unsupported.length >= 2);
  assert.ok(snapshot.coverage.exports.unsupported.some((item) => /external re-export/.test(item.reason)));
  assert.ok(snapshot.issues.some((issue) => /external|unresolved/.test(issue.reason)));
});

test('flattens local alias intersections into a single prop surface', async (t) => {
  const root = await fixture({
    'package.json': packageJson({ types: 'index.d.ts' }),
    'index.d.ts': `
      interface Base { id: string }
      type Local = { active?: boolean };
      type Props = Base & Local & { label: string };
      export declare function Item(props: Props): unknown;
    `,
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const snapshot = await extractSnapshot(root, ts);
  assert.deepEqual(snapshot.exports.find((item) => item.name === 'Item').props.map((prop) => prop.name), ['active', 'id', 'label']);
});

test('canonical callbacks ignore parameter names and mixed primitive unions do not claim literal sets', async (t) => {
  const root = await fixture({
    'package.json': packageJson({ types: 'index.d.ts' }),
    'index.d.ts': `export declare function Callbacks(props: {
      first: (value: string, optional?: number, ...rest: boolean[]) => void;
      second: (renamed: string, maybe?: number, ...items: boolean[]) => void;
      mixed: 'a' | string;
    }): unknown;`,
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const props = (await extractSnapshot(root, ts)).exports[0].props;
  assert.equal(props.find((prop) => prop.name === 'first').type, props.find((prop) => prop.name === 'second').type);
  assert.equal(props.find((prop) => prop.name === 'mixed').literals, undefined);
});

test('reports inherited requiredness conflicts and computed prop names as unsupported', async (t) => {
  const root = await fixture({
    'package.json': packageJson({ types: 'index.d.ts' }),
    'index.d.ts': `
      declare const key: unique symbol;
      interface Base { value?: string }
      interface Conflict extends Base { value: string }
      export declare function Broken(props: Conflict): unknown;
      export declare function Computed(props: { [key]: string }): unknown;
    `,
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const snapshot = await extractSnapshot(root, ts);
  assert.equal(snapshot.exports.find((item) => item.name === 'Broken').incomplete, true);
  assert.equal(snapshot.exports.find((item) => item.name === 'Computed').incomplete, true);
  assert.ok(snapshot.coverage.propSurfaces.unsupported.some((item) => /contradictory inherited/.test(item.reason)));
  assert.ok(snapshot.coverage.propSurfaces.unsupported.some((item) => /computed/.test(item.reason)));
});

test('uses root index fallback only when entrypoints are undeclared', async (t) => {
  const fallback = await fixture({ 'package.json': packageJson(), 'index.d.ts': 'export declare const Value: string;' });
  t.after(() => fs.rm(fallback, { recursive: true, force: true }));
  assert.deepEqual((await extractSnapshot(fallback, ts)).identity.entrypoints, [{ name: '.', file: 'index.d.ts' }]);
  const missing = await fixture({ 'package.json': packageJson({ types: 'missing.d.ts' }), 'index.d.ts': 'export declare const Wrong: string;' });
  t.after(() => fs.rm(missing, { recursive: true, force: true }));
  await assert.rejects(extractSnapshot(missing, ts), /Declared type entrypoint is missing/);
});

test('rejects malformed package metadata, symlinks and empty declaration surfaces explicitly', async (t) => {
  const malformed = await fixture({ 'package.json': JSON.stringify({ name: 'x' }), 'index.d.ts': 'export {};' });
  t.after(() => fs.rm(malformed, { recursive: true, force: true }));
  await assert.rejects(extractSnapshot(malformed, ts), /name and version/);
  const linked = await fixture({ 'package.json': packageJson({ types: 'index.d.ts' }), 'index.d.ts': 'export {};' });
  await fs.symlink(path.join(linked, 'index.d.ts'), path.join(linked, 'linked.d.ts'));
  t.after(() => fs.rm(linked, { recursive: true, force: true }));
  await assert.rejects(extractSnapshot(linked, ts), /symlink/);
  const empty = await fixture({ 'package.json': packageJson({ types: 'index.d.ts' }), 'index.d.ts': 'declare const Internal: string;' });
  t.after(() => fs.rm(empty, { recursive: true, force: true }));
  const snapshot = await extractSnapshot(empty, ts);
  assert.ok(snapshot.issues.some((issue) => issue.id.startsWith('empty-entrypoint:')));
  assert.ok(snapshot.coverage.exports.unsupported.some((item) => item.id === '.#*'));
  const explicit = await fixture({ 'package.json': packageJson({ types: 'index.d.ts' }), 'index.d.ts': 'export {};' });
  t.after(() => fs.rm(explicit, { recursive: true, force: true }));
  const explicitSnapshot = await extractSnapshot(explicit, ts);
  assert.equal(explicitSnapshot.coverage.exports.unsupported.some((item) => item.id === '.#*'), false);
});

test('syntax recovery marks exported surfaces incomplete and suppresses authoritative absence coverage', async (t) => {
  const root = await fixture({
    'package.json': packageJson({ types: 'index.d.ts' }),
    'index.d.ts': `export declare function Button(props: { tone: string }): unknown;\n<<<`,
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const snapshot = await extractSnapshot(root, ts);
  assert.ok(snapshot.issues.some((issue) => issue.id.startsWith('syntax:')));
  assert.equal(snapshot.exports.find((item) => item.name === 'Button').incomplete, true);
  assert.ok(snapshot.coverage.exports.unsupported.some((item) => item.id === '.#*' && /non-authoritative/.test(item.reason)));
});

test('identity includes binary file hashes while files excludes lossy text', async (t) => {
  const root = await fixture({ 'package.json': packageJson({ types: 'index.d.ts' }), 'index.d.ts': 'export declare const Value: string;' });
  await fs.writeFile(path.join(root, 'asset.bin'), Buffer.from([0xff, 0xfe, 0x00]));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = await extractSnapshot(root, ts);
  assert.ok(!first.files.some((file) => file.file === 'asset.bin'));
  assert.ok(first.coverage.excludedFiles.some((item) => item.file === 'asset.bin' && /binary/.test(item.reason)));
  await fs.writeFile(path.join(root, 'asset.bin'), Buffer.from([0xff, 0xfd, 0x00]));
  const second = await extractSnapshot(root, ts);
  assert.notEqual(first.identity.digest, second.identity.digest);
});

test('extraction is deterministic and excludes sensitive text from returned contexts', async (t) => {
  const root = await fixture({
    'package.json': packageJson({ types: 'index.d.ts' }),
    'index.d.ts': 'export declare const Value: string;',
    '.npmrc': '//registry.example/:_authToken=secret',
    '.SSH/id_rsa': 'CASE VARIANT PRIVATE KEY CONTENT',
    '.ENV': 'TOKEN=case-variant-secret',
    '.Env.local': 'TOKEN=case-variant-dot-secret',
    'ID_RSA': 'CASE VARIANT KEY CONTENT',
    'NODE_MODULES/secret.js': 'export const token = "ignored";',
    'notes.txt': 'unselected context should not be returned',
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = await extractSnapshot(root, ts); const second = await extractSnapshot(root, ts);
  assert.deepEqual(second, first);
  assert.ok(!first.files.some((file) => file.file === '.npmrc'));
  assert.ok(!first.files.some((file) => file.file === '.SSH/id_rsa' || file.file === 'notes.txt'));
  assert.ok(!first.files.some((file) => ['.ENV', '.Env.local', 'ID_RSA', 'NODE_MODULES/secret.js'].includes(file.file)));
  assert.ok(first.coverage.excludedFiles.some((item) => item.file === '.npmrc' && /sensitive/.test(item.reason)));
  assert.ok(first.coverage.excludedFiles.some((item) => item.file === '.SSH' && /sensitive/.test(item.reason)));
  assert.ok(first.coverage.excludedFiles.some((item) => item.file === 'NODE_MODULES' && /dependency/.test(item.reason)));
});

test('admits dist declarations and resolves explicit JavaScript re-exports to modern declarations', async (t) => {
  const root = await fixture({
    'package.json': packageJson({ types: 'dist/index.d.mts' }),
    'dist/index.d.mts': `export { Modern } from './modern.js';`,
    'dist/modern.d.mts': `export declare function Modern(props: { value: string }): unknown;`,
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const snapshot = await extractSnapshot(root, ts);
  assert.deepEqual(snapshot.identity.entrypoints, [{ name: '.', file: 'dist/index.d.mts' }]);
  assert.deepEqual(snapshot.exports.find((item) => item.name === 'Modern').props.map((prop) => prop.name), ['value']);
  assert.ok(snapshot.files.some((file) => file.file === 'dist/modern.d.mts'));
});

test('star re-export evidence names only the module exposing that symbol', async (t) => {
  const root = await fixture({
    'package.json': packageJson({ types: 'index.d.ts' }),
    'index.d.ts': `export * from './alpha';\nexport * from './beta';\n`,
    'alpha.d.ts': `export declare const Alpha: string;`,
    'beta.d.ts': `export declare const Beta: string;`,
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const snapshot = await extractSnapshot(root, ts);
  const alpha = snapshot.exports.find((item) => item.name === 'Alpha');
  assert.ok(alpha.evidence.some((item) => item.quote === `export * from './alpha';`));
  assert.ok(!alpha.evidence.some((item) => item.quote === `export * from './beta';`));
});

test('uses FC initializer destructuring defaults with expression evidence', async (t) => {
  const root = await fixture({
    'package.json': packageJson({ types: 'index.tsx' }),
    'index.tsx': `
      import type { FC } from 'react';
      interface Props { tone?: 'quiet' | 'loud' }
      export const Panel: FC<Props> = ({ tone = 'loud' }) => null;
    `,
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const snapshot = await extractSnapshot(root, ts); const tone = snapshot.exports.find((item) => item.name === 'Panel').props[0];
  assert.deepEqual(tone.default, { known: true, value: 'loud' });
  assert.ok(tone.evidence.some((item) => item.quote.includes("tone = 'loud'")));
});

test('token evidence is path-aware when leaf keys and values repeat', async (t) => {
  const root = await fixture({
    'package.json': packageJson({ types: 'index.d.ts' }),
    'index.d.ts': 'export declare const Theme: unique symbol;',
    'tokens.json': JSON.stringify({ first: { same: { $value: 1 } }, second: { same: { $value: 1 } } }, null, 2),
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const snapshot = await extractSnapshot(root, ts);
  const first = snapshot.tokens.find((token) => token.name === 'first.same').evidence[0];
  const second = snapshot.tokens.find((token) => token.name === 'second.same').evidence[0];
  assert.notEqual(first.startLine, second.startLine);
  assert.match(first.quote, /"same"[\s\S]*"\$value": 1/);
  assert.match(second.quote, /"same"[\s\S]*"\$value": 1/);
});

test('rejects contradictory declared root type entrypoints', async (t) => {
  const root = await fixture({
    'package.json': packageJson({ types: 'one.d.ts', typings: 'two.d.ts' }),
    'one.d.ts': 'export declare const One: string;',
    'two.d.ts': 'export declare const Two: string;',
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await assert.rejects(extractSnapshot(root, ts), /contradictory declared type entrypoints/);
});
