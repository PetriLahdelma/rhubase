import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAssessmentFixture, treeDigest, sentinelText } from './fixture.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const worker = path.join(repository, 'src/assessment-worker.mjs');
const compiler = process.env.SHIFT_TYPESCRIPT_PATH;
let sequence = 0;

function call(method, params) {
  const requestId = (++sequence).toString(16).padStart(64, '0');
  const request = { protocolVersion: 1, requestId, method, params };
  const result = spawnSync(process.execPath, [worker], { input: JSON.stringify(request), encoding: 'utf8', cwd: repository, maxBuffer: 32 * 1024 * 1024, timeout: 20000 });
  assert.ok([0, 1].includes(result.status), result.stderr); if (result.status === 0) assert.equal(result.stderr, ''); else { assert.ok(result.stderr.length < 1024); assert.doesNotMatch(result.stderr, /\/private\/|packages\//); }
  assert.match(result.stdout, /^[^\r\n]+\n$/);
  const envelope = JSON.parse(result.stdout); assert.equal(envelope.protocolVersion, 1); assert.equal(envelope.requestId, requestId); return { process: result, envelope };
}

function resolve(root, sources = ['@legacy/a', '@legacy/b'], target = '@target/ui') {
  return call('resolve-assessment', { repo: root, sources, target });
}

function assess(root, resolution, sources = ['@legacy/a', '@legacy/b'], target = '@target/ui') {
  return call('assess', { repo: root, sources, target, compiler, expectedResolutionDigest: resolution.digest });
}

function validateEvidence(root, evidence) {
  assert.ok(Array.isArray(evidence) && evidence.length > 0);
  for (const item of evidence) {
    assert.equal(item.scope, 'consumer'); assert.equal(path.isAbsolute(item.file), false); assert.doesNotMatch(item.file, /\.\.|^\//);
    const content = requireText(path.join(root, item.file)); assert.equal(createHash('sha256').update(content).digest('hex'), item.sha256);
    const lines = content.split(/\r?\n/); assert.ok(item.startLine >= 1 && item.endLine >= item.startLine && item.endLine <= lines.length);
    assert.ok(lines.slice(item.startLine - 1, item.endLine).join('\n').includes(item.quote));
  }
}

function requireText(file) { return readFileSync(file, 'utf8'); }

test('two-source workspace assessment discovers exact qualified usages and explicit unknowns', async (t) => {
  assert.ok(compiler && path.isAbsolute(compiler)); const fixture = await createAssessmentFixture(t); const before = await treeDigest(fixture.root);
  const resolved = resolve(fixture.root); assert.equal(resolved.process.status, 0, resolved.process.stderr); assert.equal(resolved.envelope.ok, true);
  const resolution = resolved.envelope.result; assert.equal(resolution.kind, 'assessment-resolution'); assert.equal(resolution.sources.length, 2); assert.ok(resolution.sources.every((item) => path.isAbsolute(item.root))); assert.equal(path.isAbsolute(resolution.target.root), true);
  const completed = assess(fixture.root, resolution); assert.equal(completed.process.status, 0, completed.process.stderr); assert.equal(completed.envelope.ok, true);
  const result = completed.envelope.result; assert.equal(result.kind, 'assessment-result'); assert.equal(result.resolutionDigest, resolution.digest); assert.equal(result.contracts.length, 2);
  const assessment = result.assessment;
  assert.deepEqual(Object.keys(assessment).sort(), ['decisionsRequired', 'executable', 'kind', 'limitations', 'mappingGroups', 'repository', 'schemaVersion', 'sources', 'status', 'target', 'usageInventory', 'verificationCandidates'].sort());
  assert.equal(assessment.schemaVersion, 1); assert.equal(assessment.kind, 'consumer-migration-assessment'); assert.equal(assessment.status, 'draft-review'); assert.equal(assessment.executable, false);
  assert.equal(JSON.stringify(assessment).includes(fixture.root), false); assert.equal(JSON.stringify(assessment).includes(sentinelText), false);
  assert.deepEqual(assessment.sources.map((item) => item.importName).sort(), fixture.expected.selectedSources);
  assert.ok(assessment.sources.every((item) => item.contractFile === `contracts/${item.id}.json` && !item.contractFile.includes('..')));
  for (const item of assessment.sources) assert.deepEqual(Object.keys(item).sort(), ['contractFile', 'id', 'identity', 'importName', 'resolution']);
  assert.equal(assessment.target.identity.name, '@target/ui'); assert.equal(assessment.target.identity.version, '3.0.0');

  const inventory = assessment.usageInventory; assert.equal(inventory.usages.length, fixture.expected.directUsages); assert.equal(inventory.coverage.recognizedUsages, fixture.expected.directUsages); assert.equal(inventory.coverage.status, 'partial');
  assert.ok(inventory.coverage.unsupportedCount >= 5); assert.ok(inventory.unsupported.length >= 5);
  const styleGap = inventory.unsupported.find((item) => item.file === 'packages/app/src/App.tsx' && item.kind === 'non-jsx-reference' && item.evidence?.some((entry) => entry.quote.includes("import '@legacy/a/styles'")));
  assert.ok(styleGap, 'selected-system bare side-effect/style import must remain an evidenced unknown'); validateEvidence(fixture.root, styleGap.evidence);
  const files = inventory.usages.reduce((counts, item) => { counts[item.file] = (counts[item.file] ?? 0) + 1; return counts; }, {});
  assert.equal(files['packages/app/src/App.tsx'], fixture.expected.appUsages); assert.equal(files['packages/app/src/admin/Page.tsx'], 1); assert.equal(files['packages/app/src/shared/Item.tsx'], 1); assert.equal(files['packages/app/src/conflict.tsx'], 1);
  assert.equal(inventory.usages.some((item) => item.file.includes('packages/legacy-')), false); assert.equal(inventory.usages.some((item) => item.module === '@unrelated/ui'), false);
  assert.ok(inventory.usages.some((item) => item.module === '@legacy/a/default' && item.export === './default#default'));
  assert.ok(inventory.usages.some((item) => item.module === '@legacy/b' && item.export === 'Nav'));
  assert.ok(inventory.usages.some((item) => item.file.endsWith('App.tsx') && item.export === 'Button' && item.hasSpread));
  for (const usage of inventory.usages) {
    assert.deepEqual(Object.keys(usage).sort(), ['column', 'consumerPackage', 'end', 'evidence', 'export', 'file', 'hasSpread', 'id', 'line', 'module', 'props', 'sourceId', 'start']);
    validateEvidence(fixture.root, usage.evidence);
  }

  const hasLiteral = (group, name, value) => Array.isArray(group.condition.literalProps)
    ? group.condition.literalProps.some((item) => item.name === name && item.value === value)
    : group.condition.literalProps?.[name] === value;
  const primaryGroups = assessment.mappingGroups.filter((group) => group.export === 'Button' && hasLiteral(group, 'variant', 'primary'));
  assert.equal(primaryGroups.length, 1); assert.equal(primaryGroups[0].count, 2); assert.equal(primaryGroups[0].usageIds.length, 2); assert.doesNotMatch(JSON.stringify(primaryGroups[0].condition), /One|Two/);
  const groupedUsageIds = assessment.mappingGroups.flatMap((group) => group.usageIds).sort(); assert.deepEqual(groupedUsageIds, inventory.usages.map((item) => item.id).sort());
  assert.ok(assessment.mappingGroups.some((group) => group.condition.hasSpread && group.route === 'decision-required'));
  assert.ok(assessment.mappingGroups.every((group) => group.count === group.usageIds.length));
  for (const group of assessment.mappingGroups) {
    const required = ['candidateOwners', 'condition', 'contractChangeIds', 'count', 'evidence', 'export', 'id', 'proposalIds', 'route', 'sourceId', 'target', 'usageIds'];
    const allowed = new Set([...required, 'candidateTargets', 'reviewRequired', 'representative']);
    assert.ok(required.every((key) => Object.hasOwn(group, key))); assert.ok(Object.keys(group).every((key) => allowed.has(key)), `unknown group fields: ${Object.keys(group).filter((key) => !allowed.has(key))}`);
    assert.deepEqual(Object.keys(group.condition).sort(), ['dynamicProps', 'hasSpread', 'literalProps', 'presentProps']);
    if (group.reviewRequired !== undefined) assert.equal(group.reviewRequired, true);
    if (group.representative) assert.deepEqual(Object.keys(group.representative).sort(), ['column', 'file', 'line']);
    if (group.candidateTargets) assert.ok(Array.isArray(group.candidateTargets));
    assert.ok(['mapping-to-review', 'decision-required', 'unsupported'].includes(group.route)); assert.ok(group.target === null || typeof group.target === 'object'); validateEvidence(fixture.root, group.evidence);
    const usageById = new Map(inventory.usages.map((usage) => [usage.id, usage]));
    assert.deepEqual(group.evidence, group.usageIds.flatMap((id) => usageById.get(id).evidence), 'group evidence must follow usageIds exactly');
  }

  for (const decision of assessment.decisionsRequired) {
    assert.deepEqual(Object.keys(decision).sort(), ['candidateOwners', 'groupId', 'id', 'kind', 'ownerStatus', 'preconditions', 'reason', 'requiredChecks', 'status', 'usageIds']);
    assert.equal(decision.status, 'needs-review'); assert.ok(decision.reason); assert.ok(decision.preconditions.length >= 0); assert.ok(Array.isArray(decision.requiredChecks)); assert.ok(['candidate', 'unassigned'].includes(decision.ownerStatus));
  }
  const adminUsage = inventory.usages.find((item) => item.file.includes('/admin/')); const adminDecision = assessment.decisionsRequired.find((item) => item.usageIds.includes(adminUsage.id)); assert.deepEqual(adminDecision.candidateOwners, ['@admin-team']); assert.equal(adminDecision.ownerStatus, 'candidate');
  const conflictUsage = inventory.usages.find((item) => item.file.endsWith('conflict.tsx')); const conflictDecision = assessment.decisionsRequired.find((item) => item.usageIds.includes(conflictUsage.id)); assert.deepEqual(conflictDecision.candidateOwners, []); assert.equal(conflictDecision.ownerStatus, 'unassigned');

  const verification = JSON.stringify(assessment.verificationCandidates); assert.match(verification, /test:e2e|typecheck|lint/); assert.match(verification, /declared-not-run|missing/); assert.doesNotMatch(verification, /writeFileSync|SECRET_TOKEN|npm test/);
  for (const item of assessment.verificationCandidates) assert.deepEqual(Object.keys(item).sort(), ['category', ...(item.manifest === undefined ? [] : ['manifest']), ...(item.script === undefined ? [] : ['script']), ...(item.ciFile === undefined ? [] : ['ciFile']), 'status'].sort());
  assert.equal(await treeDigest(fixture.root), before); await assert.rejects(fs.lstat(fixture.marker), { code: 'ENOENT' });
});

test('assessment is deterministic and resolution drift fails with a redacted error', async (t) => {
  const fixture = await createAssessmentFixture(t); const firstResolution = resolve(fixture.root).envelope.result;
  const one = assess(fixture.root, firstResolution); const two = assess(fixture.root, firstResolution);
  assert.deepEqual(two.envelope.result, one.envelope.result);
  await fs.appendFile(path.join(fixture.root, 'packages/legacy-a/index.d.ts'), '\nexport declare const drift: true;\n');
  const drift = assess(fixture.root, firstResolution); assert.equal(drift.process.status, 1); assert.equal(drift.envelope.ok, false); assert.equal(drift.envelope.error.code, 'assessment-failed'); assert.equal(drift.envelope.error.message, 'Assessment failed'); assert.doesNotMatch(JSON.stringify(drift.envelope), /drift|index\.d\.ts|packages/);
  await assert.rejects(fs.lstat(fixture.marker), { code: 'ENOENT' });
});

test('installed and explicit local target selectors resolve without snapshot copying', async (t) => {
  const fixture = await createAssessmentFixture(t);
  const installed = resolve(fixture.root, ['@legacy/a'], '@installed/target'); assert.equal(installed.envelope.ok, true); assert.equal(installed.envelope.result.target.identity.name, '@installed/target');
  const explicit = resolve(fixture.root, ['@legacy/a'], './packages/target'); assert.equal(explicit.envelope.ok, true); assert.equal(explicit.envelope.result.target.identity.name, '@target/ui');
  assert.equal(path.isAbsolute(explicit.envelope.result.target.root), true);
});

test('missing remote-like targets and cross-manifest version ambiguity fail closed', async (t) => {
  const fixture = await createAssessmentFixture(t);
  for (const target of ['@missing/ui', '@missing/ui@9.0.0']) {
    const missing = resolve(fixture.root, ['@legacy/a'], target); assert.equal(missing.process.status, 1); assert.equal(missing.envelope.ok, false); assert.equal(missing.envelope.error.code, 'resolution-failed'); assert.equal(missing.envelope.error.message, 'Assessment resolution failed'); assert.doesNotMatch(JSON.stringify(missing.envelope), /https?:|registry|ENOENT/);
  }
  await fs.mkdir(path.join(fixture.root, 'node_modules/@legacy/a'), { recursive: true });
  await fs.writeFile(path.join(fixture.root, 'node_modules/@legacy/a/package.json'), '{"name":"@legacy/a","version":"9.0.0","types":"index.d.ts"}');
  await fs.writeFile(path.join(fixture.root, 'node_modules/@legacy/a/index.d.ts'), 'export declare const incompatible: true;\n');
  const ambiguous = resolve(fixture.root, ['@legacy/a'], '@target/ui'); assert.equal(ambiguous.process.status, 1); assert.equal(ambiguous.envelope.error.code, 'resolution-failed');
});

test('package-root symlink escaping the repository is rejected', async (t) => {
  const fixture = await createAssessmentFixture(t); const outside = await fs.mkdtemp(path.join(path.dirname(fixture.root), 'outside-package-')); t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, 'package.json'), '{"name":"@escape/ui","version":"1.0.0","types":"index.d.ts"}'); await fs.writeFile(path.join(outside, 'index.d.ts'), 'export declare const escape: true;\n');
  const link = path.join(fixture.root, 'node_modules/@escape/ui'); await fs.mkdir(path.dirname(link), { recursive: true });
  try { await fs.symlink(outside, link, 'dir'); } catch (error) { if (error.code === 'EPERM') return t.skip('symlinks unavailable'); throw error; }
  const result = resolve(fixture.root, ['@legacy/a'], '@escape/ui'); assert.equal(result.process.status, 1); assert.equal(result.envelope.error.code, 'resolution-failed');
});
