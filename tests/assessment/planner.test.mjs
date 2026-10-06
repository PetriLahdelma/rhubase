import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  handleAssessmentWorkerText, validateAssessmentWorkerRequest,
} from '../../src/assessment-worker.mjs';
import { assessConsumer, composeAssessment, resolveAssessment } from '../../src/consumer-assessment.mjs';

const requestId = 'a'.repeat(64);
const sha = 'b'.repeat(64);

function identity(name, version, digest = sha) { return { name, version, digest, entrypoints: [] }; }
function resolution() {
  const sources = [
    { id: 'source:one', kind: 'source', specifier: '@old/one', importName: '@old/one', root: '/repo/packages/old-one', resolution: 'workspace', identity: { name: '@old/one', version: '1.0.0' }, manifestSha256: sha },
    { id: 'source:two', kind: 'source', specifier: '@old/two', importName: '@old/two', root: '/repo/packages/old-two', resolution: 'workspace', identity: { name: '@old/two', version: '1.0.0' }, manifestSha256: sha },
  ];
  return {
    schemaVersion: 1, kind: 'assessment-resolution', digest: sha,
    repository: {
      root: '/repo', digest: sha, files: [],
      manifests: [{ file: 'package.json', name: 'consumer', version: '1.0.0', dependencies: [] }], workspaces: [],
      packageManager: { declared: 'npm@10', lockfiles: [] },
      declaredScripts: [{ manifest: 'package.json', name: 'test', category: 'test' }],
      ciEvidence: [{ file: '.github/workflows/ci.yml', sha256: sha }],
      codeowners: [
        { file: 'CODEOWNERS', sha256: sha, rules: [{ pattern: '/packages/app/', owners: ['@wrong/root'], line: 1 }] },
        { file: '.github/CODEOWNERS', sha256: sha, rules: [
          { pattern: '*', owners: ['@all'], line: 1 },
          { pattern: '/packages/app/', owners: ['@team/ui'], line: 2 },
          { pattern: '/packages/app/private/', owners: [], line: 3 },
        ] },
      ],
      coverage: { scannedSourceFiles: 2, excluded: [], unsupported: [] },
    },
    sources,
    target: { id: 'target:new', kind: 'target', specifier: '@new/ui', importName: '@new/ui', root: '/repo/packages/new', resolution: 'workspace', identity: { name: '@new/ui', version: '2.0.0' }, manifestSha256: sha },
  };
}

function contract(source, proposals = [], changes = []) {
  return {
    schemaVersion: 1, kind: 'migration-contract', status: 'draft', executable: false,
    from: identity(source.identity.name, source.identity.version), to: identity('@new/ui', '2.0.0'),
    compiler: { version: '5.9.3', sha256: sha }, coverage: { from: {}, to: {} },
    changes, proposals, unresolved: [], limitations: [],
  };
}

function usage(id, sourceId, file, label, variant = 'content') {
  return {
    id, file, line: 3, column: 2, start: 10, end: 40, consumerPackage: 'consumer', sourceId,
    sourcePackage: sourceId === 'source:one' ? '@old/one' : '@old/two', module: sourceId === 'source:one' ? '@old/one' : '@old/two', export: 'Button',
    props: [{ name: 'label', kind: 'literal', value: label }, { name: 'variant', kind: 'literal', value: variant }], hasSpread: false,
    evidence: [{ scope: 'consumer', file, sha256: sha, startLine: 3, endLine: 3, quote: '<Button />' }],
  };
}

test('groups reusable migration conditions without splitting on unrelated label content', () => {
  const selected = resolution();
  const component = { id: 'proposal:component', kind: 'component-rename', source: { export: 'Button' }, target: { export: 'ActionButton' }, basis: 'documentation-explicit', reason: 'documented', status: 'needs-review', executable: false, evidence: [] };
  const labelRename = { id: 'proposal:label', kind: 'prop-rename', source: { export: 'Button', prop: 'label' }, target: { export: 'ActionButton', prop: 'children' }, basis: 'documentation-explicit', reason: 'documented', status: 'needs-review', executable: false, evidence: [] };
  const variant = { id: 'proposal:variant', kind: 'prop-value-rename', source: { export: 'Button', prop: 'variant', value: 'content' }, target: { export: 'ActionButton', prop: 'emphasis', value: 'default' }, basis: 'documentation-explicit', reason: 'documented', status: 'needs-review', executable: false, evidence: [] };
  const contracts = [
    { sourceId: 'source:one', file: 'contracts/source:one.json', contract: contract(selected.sources[0], [component, labelRename, variant]) },
    { sourceId: 'source:two', file: 'contracts/source:two.json', contract: contract(selected.sources[1]) },
  ];
  const usages = [
    usage('usage:a', 'source:one', 'packages/app/src/a.tsx', 'Save'),
    usage('usage:b', 'source:one', 'packages/app/src/b.tsx', 'Cancel'),
    usage('usage:c', 'source:two', 'packages/app/private/c.tsx', 'Continue'),
  ];
  const assessment = composeAssessment({ resolution: selected, contracts, usageInventory: {
    filesScanned: 2, usages, unsupported: [], coverage: { status: 'scoped', sourceFiles: {}, jsxSites: 3, recognizedUsages: 3, unsupportedCount: 0, limitations: [] },
  } });
  assert.equal(assessment.mappingGroups.length, 2);
  const first = assessment.mappingGroups.find((item) => item.sourceId === 'source:one');
  assert.equal(first.count, 2);
  assert.deepEqual(first.condition.literalProps, [{ name: 'variant', value: 'content' }]);
  assert.deepEqual(first.condition.presentProps, ['label', 'variant']);
  assert.deepEqual(first.target, { export: 'ActionButton' });
  assert.equal(first.candidateTargets.length, 3, 'component, prop, and value proposal references stay reviewable');
  assert.ok(first.candidateTargets.some((item) => item.prop === 'children'));
  assert.equal(first.route, 'mapping-to-review');
  assert.deepEqual(first.usageIds, ['usage:a', 'usage:b']);
  const decision = assessment.decisionsRequired.find((item) => item.groupId === first.id);
  assert.deepEqual(decision.candidateOwners, ['@team/ui']);
  assert.equal(decision.ownerStatus, 'candidate');
  assert.equal(decision.status, 'needs-review');
  assert.deepEqual(decision.requiredChecks, []);
  assert.ok(decision.preconditions.some((item) => /define or confirm required verification/i.test(item)));
  const second = assessment.mappingGroups.find((item) => item.sourceId === 'source:two');
  assert.equal(second.route, 'decision-required', 'unchanged APIs do not establish cross-system retirement');
  assert.deepEqual(assessment.decisionsRequired.find((item) => item.groupId === second.id).candidateOwners, [], 'last matching empty owner rule clears ownership candidates');
  assert.ok(assessment.verificationCandidates.some((item) => item.status === 'declared-not-run'));
  assert.ok(assessment.verificationCandidates.some((item) => item.status === 'missing'));
});

test('dynamic values, spreads, split targets and missing mappings never become automatic', () => {
  const selected = resolution();
  const split = { id: 'proposal:split', kind: 'component-split', source: { export: 'Button' }, targets: [{ export: 'LinkButton' }, { export: 'ToggleButton' }], basis: 'documentation-explicit', reason: 'documented', status: 'needs-review', executable: false, evidence: [] };
  const dynamic = usage('usage:dynamic', 'source:one', 'packages/app/src/a.tsx', 'Save');
  dynamic.props = [{ name: 'variant', kind: 'expression', value: 'mode' }, { name: '...', kind: 'spread', value: 'props' }]; dynamic.hasSpread = true;
  const assessment = composeAssessment({ resolution: selected, contracts: [
    { sourceId: 'source:one', file: 'contracts/source:one.json', contract: contract(selected.sources[0], [split]) },
    { sourceId: 'source:two', file: 'contracts/source:two.json', contract: contract(selected.sources[1]) },
  ], usageInventory: { filesScanned: 1, usages: [dynamic], unsupported: [{ id: 'unknown:1', kind: 'spread-props', file: dynamic.file, reason: 'opaque', evidence: [] }], coverage: { status: 'partial', sourceFiles: {}, jsxSites: 1, recognizedUsages: 1, unsupportedCount: 1, limitations: [] } } });
  assert.equal(assessment.mappingGroups[0].route, 'decision-required');
  assert.equal(assessment.mappingGroups[0].candidateTargets.length, 2);
  assert.match(assessment.decisionsRequired[0].reason, /spread/i);
  assert.equal(assessment.executable, false);
  assert.equal(JSON.stringify(assessment).includes('/repo'), false, 'portable assessment omits canonical input roots');
});

test('conflicting targets for the same source predicate require a decision even within one target component', () => {
  const selected = resolution();
  const source = { export: 'Button', prop: 'variant', value: 'content' };
  const proposals = [
    { id: 'proposal:a', kind: 'prop-value-rename', source, target: { export: 'ActionButton', prop: 'emphasis', value: 'default' }, basis: 'documentation-explicit', reason: 'a', status: 'needs-review', executable: false, evidence: [] },
    { id: 'proposal:b', kind: 'prop-value-rename', source, target: { export: 'ActionButton', prop: 'emphasis', value: 'subtle' }, basis: 'documentation-explicit', reason: 'b', status: 'needs-review', executable: false, evidence: [] },
  ];
  const assessment = composeAssessment({ resolution: selected, contracts: [
    { sourceId: 'source:one', file: 'contracts/source:one.json', contract: contract(selected.sources[0], proposals) },
    { sourceId: 'source:two', file: 'contracts/source:two.json', contract: contract(selected.sources[1]) },
  ], usageInventory: { filesScanned: 1, usages: [usage('usage:conflict', 'source:one', 'packages/app/src/a.tsx', 'Save')], unsupported: [], coverage: { status: 'scoped', sourceFiles: {}, jsxSites: 1, recognizedUsages: 1, unsupportedCount: 0, limitations: [] } } });
  assert.equal(assessment.mappingGroups[0].route, 'decision-required');
  assert.equal(assessment.mappingGroups[0].target, null);
  assert.equal(assessment.mappingGroups[0].candidateTargets.length, 2);
});

test('CODEOWNERS uses active-file precedence and last matching rule while mixed group owners remain unassigned', () => {
  const selected = resolution();
  const component = { id: 'proposal:component', kind: 'component-rename', source: { export: 'Button' }, target: { export: 'ActionButton' }, basis: 'documentation-explicit', reason: 'documented', status: 'needs-review', executable: false, evidence: [] };
  const contracts = [
    { sourceId: 'source:one', file: 'contracts/source:one.json', contract: contract(selected.sources[0], [component]) },
    { sourceId: 'source:two', file: 'contracts/source:two.json', contract: contract(selected.sources[1]) },
  ];
  const sameOwner = composeAssessment({ resolution: selected, contracts, usageInventory: { filesScanned: 1, usages: [usage('usage:override', 'source:one', 'packages/app/src/a.tsx', 'Save')], unsupported: [], coverage: { status: 'scoped', sourceFiles: {}, jsxSites: 1, recognizedUsages: 1, unsupportedCount: 0, limitations: [] } } });
  assert.deepEqual(sameOwner.decisionsRequired[0].candidateOwners, ['@team/ui'], 'later scoped rule overrides global rule and inactive root file');
  const mixedOwners = composeAssessment({ resolution: selected, contracts, usageInventory: { filesScanned: 2, usages: [
    usage('usage:scoped', 'source:one', 'packages/app/src/a.tsx', 'Save'),
    usage('usage:global', 'source:one', 'outside.tsx', 'Cancel'),
  ], unsupported: [], coverage: { status: 'scoped', sourceFiles: {}, jsxSites: 2, recognizedUsages: 2, unsupportedCount: 0, limitations: [] } } });
  assert.equal(mixedOwners.mappingGroups[0].count, 2);
  assert.deepEqual(mixedOwners.decisionsRequired[0].candidateOwners, [], 'one grouped decision cannot guess between owners from different files');
});

test('unsupported patterns in the active CODEOWNERS file suppress fallback owner guesses and remain visible', () => {
  const selected = resolution();
  selected.repository.codeowners.find((item) => item.file === '.github/CODEOWNERS').rules.push({ pattern: '/packages/**', owners: ['@feature'], line: 4 });
  const component = { id: 'proposal:component', kind: 'component-rename', source: { export: 'Button' }, target: { export: 'ActionButton' }, basis: 'documentation-explicit', reason: 'documented', status: 'needs-review', executable: false, evidence: [] };
  const assessment = composeAssessment({ resolution: selected, contracts: [
    { sourceId: 'source:one', file: 'contracts/source:one.json', contract: contract(selected.sources[0], [component]) },
    { sourceId: 'source:two', file: 'contracts/source:two.json', contract: contract(selected.sources[1]) },
  ], usageInventory: { filesScanned: 1, usages: [usage('usage:unsupported-owner', 'source:one', 'packages/app/src/a.tsx', 'Save')], unsupported: [], coverage: { status: 'scoped', sourceFiles: {}, jsxSites: 1, recognizedUsages: 1, unsupportedCount: 0, limitations: [] } } });
  assert.deepEqual(assessment.decisionsRequired[0].candidateOwners, []);
  assert.ok(assessment.repository.coverage.unsupported.some((item) => item.kind === 'codeowners-pattern'));
});

test('a later supported CODEOWNERS match resolves earlier glob uncertainty while invalid syntax is ignored', () => {
  const selected = resolution();
  const active = selected.repository.codeowners.find((item) => item.file === '.github/CODEOWNERS');
  active.rules = [
    { pattern: '/packages/**', owners: ['@unknown-glob'], line: 1 },
    { pattern: '/packages/app/', owners: ['@admin'], line: 2 },
    { pattern: '![invalid]', owners: ['@invalid'], line: 3 },
  ];
  const component = { id: 'proposal:component', kind: 'component-rename', source: { export: 'Button' }, target: { export: 'ActionButton' }, basis: 'documentation-explicit', reason: 'documented', status: 'needs-review', executable: false, evidence: [] };
  const assessment = composeAssessment({ resolution: selected, contracts: [
    { sourceId: 'source:one', file: 'contracts/source:one.json', contract: contract(selected.sources[0], [component]) },
    { sourceId: 'source:two', file: 'contracts/source:two.json', contract: contract(selected.sources[1]) },
  ], usageInventory: { filesScanned: 1, usages: [usage('usage:later-owner', 'source:one', 'packages/app/src/a.tsx', 'Save')], unsupported: [], coverage: { status: 'scoped', sourceFiles: {}, jsxSites: 1, recognizedUsages: 1, unsupportedCount: 0, limitations: [] } } });
  assert.deepEqual(assessment.decisionsRequired[0].candidateOwners, ['@admin']);
  assert.ok(assessment.repository.coverage.unsupported.filter((item) => item.kind === 'codeowners-pattern').length >= 2);
});

test('worker accepts only exact two-phase requests and redacts operational failures', async () => {
  const resolveRequest = { protocolVersion: 1, requestId, method: 'resolve-assessment', params: { repo: '/repo', sources: ['@old/one'], target: '@new/ui' } };
  assert.deepEqual(validateAssessmentWorkerRequest(resolveRequest), resolveRequest);
  const resolveResult = { schemaVersion: 1, kind: 'assessment-resolution', digest: sha };
  const successful = await handleAssessmentWorkerText(JSON.stringify(resolveRequest), { env: {}, resolve: async () => resolveResult });
  assert.deepEqual(successful.envelope.result, resolveResult);
  const assessRequest = { protocolVersion: 1, requestId, method: 'assess', params: { repo: '/repo', sources: ['@old/one'], target: '@new/ui', compiler: '/tools/typescript.js', expectedResolutionDigest: sha } };
  const secret = '/customers/acme/private/token';
  const failed = await handleAssessmentWorkerText(JSON.stringify(assessRequest), { env: {}, assess: async () => { throw new Error(secret); } });
  assert.deepEqual(failed.envelope.error, { code: 'assessment-failed', message: 'Assessment failed' });
  assert.equal(JSON.stringify(failed).includes(secret), false);
  for (const invalid of [
    { ...resolveRequest, extra: true },
    { ...resolveRequest, params: { ...resolveRequest.params, sources: [] } },
    { ...assessRequest, params: { ...assessRequest.params, expectedResolutionDigest: 'BAD' } },
  ]) {
    const outcome = await handleAssessmentWorkerText(JSON.stringify(invalid), { env: {}, resolve: async () => assert.fail(), assess: async () => assert.fail() });
    assert.equal(outcome.envelope.error.code, 'invalid-request');
  }
});

test('worker refuses inherited NODE_OPTIONS and malformed JSON', async () => {
  const request = { protocolVersion: 1, requestId, method: 'resolve-assessment', params: { repo: '/repo', sources: ['@old/one'], target: '@new/ui' } };
  const unsafe = await handleAssessmentWorkerText(JSON.stringify(request), { env: { NODE_OPTIONS: '--inspect' }, resolve: async () => assert.fail() });
  assert.equal(unsafe.envelope.error.code, 'unsafe-environment');
  const malformed = await handleAssessmentWorkerText('{');
  assert.equal(malformed.envelope.requestId, null);
  assert.equal(malformed.envelope.error.code, 'invalid-json');
});

test('worker subprocess emits one LF-framed redacted envelope and no stdout progress', async () => {
  const request = { protocolVersion: 1, requestId, method: 'resolve-assessment', params: { repo: '/private/customer/does-not-exist', sources: ['@old/one'], target: '@new/ui' } };
  const result = await new Promise((resolve) => {
    const environment = { ...process.env }; delete environment.NODE_OPTIONS;
    const child = spawn(process.execPath, ['src/assessment-worker.mjs'], { cwd: path.resolve(import.meta.dirname, '../..'), env: environment });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr })); child.stdin.end(JSON.stringify(request));
  });
  assert.equal(result.code, 1);
  assert.equal(result.stdout.split('\n').length, 2);
  const envelope = JSON.parse(result.stdout);
  assert.deepEqual(envelope.error, { code: 'resolution-failed', message: 'Assessment resolution failed' });
  assert.equal((result.stdout + result.stderr).includes('/private/customer'), false);
  assert.match(result.stderr, /^ctrl\+shift assessment worker: resolution-failed:/);
});

test('two installed workspace systems resolve and produce one portable read-only assessment', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ctrl-shift-assess-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (file, value) => {
    const absolute = path.join(root, file); await fs.mkdir(path.dirname(absolute), { recursive: true }); await fs.writeFile(absolute, value);
  };
  await write('package.json', JSON.stringify({ name: 'consumer-root', private: true, workspaces: ['packages/*'], scripts: { test: 'node -e "throw new Error(\'must not run\')"' } }));
  for (const [directory, name, version, declaration, migration] of [
    ['old-one', '@old/one', '1.0.0', `export declare function Button(props: { variant?: 'content' | 'plain'; label?: string }): unknown;`, 'ActionButton replaces Button.'],
    ['old-two', '@old/two', '4.0.0', `export declare function Button(props: { variant?: 'content' | 'plain'; label?: string }): unknown;`, 'ActionButton replaces Button.'],
    ['new-ui', '@new/ui', '5.0.0', `export declare function ActionButton(props: { emphasis?: 'default' | 'plain'; children?: string }): unknown;`, ''],
  ]) {
    await write(`packages/${directory}/package.json`, JSON.stringify({ name, version, types: 'index.d.ts' }));
    await write(`packages/${directory}/index.d.ts`, declaration);
    if (migration) await write(`packages/${directory}/MIGRATION.md`, migration);
  }
  await write('packages/app/package.json', JSON.stringify({ name: '@consumer/app', version: '1.0.0', dependencies: { '@old/one': 'workspace:*', '@old/two': 'workspace:*', '@new/ui': 'workspace:*' } }));
  await write('packages/app/src/view.tsx', `import { Button as One } from '@old/one'; import { Button as Two } from '@old/two'; export const View = () => <><One variant="content" label="Save" /><Two variant="plain" label="Cancel" /></>;`);
  await write('.github/CODEOWNERS', '/packages/app/ @team/app\n');
  const selectors = { repo: root, sources: ['@old/one', '@old/two'], target: '@new/ui' };
  const before = await resolveAssessment(selectors);
  const compiler = path.resolve('node_modules/typescript/lib/typescript.js');
  const result = await assessConsumer({ ...selectors, compiler, expectedResolutionDigest: before.digest });
  assert.equal(result.kind, 'assessment-result');
  assert.equal(result.contracts.length, 2);
  assert.equal(result.assessment.sources.length, 2);
  assert.equal(result.assessment.usageInventory.usages.length, 2);
  assert.equal(result.assessment.mappingGroups.length, 2);
  assert.ok(result.assessment.decisionsRequired.every((item) => item.status === 'needs-review'));
  assert.ok(result.assessment.verificationCandidates.some((item) => item.status === 'declared-not-run'));
  assert.ok(result.assessment.verificationCandidates.some((item) => item.status === 'missing'));
  assert.equal(JSON.stringify(result.assessment).includes(root), false);
  const after = await resolveAssessment(selectors);
  assert.equal(after.digest, before.digest, 'assessment does not mutate repository inputs');
});
