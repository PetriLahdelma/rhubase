import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadCompiler } from '../../src/source-analysis.mjs';
import { extractSnapshot } from '../../src/snapshot-api.mjs';
import { compareSnapshots, inferContract, validateContract } from '../../src/inference.mjs';

const compiler = process.env.SHIFT_TYPESCRIPT_PATH ?? path.resolve(import.meta.dirname, '../../node_modules/typescript/lib/typescript.js');
const loaded = await loadCompiler(compiler);

async function fixture(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shift-inference-'));
  for (const [file, text] of Object.entries(files)) {
    const target = path.join(root, file); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, text);
  }
  return root;
}

const manifest = (version) => JSON.stringify({ name: '@demo/system', version, types: 'index.d.ts' }, null, 2);
const find = (contract, kind, fields = {}) => contract.changes.find((item) => item.kind === kind && Object.entries(fields).every(([key, value]) => item[key] === value));

async function snapshots(t, oldFiles, newFiles) {
  const from = await fixture({ 'package.json': manifest('1.0.0'), ...oldFiles });
  const to = await fixture({ 'package.json': manifest('2.0.0'), ...newFiles });
  t.after(() => Promise.all([fs.rm(from, { recursive: true, force: true }), fs.rm(to, { recursive: true, force: true })]));
  return { from: await extractSnapshot(from, loaded.ts), to: await extractSnapshot(to, loaded.ts), fromRoot: from, toRoot: to };
}

test('reports supported export, prop, type, requiredness, default, literal and token facts deterministically', async (t) => {
  const pair = await snapshots(t, {
    'index.d.ts': `
      type Mode = 'quiet' | 'loud';
      interface Props {
        oldProp: string;
        mode?: Mode | undefined;
        maybe: string | undefined;
        callback: (value: string) => void;
        literalOnly?: 'a' | 'b';
        /** @defaultValue "quiet" */ intent?: string;
      }
      export declare function Button(props: Props): unknown;
      export declare function Legacy(props: { id: string }): unknown;
    `,
    'tokens.json': JSON.stringify({ color: { old: { $value: '#06f', $type: 'color' }, stable: { $value: '#000', $type: 'color' } }, shadow: { $value: { x: 0, blur: 4 }, $type: 'shadow' } }, null, 2),
  }, {
    'index.d.ts': `
      type RenamedMode = ('loud' | 'quiet');
      interface Props {
        newProp: string;
        mode?: RenamedMode;
        maybe?: string;
        callback: (value: number) => void;
        literalOnly?: string;
        /** @defaultValue "loud" */ intent?: string;
      }
      export declare function Button(props: Props): unknown;
      export declare function Added(props: { id: string }): unknown;
    `,
    'tokens.json': JSON.stringify({ color: { fresh: { $value: '#06f', $type: 'color' }, stable: { $value: 0, $type: 'number' } }, shadow: { $type: 'shadow', $value: { blur: 4, x: 0 } } }, null, 2),
  });
  const contract = compareSnapshots(pair.from, pair.to, loaded.identity);
  assert.ok(find(contract, 'export-removed', { export: 'Legacy' }));
  assert.ok(find(contract, 'export-added', { export: 'Added' }));
  assert.ok(find(contract, 'prop-removed', { export: 'Button', prop: 'oldProp' }));
  assert.ok(find(contract, 'prop-added', { export: 'Button', prop: 'newProp' }));
  assert.ok(find(contract, 'prop-type-changed', { export: 'Button', prop: 'callback' }));
  assert.ok(find(contract, 'prop-literals-changed', { export: 'Button', prop: 'literalOnly' }));
  assert.ok(find(contract, 'prop-type-changed', { export: 'Button', prop: 'literalOnly' }));
  assert.ok(find(contract, 'prop-requiredness-changed', { export: 'Button', prop: 'maybe' }));
  assert.equal(find(contract, 'prop-type-changed', { export: 'Button', prop: 'maybe' }), undefined);
  assert.ok(find(contract, 'prop-default-changed', { export: 'Button', prop: 'intent' }));
  assert.equal(contract.changes.some((item) => item.prop === 'mode'), false, 'alias/union/optional undefined refactor is unchanged');
  assert.ok(find(contract, 'token-removed', { token: 'color.old' }));
  assert.ok(find(contract, 'token-added', { token: 'color.fresh' }));
  assert.ok(find(contract, 'token-value-changed', { token: 'color.stable' }));
  assert.ok(find(contract, 'token-type-changed', { token: 'color.stable' }));
  assert.equal(contract.changes.some((item) => item.token === 'shadow'), false, 'composite object key order is unchanged');
  assert.deepEqual(contract, compareSnapshots(pair.from, pair.to, loaded.identity));
  assert.ok(contract.proposals.every((item) => item.status === 'needs-review' && item.executable === false));
});

test('reports inline JSDoc default changes', async (t) => {
  const pair = await snapshots(t, {
    'index.d.ts': `export interface AvatarProps { /** @default "sm" */ size?: 'sm' | 'md'; }\nexport declare function Avatar(props: AvatarProps): unknown;`,
  }, {
    'index.d.ts': `export interface AvatarProps { /** @default "md" */ size?: 'sm' | 'md'; }\nexport declare function Avatar(props: AvatarProps): unknown;`,
  });
  assert.ok(find(compareSnapshots(pair.from, pair.to, loaded.identity), 'prop-default-changed', { export: 'Avatar', prop: 'size' }));
});

test('grounds a cross-component prop rename through the documented component relation', async (t) => {
  const pair = await snapshots(t, {
    'index.d.ts': `export interface LegacyButtonProps { tone?: 'default' | 'strong'; }\nexport declare function LegacyButton(props: LegacyButtonProps): unknown;`,
  }, {
    'index.d.ts': `export interface ActionButtonProps { emphasis?: 'default' | 'strong'; }\nexport declare function ActionButton(props: ActionButtonProps): unknown;`,
    'docs/migration.md': '`LegacyButton` is renamed to `ActionButton`. Its `tone` prop is renamed to `emphasis`.',
  });
  const contract = compareSnapshots(pair.from, pair.to, loaded.identity);
  assert.ok(contract.proposals.some((item) => item.kind === 'component-rename' && item.source.export === 'LegacyButton' && item.target.export === 'ActionButton'));
  assert.ok(contract.proposals.some((item) => item.kind === 'prop-rename' && item.source.export === 'LegacyButton' && item.source.prop === 'tone'
    && item.target.export === 'ActionButton' && item.target.prop === 'emphasis'));
});

test('recognizes explicit prop replacement wording with articles and prop nouns', async (t) => {
  const pair = await snapshots(t, {
    'index.d.ts': `export declare function Banner(props: { intent?: string; text: string }): unknown;`,
  }, {
    'index.d.ts': `export declare function Banner(props: { emphasis?: string; text: string }): unknown;`,
    'MIGRATION.md': 'On Banner, replace the intent prop with the emphasis prop.',
  });
  const contract = compareSnapshots(pair.from, pair.to, loaded.identity);
  assert.ok(contract.proposals.some((item) => item.kind === 'prop-rename' && item.source.prop === 'intent' && item.target.prop === 'emphasis'));
});

test('maps each explicitly enumerated consolidation source to one existing target', async (t) => {
  const pair = await snapshots(t, {
    'index.d.ts': `
      export declare function MiniPill(props: { text: string }): unknown;
      export declare function StatePill(props: { text: string }): unknown;
    `,
  }, {
    'index.d.ts': `export declare function Pill(props: { text: string }): unknown;`,
    'CHANGELOG.md': 'MiniPill and StatePill were consolidated into Pill.',
  });
  const contract = compareSnapshots(pair.from, pair.to, loaded.identity);
  assert.ok(contract.proposals.some((item) => item.kind === 'component-rename' && item.source.export === 'MiniPill' && item.target.export === 'Pill'));
  assert.ok(contract.proposals.some((item) => item.kind === 'component-rename' && item.source.export === 'StatePill' && item.target.export === 'Pill'));
});

test('keeps distinct split targets even when their labels have different lengths', async (t) => {
  const pair = await snapshots(t, {
    'index.d.ts': `export declare function Entry(props: { href?: string; expanded?: boolean }): unknown;`,
  }, {
    'index.d.ts': `
      export declare function LinkEntry(props: { href: string }): unknown;
      export declare function DisclosureEntry(props: { expanded: boolean }): unknown;
    `,
    'docs/v2.md': 'Entry was split into LinkEntry for links and DisclosureEntry for expandable controls.',
  });
  const proposal = compareSnapshots(pair.from, pair.to, loaded.identity).proposals.find((item) => item.kind === 'component-split');
  assert.deepEqual(proposal.targets.map((target) => target.export).sort(), ['DisclosureEntry', 'LinkEntry']);
});

test('withdraws cross-component prop mappings when the component relation is contradictory', async (t) => {
  const pair = await snapshots(t, {
    'index.d.ts': `export declare function Legacy(props: { tone?: string }): unknown;`,
    'MIGRATION.md': [
      'Legacy renamed to Action.',
      'Legacy.tone renamed to Action.emphasis.',
      'Legacy renamed to Other.',
    ].join('\n'),
  }, {
    'index.d.ts': `
      export declare function Action(props: { emphasis?: string }): unknown;
      export declare function Other(props: { emphasis?: string }): unknown;
    `,
  });
  const contract = compareSnapshots(pair.from, pair.to, loaded.identity);
  assert.equal(contract.proposals.some((item) => item.source.export === 'Legacy'), false);
  assert.ok(contract.unresolved.some((item) => item.kind === 'contradictory-mapping' && item.source.export === 'Legacy' && item.source.prop === 'tone'));
});

test('ignores negative, interrogative, fenced and example mapping prose while preserving deprecation guidance', async (t) => {
  const pair = await snapshots(t, {
    'index.d.ts': `
      /** @example Use Target instead of Legacy */
      export declare function Legacy(props: { value: string }): unknown;
      /** @deprecated Use New instead of Old */
      export declare function Old(props: { value: string }): unknown;
    `,
    'MIGRATION.md': [
      'Do not replace Legacy with Target.',
      'Should we replace Legacy with Target?',
      'Replace the Legacy prop with the Target prop.',
      '```',
      'Legacy renamed to Target.',
      '```',
    ].join('\n'),
  }, {
    'index.d.ts': `
      export declare function Target(props: { value: string }): unknown;
      export declare function New(props: { value: string }): unknown;
    `,
  });
  const contract = compareSnapshots(pair.from, pair.to, loaded.identity);
  assert.equal(contract.proposals.some((item) => item.source.export === 'Legacy'), false);
  assert.ok(contract.proposals.some((item) => item.kind === 'component-rename' && item.source.export === 'Old' && item.target.export === 'New'));
});

test('treats explicit export empty as authoritative removal evidence', async (t) => {
  const pair = await snapshots(t, {
    'index.d.ts': `export declare function DeprecatedWidget(props: { legacy: true }): unknown;`,
  }, {
    'index.d.ts': 'export {};',
    'CHANGELOG.md': 'DeprecatedWidget was removed without replacement.',
  });
  const contract = compareSnapshots(pair.from, pair.to, loaded.identity);
  assert.ok(find(contract, 'export-removed', { export: 'DeprecatedWidget' }));
  assert.equal(contract.proposals.some((item) => item.source.export === 'DeprecatedWidget'), false);
  assert.ok(contract.unresolved.some((item) => item.kind === 'missing-target' && item.source.export === 'DeprecatedWidget'));
});

test('creates only grounded documentation proposals and abstains on conflicts, missing targets and equal token values', async (t) => {
  const pair = await snapshots(t, {
    'index.d.ts': `
      export declare function Legacy(props: { legacyTone?: 'quiet' | 'loud'; variant?: 'content' | 'plain' }): unknown;
      export declare function Button(props: { legacyTone?: string; variant?: 'content' | 'plain' }): unknown;
      export declare function OldNav(props: { href: string }): unknown;
      export declare function OldCard(props: { title: string }): unknown;
      export declare function Ghost(props: { value: string }): unknown;
      export declare function ExistingTarget(props: { value: string }): unknown;
      export declare function OldExisting(props: { value: string }): unknown;
      export declare function OldBy(props: { value: string }): unknown;
      export declare function OldImperative(props: { value: string }): unknown;
      export declare function OldRather(props: { value: string }): unknown;
    `,
    'tokens.json': JSON.stringify({ color: { action: { $value: '#06f' }, duplicate: { $value: '#fff' } } }, null, 2),
    'MIGRATION.md': [
      '`ActionButton` replaces `Legacy`.',
      'Prop `Button.legacyTone` was renamed to `Button.emphasis`.',
      'Value `Button.variant=content` was renamed to `Button.variant=default`.',
      'Token `color.action` was renamed to `color.interactive`.',
      '`OldNav` was split into `LinkNav` and `MenuNav`.',
      '`OldCard` was renamed to `Card`.',
      '`OldCard` was renamed to `Panel`.',
      '`ExistingTarget` replaces `OldExisting`.',
      '`OldBy` was replaced by `NewBy`.',
      'Replace `OldImperative` with `NewImperative`.',
      'Use `NewRather` rather than `OldRather`.',
    ].join('\n'),
  }, {
    'index.d.ts': `
      export declare function ActionButton(props: { emphasis?: 'subtle' | 'loud'; variant?: 'default' | 'plain' }): unknown;
      export declare function Button(props: { emphasis?: string; variant?: 'default' | 'plain' }): unknown;
      export declare function LinkNav(props: { href: string }): unknown;
      export declare function MenuNav(props: { items: string[] }): unknown;
      export declare function Card(props: { title: string }): unknown;
      export declare function Panel(props: { title: string }): unknown;
      export declare function ExistingTarget(props: { value: string }): unknown;
      export declare function NewBy(props: { value: string }): unknown;
      export declare function NewImperative(props: { value: string }): unknown;
      export declare function NewRather(props: { value: string }): unknown;
    `,
    'tokens.json': JSON.stringify({ color: { interactive: { $value: '#06f' }, sameValue: { $value: '#fff' } } }, null, 2),
  });
  const contract = compareSnapshots(pair.from, pair.to, loaded.identity);
  const kinds = contract.proposals.map((item) => item.kind);
  assert.ok(kinds.includes('component-rename'));
  assert.ok(kinds.includes('prop-rename'));
  assert.ok(kinds.includes('prop-value-rename'));
  assert.ok(kinds.includes('token-rename'));
  assert.ok(kinds.includes('component-split'));
  assert.ok(contract.proposals.every((item) => item.basis === 'documentation-explicit' && item.evidence.length >= 3));
  assert.equal(contract.proposals.some((item) => item.source.export === 'OldCard'), false);
  assert.ok(contract.unresolved.some((item) => item.kind === 'contradictory-mapping' && item.source.export === 'OldCard'));
  assert.ok(contract.unresolved.some((item) => item.kind === 'missing-target' && item.source.export === 'Ghost'));
  assert.equal(contract.proposals.some((item) => item.source.token === 'color.duplicate'), false, 'equal token values do not establish a rename');
  for (const source of ['OldExisting', 'OldBy', 'OldImperative', 'OldRather']) assert.ok(contract.proposals.some((item) => item.source.export === source), `missing documented mapping for ${source}`);
});

test('withholds absence facts on incomplete surfaces and records unknown default evidence', async (t) => {
  const pair = await snapshots(t, {
    'index.d.ts': `
      import type { External } from 'vendor';
      interface Props {
        known: string;
        uncertain: External;
        /** @defaultValue "x" */
        mode?: string;
      }
      export declare function Widget(props: Props): unknown;
    `,
  }, {
    'index.d.ts': `export declare function Widget(props: { known: number; mode?: string }): unknown;`,
  });
  const contract = compareSnapshots(pair.from, pair.to, loaded.identity);
  assert.ok(find(contract, 'prop-type-changed', { export: 'Widget', prop: 'known' }));
  assert.equal(find(contract, 'prop-removed', { export: 'Widget', prop: 'uncertain' }), undefined);
  assert.equal(find(contract, 'prop-default-changed', { export: 'Widget', prop: 'mode' }), undefined);
  assert.ok(contract.unresolved.some((item) => item.kind === 'unsupported-extraction'));
  assert.ok(contract.unresolved.some((item) => item.kind === 'default-knowledge-incomplete'));
});

test('abstains from documented replacement when the source export is incomplete', async (t) => {
  const pair = await snapshots(t, {
    'index.d.ts': `
      import type { External } from 'vendor';
      export declare function Legacy(props: External): unknown;
    `,
    'MIGRATION.md': 'Legacy renamed to New.',
  }, {
    'index.d.ts': `export declare function New(props: { value: string }): unknown;`,
  });
  const contract = compareSnapshots(pair.from, pair.to, loaded.identity);
  assert.equal(contract.proposals.some((item) => item.source.export === 'Legacy'), false);
  assert.ok(contract.unresolved.some((item) => item.kind === 'unsupported-extraction'));
});

test('withholds confident prop facts from syntax-recovered snapshots', async (t) => {
  const pair = await snapshots(t, {
    'index.d.ts': `export declare function Widget(props: { value: string }): unknown;\n<<<`,
  }, {
    'index.d.ts': `export declare function Widget(props: { value: number }): unknown;`,
  });
  const contract = compareSnapshots(pair.from, pair.to, loaded.identity);
  assert.equal(contract.changes.some((item) => item.export === 'Widget' && item.prop === 'value'), false);
  assert.ok(contract.unresolved.some((item) => item.kind === 'unsupported-extraction' && item.evidence.some((evidence) => evidence.file === 'index.d.ts' && evidence.quote.length > 0)));
});

test('validates evidence, targets and snapshot identity and rejects tampering', async (t) => {
  const pair = await snapshots(t, {
    'index.d.ts': 'export declare function Old(props: { value: string }): unknown;',
    'MIGRATION.md': 'Old renamed to New.',
  }, { 'index.d.ts': `
    import type { External } from 'vendor';
    export declare function New(props: { value: string }): unknown;
    export declare function Other(props: { uncertain: External }): unknown;
  ` });
  const contract = compareSnapshots(pair.from, pair.to, loaded.identity);
  const tampered = structuredClone(contract);
  tampered.changes[0].evidence[0].quote += ' altered';
  assert.throws(() => validateContract(tampered, pair), /Invalid evidence/);
  const targetTamper = structuredClone(contract);
  targetTamper.proposals[0].target.export = 'Missing';
  assert.throws(() => validateContract(targetTamper, pair), /target does not exist/);
  const unsupportedTarget = structuredClone(contract);
  unsupportedTarget.proposals[0].target = { export: 'Other', prop: 'uncertain' };
  assert.throws(() => validateContract(unsupportedTarget, pair), /target does not exist/);
  const executable = structuredClone(contract);
  executable.executable = true;
  assert.throws(() => validateContract(executable, pair), /header|non-executable/i);
  const executableProposal = structuredClone(contract);
  executableProposal.proposals[0].executable = true;
  assert.throws(() => validateContract(executableProposal, pair), /non-executable|need review/i);
});

test('inferContract uses immutable local snapshots and records compiler identity', async (t) => {
  const pair = await snapshots(t, { 'index.d.ts': 'export declare const Old: string;' }, { 'index.d.ts': 'export declare const New: string;' });
  const contract = await inferContract({ from: pair.fromRoot, to: pair.toRoot, compiler });
  assert.equal(contract.compiler.version, '5.9.3');
  assert.match(contract.compiler.sha256, /^[a-f0-9]{64}$/);
  assert.equal(contract.kind, 'migration-contract');
});

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['src/cli.mjs', ...args], { cwd: path.resolve(import.meta.dirname, '../..') });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('CLI writes one external contract exclusively and rejects output inside either input', async (t) => {
  const pair = await snapshots(t, { 'index.d.ts': 'export declare const Old: string;' }, { 'index.d.ts': 'export declare const New: string;' });
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'shift-contract-'));
  t.after(() => fs.rm(outputRoot, { recursive: true, force: true }));
  const out = path.join(outputRoot, 'contract.json');
  const args = ['infer', '--from', pair.fromRoot, '--to', pair.toRoot, '--compiler', compiler, '--out', out];
  const first = await runCli(args);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(JSON.parse(await fs.readFile(out, 'utf8')).status, 'draft');
  const overwrite = await runCli(args);
  assert.notEqual(overwrite.code, 0);
  const nested = path.join(pair.fromRoot, 'contract.json');
  const rejected = await runCli(['infer', '--from', pair.fromRoot, '--to', pair.toRoot, '--compiler', compiler, '--out', nested]);
  assert.notEqual(rejected.code, 0);
  await assert.rejects(fs.access(nested));
  const nestedTarget = path.join(pair.toRoot, 'contract.json');
  const rejectedTarget = await runCli(['infer', '--from', pair.fromRoot, '--to', pair.toRoot, '--compiler', compiler, '--out', nestedTarget]);
  assert.notEqual(rejectedTarget.code, 0);
  await assert.rejects(fs.access(nestedTarget));
});
