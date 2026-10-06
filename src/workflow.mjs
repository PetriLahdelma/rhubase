import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { demand, jsonDigest, readJson } from './files.mjs';
import { loadCompiler, inspectContents, validateSourceRules } from './source-analysis.mjs';
import { validateRecipe, recipeSourceRules, transformSources } from './recipes.mjs';
import { loadWorkflowConfig } from './workflow-config.mjs';
import { treeSnapshot, copyTree, ensureOutputRoot, readSources, artifactSnapshot, fileDigest } from './workflow-files.mjs';
import { generateAgentCandidate, agentToolIdentity, validateAgentContext } from './workflow-agent.mjs';
import { runWorkflowChecks } from './workflow-checks.mjs';
import { sourceGitState, initializeReviewRepository, commitReviewCandidate } from './workflow-git.mjs';
import { unifiedPatch } from './patch.mjs';
import { isProtectedSourceFile } from './migration-policy.mjs';

const moduleRoot = path.dirname(fileURLToPath(import.meta.url));
const save = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n');
const protectedSource = isProtectedSourceFile;

function sourceRules(recipes, explicit) {
  const modules = new Map();
  for (const source of [...recipes.flatMap((r) => recipeSourceRules(r).sources), ...explicit]) {
    const names = modules.get(source.module) ?? new Set();
    source.exports.forEach((name) => names.add(name)); modules.set(source.module, names);
  }
  return validateSourceRules({ schemaVersion: 1, sources: [...modules].map(([module, names]) => ({ module, exports: [...names] })) });
}

async function fileOrigin(file) {
  const canonical = await fs.realpath(file);
  demand((await fs.lstat(canonical)).isFile(), `Not a file: ${file}`);
  return { path: canonical, sha256: await fileDigest(canonical) };
}

async function toolOrigins(compiler, toolchain) {
  const files = [compiler];
  for (const file of await fs.readdir(moduleRoot)) if (file.endsWith('.mjs')) files.push(path.join(moduleRoot, file));
  files.push(path.resolve(moduleRoot, '../scripts/evaluate-source-case.mjs'), path.resolve(moduleRoot, '../scripts/browser-demo.mjs'));
  if (toolchain) files.push(toolchain.esbuildPath, ...['react', 'react-dom', 'esbuild'].map((name) => path.join(toolchain.nodeModules, name, 'package.json')));
  return Promise.all(files.map(fileOrigin));
}

function summarize({ config, inventory, finalInventory, outcomes, blockers, edits, checks, agent, error }) {
  const required = checks.filter((c) => c.required);
  const allPassed = required.length > 0 && required.every((c) => c.candidate.status === 'passed' && ['passed', 'not-applicable'].includes(c.baseline.status));
  const runtime = required.some((c) => ['browser', 'runtime-tests'].includes(c.candidate.scope) && c.candidate.status === 'passed');
  const readiness = error ? 'failed' : !allPassed ? 'verification-failed' : blockers.length ? 'needs-review' : runtime ? 'ready-for-review' : 'needs-runtime-validation';
  const deterministic = outcomes.filter((u) => u.status === 'transformed').length;
  const unchanged = outcomes.filter((u) => u.status === 'unchanged' && u.reasonCode === 'already-satisfied').length;
  const discovered = inventory?.usages.length ?? 0;
  return {
    name: config.name, readiness,
    counts: { discovered, deterministic, unchanged, initiallyUnresolved: discovered - deterministic - unchanged,
      unsupportedReferences: inventory?.unsupported.filter((u) => u.kind !== 'local-import').length ?? 0,
      blocked: blockers.length, remainingSourceUsages: (finalInventory?.usages.length ?? 0) - (finalInventory?.alreadySatisfiedIds?.length ?? 0), selectedSourceReferences: finalInventory?.usages.length ?? 0, changedFiles: edits.length,
      agentChangedFiles: agent?.changedFiles.length ?? 0 },
    countDefinitions: 'Initial direct usages = deterministic edits + already-satisfied usages + initially unresolved usages. Unsupported references are separate. Final blockers and remaining selected-source references are final-state observations, not additional initial usages. Agent edits are counted by files, not assumed-correct usages.',
    blockers, contextWarnings: inventory?.unsupported.filter((u) => u.kind === 'local-import') ?? [],
    checks: checks.map((c) => ({ id: c.id, kind: c.kind, required: c.required, scope: c.candidate.scope, baseline: c.baseline.status, candidate: c.candidate.status })),
    agent: agent ? { provider: agent.provider, changedFiles: agent.changedFiles, reportedCostUsd: agent.reportedCostUsd, durationMs: agent.durationMs } : null,
    error: error ?? null,
    scope: 'Non-test source files in the configured directory, reviewed recipes, and declared checks. Generated/secret paths and test files are excluded from transformation; wrapper resolution is limited. Ready for review is not merge approval or proof of complete behavioral equivalence.',
    runtimeScope: runtime ? 'Runtime evidence applies only to the configured verifier and its scenarios.' : 'No required runtime/browser check has passed. Static checks alone do not verify application behavior.',
  };
}

function renderReport(summary, review) {
  const escape = (text) => String(text).replaceAll('|', '\\|').replaceAll('\n', ' ');
  return [
    `# Shift migration — ${summary.name}`, '', `Status: **${summary.readiness}**`, '',
    `${summary.counts.discovered} discovered direct usages; ${summary.counts.changedFiles} changed files; ${summary.counts.blocked} final blockers.`, '',
    `Initial direct usages: ${summary.counts.deterministic} deterministic + ${summary.counts.unchanged} already satisfied + ${summary.counts.initiallyUnresolved} unresolved. Separate unsupported references: ${summary.counts.unsupportedReferences}.`, '',
    summary.countDefinitions, '',
    '[Review patch](changes.patch) · [Machine report](report.json) · [Draft PR body](PR.md)', '',
    review ? `Local review branch: \`${review.branch}\` in \`candidate/\` (base: \`baseline\`). No source refs changed and nothing was pushed.` : 'Candidate source is in `candidate/`. No external publication occurred.', '',
    '## Verification', '', '| Check | Scope | Required | Baseline | Candidate |', '| --- | --- | --- | --- | --- |',
    ...summary.checks.map((c) => `| ${escape(c.id)} | ${c.scope} | ${c.required} | ${c.baseline} | ${c.candidate} |`), '',
    summary.runtimeScope, '', '## Review work', '',
    ...(summary.blockers.length ? summary.blockers.map((b) => `- ${escape(b.file ?? '')}:${b.line ?? ''} — ${escape(b.reason ?? b.detail ?? 'Unresolved source reference')}`) : ['No blocking matched usages remain in the declared scope.']), '',
    ...(summary.contextWarnings.length ? ['Unresolved local helper imports (outside direct-import discovery):', ...summary.contextWarnings.map((w) => `- ${escape(w.file)}:${w.line} — ${escape(w.detail)}`), ''] : []),
    ...(summary.error ? ['## Failure', '', escape(summary.error), ''] : []),
    '## Evidence boundary', '', summary.scope, '',
    summary.agent ? `Agent: ${summary.agent.provider}; reported list-price usage ${summary.agent.reportedCostUsd ?? 'unknown'} USD. This is not a billing or savings claim.` : 'Deterministic run: no model calls.', '',
    'Input, recipe, tool, output, logs and report hashes are recorded in manifest.json. Run `shift-ds status --run <directory>` before relying on this result.', '',
  ].join('\n');
}

function prBody(summary) {
  return [
    `# Migrate ${summary.name}`, '', `${summary.counts.changedFiles} files changed from reviewed design-system decisions.`, '',
    `Readiness: **${summary.readiness}**. ${summary.counts.blocked} blocking items.`, '',
    '## Verification', '', ...summary.checks.map((c) => `- ${c.id} (${c.scope}): baseline ${c.baseline}; candidate ${c.candidate}.`), '',
    summary.runtimeScope, '', '## Reviewer checklist', '',
    '- [ ] Review the generated patch and unresolved source-context warnings.',
    '- [ ] Confirm the declared checks cover this application’s affected behavior.',
    '- [ ] Approve the migration through normal repository review.', '',
    'This is a draft PR body. Shift has not pushed a branch, opened a remote PR, or merged changes.', '',
  ].join('\n');
}

export async function runWorkflow(configFile, options = {}) {
  const config = await loadWorkflowConfig(configFile, options);
  const { ts, identity: compilerIdentity } = await loadCompiler(config.compiler);
  const recipes = await Promise.all(config.recipeFiles.map(async (file) => validateRecipe(await readJson(file))));
  const rules = sourceRules(recipes, config.sources);
  const input = await treeSnapshot(config.project);
  const originalGit = await sourceGitState(config.project);
  const references = await Promise.all(config.references.map(async (ref) => ({ path: ref, snapshot: await treeSnapshot(ref) })));
  if (config.agent) validateAgentContext(input, references.map((r) => r.snapshot), config.agent.goal);
  const agentIdentity = config.agent ? await agentToolIdentity() : null;
  const origins = {
    config: await fileOrigin(config.file), recipes: await Promise.all(config.recipeFiles.map(fileOrigin)),
    references: references.map((r) => ({ path: r.path, digest: r.snapshot.digest })),
    source: { path: await fs.realpath(config.project), digest: input.digest, git: originalGit },
    tools: await toolOrigins(config.compiler, config.toolchain),
    goal: config.agent ? await fileOrigin(config.agent.goalFile) : null,
    agentTool: agentIdentity,
  };
  const outputRoot = await ensureOutputRoot(config.output, [config.project, ...config.references]);
  const runDirectory = await fs.mkdtemp(path.join(outputRoot, config.name + '-'));
  const baseline = path.join(runDirectory, 'baseline'); const candidate = path.join(runDirectory, 'candidate');
  const onProgress = (stage, detail) => options.onProgress?.(stage, detail);
  let sequence = 0;
  const event = async (stage, detail = '') => { onProgress(stage, detail); await fs.appendFile(path.join(runDirectory, 'events.jsonl'), JSON.stringify({ sequence: ++sequence, stage, detail, time: new Date().toISOString() }) + '\n'); };
  let inventory = null; let finalInventory = null; let outcomes = []; let blockers = []; let edits = []; let checks = []; let agent = null; let review = null; let error = null;
  try {
    await event('snapshot', config.project);
    await save(path.join(runDirectory, 'config.json'), config.raw);
    await save(path.join(runDirectory, 'tools.json'), { compiler: compilerIdentity, files: origins.tools, node: process.version });
    await save(path.join(runDirectory, 'recipes.json'), recipes);
    await copyTree(config.project, baseline, input); await copyTree(config.project, candidate, input);
    for (const [index, reference] of references.entries()) await copyTree(reference.path, path.join(runDirectory, 'references', String(index)), reference.snapshot);
    if (config.agent) await fs.writeFile(path.join(runDirectory, 'goal.md'), config.agent.goal);
    const allSources = await readSources(baseline, input);
    const sources = new Map([...allSources].filter(([file]) => !protectedSource(file)));
    inventory = inspectContents(ts, sources, rules);
    demand(inventory.syntaxDiagnostics.length === 0, 'Source contains syntax errors; no edits applied');
    await save(path.join(runDirectory, 'inventory.json'), { ...inventory, inputHash: input.digest, excluded: input.excluded, protectedSourceFiles: [...allSources.keys()].filter(protectedSource) });
    await event('transform', `${inventory.usages.length} matched usages`);
    const combined = recipes.length ? { schemaVersion: 1, id: config.name, rules: recipes.flatMap((r) => r.rules.map((rule) => ({ ...rule, id: `${r.id}/${rule.id}` }))) } : null;
    if (combined) {
      const transformed = transformSources(ts, sources, combined);
      outcomes = transformed.outcomes; blockers = transformed.blockers;
      for (const edit of transformed.edits) await fs.writeFile(path.join(candidate, edit.file), edit.after);
    }
    await save(path.join(runDirectory, 'transformations.json'), { outcomes, blockers });
    if (config.agent) {
      await event('agent', `Budget ${config.agent.budgetUsd} USD; file tools only`);
      const allowedFiles = new Set([...inventory.usages.map((u) => u.file), ...inventory.unsupported.filter((u) => u.kind !== 'local-import').map((u) => u.file), ...config.agent.extraFiles]);
      agent = await generateAgentCandidate({ candidate, references, ...config.agent, runDirectory, allowedFiles, toolIdentity: agentIdentity, signal: options.signal });
      await save(path.join(runDirectory, 'agent.json'), agent);
    }
    demand(!options.signal?.aborted, 'Run cancelled');
    const candidateSnapshot = await treeSnapshot(candidate);
    const finalSources = new Map([...(await readSources(candidate, candidateSnapshot))].filter(([file]) => !protectedSource(file)));
    finalInventory = inspectContents(ts, finalSources, rules);
    if (combined) {
      const probe = transformSources(ts, finalSources, combined);
      const satisfied = new Set(probe.outcomes.filter((u) => u.reasonCode === 'already-satisfied').map((u) => u.id));
      finalInventory.alreadySatisfiedIds = [...satisfied];
      blockers = [...probe.blockers];
      for (const usage of finalInventory.usages) {
        if (!satisfied.has(usage.id) && !blockers.some((b) => b.id === usage.id)) blockers.push({ ...usage, reason: 'Selected source usage has no reviewed mapping' });
      }
      demand(probe.edits.length === 0, 'Generated candidate is not idempotent under the reviewed recipe');
    } else blockers = finalInventory.usages.map((u) => ({ ...u, reason: 'Source usage remains after the agent proposal' }));
    const unresolved = finalInventory.unsupported.filter((u) => u.kind !== 'local-import');
    blockers = [...blockers, ...unresolved.map((u) => ({ ...u, reason: u.detail }))];
    blockers = [...new Map(blockers.map((b) => [b.id ?? JSON.stringify([b.file, b.line, b.column, b.start, b.kind ?? 'reference', b.reason ?? b.detail]), b])).values()];
    for (const [file, info] of Object.entries(input.files)) {
      if (candidateSnapshot.files[file]?.sha256 === info.sha256) continue;
      demand(candidateSnapshot.files[file], 'Candidate removed an input file');
      edits.push({ file, before: await fs.readFile(path.join(baseline, file), 'utf8'), after: await fs.readFile(path.join(candidate, file), 'utf8') });
    }
    demand(Object.keys(candidateSnapshot.files).length === Object.keys(input.files).length, 'Candidate added files outside the approved scope');
    await fs.writeFile(path.join(runDirectory, 'changes.patch'), unifiedPatch(edits));
    await save(path.join(runDirectory, 'candidate-inventory.json'), finalInventory);
    checks = await runWorkflowChecks({ config, ts, compiler: config.compiler, baseline, candidate, runDirectory, signal: options.signal, onProgress });
    demand(!options.signal?.aborted, 'Run cancelled');
    await save(path.join(runDirectory, 'checks.json'), checks);
    if (config.git) {
      await event('review-branch', 'Creating local candidate history');
      try {
        for (const edit of edits) await fs.writeFile(path.join(candidate, edit.file), edit.before);
        await initializeReviewRepository(candidate);
      } finally { for (const edit of edits) await fs.writeFile(path.join(candidate, edit.file), edit.after); }
      review = await commitReviewCandidate(candidate, `${config.name}-${randomUUID().slice(0, 8)}`);
    }
    demand((await treeSnapshot(config.project)).digest === input.digest, 'Source tree changed during execution');
    demand(jsonDigest(await sourceGitState(config.project)) === jsonDigest(originalGit), 'Source Git refs changed during execution');
  } catch (failure) {
    error = failure.message;
    await event('failed', error);
    await save(path.join(runDirectory, 'failure.json'), { message: error, cancelled: !!options.signal?.aborted });
  }
  const summary = summarize({ config, inventory, finalInventory, outcomes, blockers, edits, checks, agent, error });
  summary.review = review;
  try {
    await save(path.join(runDirectory, 'report.json'), summary);
    await fs.writeFile(path.join(runDirectory, 'report.md'), renderReport(summary, review));
    await fs.writeFile(path.join(runDirectory, 'PR.md'), prBody(summary));
    await event('sealed', summary.readiness);
    const artifacts = await artifactSnapshot(runDirectory);
    const body = { schemaVersion: 1, runId: path.basename(runDirectory), createdAt: new Date().toISOString(), origins, artifacts, summary, review };
    await save(path.join(runDirectory, 'manifest.json'), { ...body, rootDigest: jsonDigest(body) });
  } catch (failure) {
    summary.readiness = 'failed'; summary.error = `Evidence sealing failed: ${failure.message}`;
    const diagnostics = [];
    for (const [name, content] of [
      ['failure.json', JSON.stringify({ message: summary.error, cancelled: !!options.signal?.aborted, sealed: false }, null, 2)],
      ['report.json', JSON.stringify(summary, null, 2)], ['report.md', renderReport(summary, review)],
    ]) {
      try { await fs.writeFile(path.join(runDirectory, name), content); }
      catch (writeFailure) { diagnostics.push(`${name}: ${writeFailure.message}`); }
    }
    if (diagnostics.length) summary.error += `; diagnostics could not be persisted: ${diagnostics.join('; ')}`;
    return { runDirectory, summary, exitCode: 1 };
  }
  return { runDirectory, summary, exitCode: error ? 1 : ['verification-failed', 'needs-review'].includes(summary.readiness) ? 2 : 0 };
}

export async function inspectWorkflow(runDirectory) {
  runDirectory = await fs.realpath(runDirectory);
  const manifest = await readJson(path.join(runDirectory, 'manifest.json'), 50_000_000);
  const { rootDigest, ...body } = manifest;
  demand(manifest.schemaVersion === 1 && jsonDigest(body) === rootDigest, 'Manifest integrity failure');
  const current = await artifactSnapshot(runDirectory);
  demand(current.digest === manifest.artifacts.digest, 'Run artifacts changed; result is stale or tampered');
  const origins = manifest.origins;
  for (const item of [origins.config, ...origins.recipes, ...origins.tools, ...(origins.goal ? [origins.goal] : []), ...(origins.agentTool ? [origins.agentTool] : [])]) {
    demand((await fileOrigin(item.path)).sha256 === item.sha256, `Original input/tool changed: ${item.path}`);
  }
  for (const ref of [...origins.references, origins.source]) demand((await treeSnapshot(ref.path)).digest === ref.digest, `Original source/reference changed: ${ref.path}`);
  demand(jsonDigest(await sourceGitState(origins.source.path)) === jsonDigest(origins.source.git), 'Original source refs changed');
  if (manifest.review) {
    const currentGit = await sourceGitState(path.join(runDirectory, 'candidate'));
    demand(currentGit.head === manifest.review.head && currentGit.branch === manifest.review.branch && currentGit.refs === manifest.review.refs, 'Candidate review ref changed');
  }
  return manifest.summary;
}
