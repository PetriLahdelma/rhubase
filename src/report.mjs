import * as fs from 'node:fs/promises';
import path from 'node:path';
import { demand, digest, readJson, safePath } from './files.mjs';
import { inspectRun } from './run.mjs';

const cell = (value) => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');

export async function buildReport(dir) {
  const { run, plan, contract, dir: canonical } = await inspectRun(dir);
  let evidence = null;
  try { evidence = await readJson(path.join(canonical, 'verification.json')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (evidence) {
    demand(evidence.runId === run.runId && evidence.planHash === run.planHash
      && evidence.contractHash === run.contractHash && evidence.baselineHash === run.baseline.digest
      && evidence.candidateHash === run.candidate.digest, 'Verification provenance mismatch');
    demand(evidence.checks.length === contract.checks.length, 'Incomplete verification record');
    for (const check of contract.checks) {
      const item = evidence.checks.find((e) => e.id === check.id);
      demand(item?.oracleSha256 === check.sha256, 'Verification oracle mismatch');
      for (const phase of ['baseline', 'candidate']) {
        const log = await safePath(canonical, item[phase].log);
        demand(digest(await fs.readFile(log)) === item[phase].logSha256, 'Verification log changed');
      }
    }
  }
  const counts = { registered: plan.usages.length, changed: 0, alreadyApplied: 0, blocked: 0, targetGap: 0, unsupported: 0 };
  const stateKey = { planned: 'changed', 'already-applied': 'alreadyApplied', blocked: 'blocked', 'target-gap': 'targetGap', unsupported: 'unsupported' };
  for (const usage of plan.usages) counts[stateKey[usage.status]]++;
  demand(Object.entries(counts).filter(([key]) => key !== 'registered').reduce((n, [, value]) => n + value, 0) === counts.registered, 'Usage counts do not reconcile');
  const requiredChecks = contract.requiredChecks.map((id) => ({
    id, baseline: evidence?.checks.find((c) => c.id === id)?.baseline.status ?? 'not-configured',
    candidate: evidence?.checks.find((c) => c.id === id)?.candidate.status ?? 'not-configured',
  }));
  // Intentionally no production-ready state: a manually enumerated synthetic
  // case cannot establish discovery completeness or real migration correctness.
  const blockers = plan.usages.filter((u) => !['planned', 'already-applied'].includes(u.status)).map((u) => ({ id: u.id, reason: u.reason ?? 'Unit decision or prerequisite is pending', owner: u.owner ?? 'Contract owner' }));
  const checksPass = requiredChecks.every((c) => c.baseline === 'passed' && c.candidate === 'passed');
  return {
    schemaVersion: 1, runId: run.runId, caseId: run.caseId, kind: run.kind,
    readiness: 'unvalidated-prototype',
    fixtureResult: !checksPass ? 'verification-incomplete-or-failed' : blockers.length ? 'partial-with-blockers' : 'checks-passed',
    counts, blockers, requiredChecks, changes: run.changes,
    inputHash: run.baseline.digest, candidateHash: run.candidate.digest,
    contractHash: run.contractHash, image: evidence?.image ?? null, engine: run.engine,
    patchSha256: run.patchSha256,
    inventory: contract.inventory,
    baselineComparison: 'not-run', cost: { inferenceCalls: 0, inferenceCost: 0, humanMinutes: null },
    limitations: [
      'Manually enumerated usage sites and hand-authored exact-file edits; no automatic semantic discovery or AI migration.',
      'Controlled behavior descriptors only, not React/browser behavior, visual regression, or accessibility validation.',
      'No customer evidence, measured time savings, independent maintainer review, or vanilla-AI comparison.',
      'No general resume, hostile-code oracle integrity guarantee, or dependency retirement proof.',
    ],
  };
}

export function markdown(report) {
  const { counts } = report;
  return [
    '# Shift controlled consolidation report', '',
    `Case: ${report.caseId}. Result: **${report.fixtureResult}**. Readiness: **${report.readiness}**.`, '',
    'This is an engineering fixture, not evidence of product accuracy or customer value.', '',
    '## Registered usage accounting', '',
    '| Registered | Changed | Already applied | Decision blocked | Target gaps | Unsupported |',
    '| --- | --- | --- | --- | --- | --- |',
    `| ${counts.registered} | ${counts.changed} | ${counts.alreadyApplied} | ${counts.blocked} | ${counts.targetGap} | ${counts.unsupported} |`, '',
    `Inventory: ${report.inventory.kind}. ${report.inventory.limitations}`, '',
    '## Required checks', '', '| Check | Baseline | Candidate |', '| --- | --- | --- |',
    ...report.requiredChecks.map((c) => `| ${cell(c.id)} | ${cell(c.baseline)} | ${cell(c.candidate)} |`), '',
    '## Remaining work', '',
    ...(report.blockers.length ? report.blockers.map((b) => `- ${cell(b.id)}: ${cell(b.reason)}. Owner: ${cell(b.owner)}.`) : ['No unresolved registered usages. Discovery completeness remains unproven.']), '',
    '## Applied units', '', '[Review the exact patch](changes.patch). Original and candidate trees are retained beside this report.', '',
    ...report.changes.map((c) => `- ${cell(c.unit)}: ${cell(c.file)} (${c.beforeSha256.slice(0, 12)} → ${c.afterSha256.slice(0, 12)}).`), '',
    '## Provenance', '',
    `- Input: ${report.inputHash}`, `- Candidate: ${report.candidateHash}`,
    `- Contract: ${report.contractHash}`, `- Container: ${report.image ?? 'not run'}`,
    `- Engine: ${report.engine.sourceHash} (${report.engine.runtime})`, '',
    '## Limits', '', ...report.limitations.map((l) => `- ${l}`), '',
    'Vanilla-AI baseline: not run. Human time: not measured. Inference calls: 0.', '',
  ].join('\n');
}

export async function writeReport(dir) {
  const report = await buildReport(dir);
  // Reports are derived views. Refuse symlink destinations when refreshing them.
  for (const [name, content] of [['report.json', JSON.stringify(report, null, 2) + '\n'], ['report.md', markdown(report)]]) {
    const file = path.join(dir, name);
    try { demand((await fs.lstat(file)).isFile(), 'Unsafe report destination'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.writeFile(file, content);
  }
  return report;
}
