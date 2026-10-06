import { jsonDigest, demand, digest } from './files.mjs';
import { inventoryConsumerRepository, resolvePackageReference, validatePackageSelection, verifyConsumerInventory } from './consumer-discovery.mjs';
import { discoverConsumerUsages } from './consumer-usages.mjs';
import { extractSnapshot } from './snapshot-api.mjs';
import { compareSnapshots } from './inference.mjs';
import { loadCompiler } from './source-analysis.mjs';

const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const stableId = (kind, value) => `${kind}:${digest(JSON.stringify(value)).slice(0, 20)}`;
const semanticDiscriminators = new Set(['variant', 'type', 'as', 'role', 'tone', 'intent', 'emphasis', 'size', 'orientation', 'selected']);

function publicRepository(inventory) {
  const rootManifest = inventory.manifests.find((item) => item.file === 'package.json');
  const codeownersPreference = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];
  const activeCodeowners = inventory.codeowners.find((item) => item.active === true)
    ?? codeownersPreference.map((file) => inventory.codeowners.find((item) => item.file === file)).find(Boolean);
  const unsupportedOwners = (activeCodeowners?.rules ?? []).filter((rule) => {
    const pattern = rule.pattern.startsWith('/') ? rule.pattern.slice(1) : rule.pattern;
    return !pattern || pattern.startsWith('!') || /[?\[\]{}\\]/.test(pattern) || pattern.includes('**') || (pattern.includes('*') && !pattern.endsWith('*'));
  }).map((rule) => ({ kind: 'codeowners-pattern', file: activeCodeowners.file, reason: `CODEOWNERS line ${rule.line} is outside the bounded ownership-matching subset` }));
  return {
    ...(rootManifest?.name ? { name: rootManifest.name } : {}),
    digest: inventory.digest,
    packageManager: inventory.packageManager,
    workspaces: inventory.workspaces,
    manifests: inventory.manifests,
    declaredScripts: inventory.declaredScripts,
    ciEvidence: inventory.ciEvidence,
    codeowners: inventory.codeowners,
    coverage: { ...inventory.coverage, unsupported: [...inventory.coverage.unsupported, ...unsupportedOwners] },
  };
}

function resolutionDigest(repository, sources, target) {
  const packages = [...sources, target].map((item) => ({
    kind: item.kind, importName: item.importName, resolution: item.resolution, identity: item.identity, manifestSha256: item.manifestSha256,
  })).sort((left, right) => compareText(left.kind, right.kind) || compareText(left.importName, right.importName));
  return jsonDigest({ repository: { digest: repository.digest, files: repository.files.map(({ file, sha256, bytes, kind }) => ({ file, sha256, bytes, kind })) }, packages });
}

export async function resolveAssessment({ repo, sources, target }) {
  demand(typeof repo === 'string' && Array.isArray(sources) && sources.length > 0 && typeof target === 'string', 'Assessment resolution requires a repository, explicit sources, and target');
  demand(sources.every((item) => typeof item === 'string' && item) && new Set(sources).size === sources.length, 'Source selectors must be unique nonempty strings');
  const repository = await inventoryConsumerRepository(repo);
  const resolvedSources = [];
  for (const selector of sources) resolvedSources.push(await resolvePackageReference(repository, selector, 'source'));
  const resolvedTarget = await resolvePackageReference(repository, target, 'target');
  validatePackageSelection(resolvedSources, resolvedTarget);
  return {
    schemaVersion: 1,
    kind: 'assessment-resolution',
    digest: resolutionDigest(repository, resolvedSources, resolvedTarget),
    repository,
    sources: resolvedSources,
    target: resolvedTarget,
  };
}

function staticCondition(usage, contract) {
  const migrationValueProps = new Set([
    ...(contract?.changes ?? []).filter((item) => item.export === usage.export && item.prop && item.kind === 'prop-literals-changed').map((item) => item.prop),
    ...(contract?.proposals ?? []).filter((item) => item.source?.export === usage.export && item.source.prop && Object.hasOwn(item.source, 'value')).map((item) => item.source.prop),
  ]);
  for (const prop of usage.props) if (prop.kind === 'literal' && semanticDiscriminators.has(prop.name)) migrationValueProps.add(prop.name);
  const literalProps = usage.props.filter((item) => item.kind === 'literal' && migrationValueProps.has(item.name))
    .map(({ name, value }) => ({ name, value })).sort((left, right) => compareText(left.name, right.name));
  const presentProps = [...new Set(usage.props.filter((item) => item.kind !== 'spread').map((item) => item.name))].sort(compareText);
  const dynamicProps = [...new Set(usage.props.filter((item) => item.kind === 'expression').map((item) => item.name))].sort(compareText);
  return { literalProps, presentProps, hasSpread: usage.hasSpread === true, dynamicProps };
}

function coordinateMatches(reference, group) {
  if (!reference?.export || reference.export !== group.sourceExport) return false;
  if (!reference.prop) return true;
  if (!group.condition.presentProps.includes(reference.prop)) return false;
  const literal = group.condition.literalProps.find((item) => item.name === reference.prop);
  return !Object.hasOwn(reference, 'value') || (literal && JSON.stringify(literal.value) === JSON.stringify(reference.value));
}

function candidateTarget(proposal) {
  if (proposal.basis !== 'documentation-explicit') return [];
  return (proposal.targets ?? (proposal.target ? [proposal.target] : [])).filter((item) => item.export)
    .map((item) => ({ ...item }));
}

function matchCodeowners(file, codeowners) {
  const preference = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];
  const document = codeowners.find((item) => item.active === true)
    ?? preference.map((candidate) => codeowners.find((item) => item.file === candidate)).find(Boolean);
  if (!document) return [];
  let selected = null; let uncertain = false;
  for (const rule of document.rules) {
    const pattern = rule.pattern.startsWith('/') ? rule.pattern.slice(1) : rule.pattern;
    if (!pattern || pattern.startsWith('!') || /[\[\]\\]/.test(pattern)) continue;
    if (/[?{}]/.test(pattern) || pattern.includes('**') || (pattern.includes('*') && !pattern.endsWith('*'))) {
      selected = null; uncertain = true; continue;
    }
    let matches = false;
    if (pattern === '*') matches = true;
    else if (pattern.endsWith('/')) matches = file.startsWith(pattern);
    else if (pattern.endsWith('*')) {
      const prefix = pattern.slice(0, -1); const rest = file.startsWith(prefix) ? file.slice(prefix.length) : null;
      matches = rest !== null && !rest.includes('/');
    } else matches = file === pattern;
    if (matches) { selected = [...new Set(rule.owners)].sort(compareText); uncertain = false; }
  }
  return uncertain ? [] : selected ?? [];
}

function verificationCandidates(repository) {
  const scripts = repository.declaredScripts.map((item) => ({
    category: item.category, manifest: item.manifest, script: item.name, status: 'declared-not-run',
  }));
  const ci = repository.ciEvidence.map((item) => ({ category: 'ci', ciFile: item.file, status: 'declared-not-run' }));
  const candidates = [...scripts, ...ci];
  for (const category of ['test', 'build', 'quality', 'typecheck', 'storybook', 'ci']) if (!candidates.some((item) => item.category === category)) {
    candidates.push({ category, status: 'missing' });
  }
  return candidates.sort((left, right) => compareText(left.category, right.category) || compareText(left.manifest ?? left.ciFile ?? '', right.manifest ?? right.ciFile ?? '') || compareText(left.script ?? '', right.script ?? ''));
}

function groupUsages(usageInventory, contractsBySource, codeowners) {
  const grouped = new Map();
  for (const usage of usageInventory.usages) {
    const contract = contractsBySource.get(usage.sourceId);
    const sourceExport = usage.export;
    const condition = staticCondition(usage, contract);
    const key = JSON.stringify({ sourceId: usage.sourceId, export: sourceExport, condition });
    const current = grouped.get(key) ?? { sourceId: usage.sourceId, sourceExport, condition, usages: [] };
    current.usages.push(usage); grouped.set(key, current);
  }
  const groups = []; const decisions = [];
  for (const value of grouped.values()) {
    value.usages.sort((left, right) => compareText(left.file, right.file) || left.start - right.start);
    const contract = contractsBySource.get(value.sourceId);
    const changes = (contract?.changes ?? []).filter((item) => coordinateMatches({ export: item.export, ...(item.prop ? { prop: item.prop } : {}) }, value));
    const proposals = (contract?.proposals ?? []).filter((item) => coordinateMatches(item.source, value));
    const targets = proposals.flatMap(candidateTarget);
    const uniqueTargets = [...new Map(targets.map((item) => [JSON.stringify(item), item])).values()];
    const componentTargets = [...new Map(uniqueTargets.map((item) => [item.export, { export: item.export }])).values()];
    const proposalTargetsBySource = new Map();
    for (const proposal of proposals) {
      const sourceKey = JSON.stringify(proposal.source);
      const values = proposalTargetsBySource.get(sourceKey) ?? [];
      values.push(...candidateTarget(proposal)); proposalTargetsBySource.set(sourceKey, values);
    }
    const conflictingProposal = [...proposalTargetsBySource.values()].some((items) => new Set(items.map((item) => JSON.stringify(item))).size > 1);
    const hasDynamic = value.condition.hasSpread || value.condition.dynamicProps.length > 0;
    const singleTarget = componentTargets.length === 1 && !conflictingProposal;
    const route = hasDynamic || !singleTarget ? 'decision-required' : 'mapping-to-review';
    const groupId = stableId('group', { sourceId: value.sourceId, export: value.sourceExport, condition: value.condition });
    const usageIds = value.usages.map((item) => item.id);
    const candidateOwnerSets = value.usages.map((item) => matchCodeowners(item.file, codeowners));
    const candidateOwners = candidateOwnerSets.length && candidateOwnerSets.every((owners) => JSON.stringify(owners) === JSON.stringify(candidateOwnerSets[0])) ? candidateOwnerSets[0] : [];
    const groupEvidence = value.usages.flatMap((item) => item.evidence ?? []);
    const group = {
      id: groupId, sourceId: value.sourceId, export: value.sourceExport, condition: value.condition,
      usageIds, count: usageIds.length, route, reviewRequired: true,
      target: singleTarget ? componentTargets[0] : null,
      candidateTargets: uniqueTargets,
      contractChangeIds: changes.map((item) => item.id).sort(compareText),
      proposalIds: proposals.map((item) => item.id).sort(compareText),
      candidateOwners, evidence: groupEvidence,
      representative: { file: value.usages[0].file, line: value.usages[0].line, column: value.usages[0].column },
    };
    groups.push(group);
    const reason = value.condition.hasSpread
      ? 'Opaque JSX spreads require a human to establish the effective props before choosing a target.'
      : value.condition.dynamicProps.length
        ? 'Dynamic prop values require contextual review before a documented mapping can be reused.'
        : singleTarget
          ? 'A documentation-backed target applies to this static usage pattern and still requires human review.'
          : conflictingProposal || componentTargets.length > 1
            ? 'Documentation yields more than one possible target for this usage pattern.'
            : 'No single documentation-backed target is established for this selected source usage.';
    decisions.push({
      id: stableId('decision', { groupId, route, reason }), groupId,
      kind: route === 'mapping-to-review' ? 'review-documented-mapping' : 'choose-migration-target',
      reason, usageIds, candidateOwners,
      ownerStatus: candidateOwners.length ? 'candidate' : 'unassigned', status: 'needs-review',
      preconditions: [
        'Confirm the source usage intent and target behavior.',
        'Record an accountable owner before execution.',
        'The owner must define or confirm required verification before execution.',
      ],
      requiredChecks: [],
    });
  }
  groups.sort((left, right) => compareText(left.sourceId, right.sourceId) || compareText(left.sourceExport, right.sourceExport) || compareText(left.id, right.id));
  decisions.sort((left, right) => compareText(left.groupId, right.groupId));
  return { groups, decisions };
}

export function composeAssessment({ resolution, usageInventory, contracts }) {
  demand(resolution?.kind === 'assessment-resolution' && usageInventory?.coverage && Array.isArray(contracts), 'Assessment composition requires resolution, usage inventory, and contracts');
  const contractsBySource = new Map(contracts.map((item) => [item.sourceId, item.contract]));
  demand(contractsBySource.size === resolution.sources.length && resolution.sources.every((item) => contractsBySource.has(item.id)), 'Every selected source requires one migration contract');
  const repository = publicRepository(resolution.repository);
  const checks = verificationCandidates(repository);
  const { groups, decisions } = groupUsages(usageInventory, contractsBySource, repository.codeowners);
  const sources = resolution.sources.map((source) => {
    const contract = contractsBySource.get(source.id);
    return { id: source.id, importName: source.importName, resolution: source.resolution, identity: contract.from, contractFile: `contracts/${source.id}.json` };
  });
  const targetContract = contracts[0]?.contract;
  return {
    schemaVersion: 1, kind: 'consumer-migration-assessment', status: 'draft-review', executable: false,
    repository, target: { id: resolution.target.id, resolution: resolution.target.resolution, identity: targetContract.to },
    sources,
    usageInventory: {
      filesScanned: usageInventory.filesScanned,
      usages: usageInventory.usages.map(({ sourcePackage: _sourcePackage, ...usage }) => usage),
      unsupported: usageInventory.unsupported,
      coverage: usageInventory.coverage,
    },
    mappingGroups: groups,
    decisionsRequired: decisions,
    verificationCandidates: checks,
    limitations: [
      'This is a read-only draft for review; it does not authorize or execute application changes.',
      'Every selected-source usage requires a retirement decision even when package comparison reports no public API change.',
      'Documented targets are candidates, not proof of semantic, visual, runtime, or accessibility equivalence.',
      'Declared scripts and CI files were discovered as data and were not executed.',
      'Consumer discovery is scoped static analysis; unsupported references and coverage limits remain visible.',
      'Migration inference has not passed a fresh independent holdout and remains unproven.',
    ],
  };
}

export async function assessConsumer({ repo, sources, target, compiler, expectedResolutionDigest }) {
  const resolution = await resolveAssessment({ repo, sources, target });
  demand(resolution.digest === expectedResolutionDigest, 'Assessment resolution changed before analysis');
  const loaded = await loadCompiler(compiler);
  const targetSnapshot = await extractSnapshot(resolution.target.root, loaded.ts);
  const contracts = [];
  const sourceSnapshots = new Map();
  for (const source of resolution.sources) {
    const sourceSnapshot = await extractSnapshot(source.root, loaded.ts); sourceSnapshots.set(source.id, sourceSnapshot);
    contracts.push({ sourceId: source.id, file: `contracts/${source.id}.json`, contract: compareSnapshots(sourceSnapshot, targetSnapshot, loaded.identity) });
  }
  const usageInventory = await discoverConsumerUsages({ root: resolution.repository.root, inventory: resolution.repository, sourcePackages: resolution.sources, targetPackage: resolution.target, ts: loaded.ts });
  const assessment = composeAssessment({ resolution, usageInventory, contracts });
  demand(await verifyConsumerInventory(resolution.repository), 'Consumer repository changed during assessment');
  const finalTarget = await extractSnapshot(resolution.target.root, loaded.ts);
  demand(finalTarget.identity.digest === targetSnapshot.identity.digest, 'Target package changed during assessment');
  for (const source of resolution.sources) {
    const current = await extractSnapshot(source.root, loaded.ts);
    demand(current.identity.digest === sourceSnapshots.get(source.id).identity.digest, `Source package changed during assessment: ${source.importName}`);
  }
  const finalResolution = await resolveAssessment({ repo, sources, target });
  demand(finalResolution.digest === resolution.digest, 'Assessment resolution changed during analysis');
  return { schemaVersion: 1, kind: 'assessment-result', resolutionDigest: resolution.digest, assessment, contracts };
}
