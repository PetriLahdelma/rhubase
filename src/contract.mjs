import * as fs from 'node:fs/promises';
import path from 'node:path';
import { demand, digest, jsonDigest, readJson, relativePath, safePath, snapshot } from './files.mjs';

const list = (x) => Array.isArray(x) && x.length > 0;
const id = (x) => typeof x === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(x);
const text = (x) => typeof x === 'string' && x.trim().length > 0;
const hash = (x) => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);

function unique(items, label) {
  demand(new Set(items.map((item) => item.id)).size === items.length, `Duplicate ${label} IDs`);
}

export function validateContract(c) {
  demand(c.schemaVersion === 1 && id(c.id), 'Invalid case identity/schema');
  demand(c.kind === 'controlled-fixture', 'Only controlled-fixture cases are executable in this spike');
  relativePath(c.consumer);
  demand(list(c.sources) && c.sources.length >= 2 && c.sources.every(text), 'Two or more source systems required');
  demand(text(c.target) && !c.sources.includes(c.target), 'A distinct target is required');
  demand(c.inventory?.kind === 'manual' && text(c.inventory.limitations), 'Declare manual inventory limitations');
  demand(list(c.decisions) && list(c.units) && list(c.usages), 'Decisions, units and usages required');
  unique(c.decisions, 'decision'); unique(c.units, 'unit'); unique(c.usages, 'usage');
  for (const decision of c.decisions) {
    demand(id(decision.id) && ['approved', 'pending'].includes(decision.status), 'Invalid decision');
    demand(text(decision.owner) && text(decision.rationale), 'Decision owner and rationale required');
    demand(list(decision.invariants) && decision.invariants.every(text), 'Decision invariants required');
  }
  for (const unit of c.units) {
    demand(id(unit.id) && text(unit.summary), 'Invalid unit');
    demand(Array.isArray(unit.requires) && unit.requires.every((key) => c.units.some((u) => u.id === key)), 'Unknown unit prerequisite');
    demand(list(unit.decisions) && unit.decisions.every((key) => c.decisions.some((d) => d.id === key)), 'Unknown decision');
    demand(list(unit.edits), 'At least one exact edit per unit required');
    const edited = new Set();
    for (const edit of unit.edits) {
      relativePath(edit.file);
      demand(edit.file.startsWith('src/') && /\.(mjs|tsx|ts)$/.test(edit.file), 'Edits must be source files under src/');
      demand(!edited.has(edit.file), 'Combine same-file changes into one explicit replacement');
      edited.add(edit.file);
      demand(hash(edit.beforeSha256) && hash(edit.afterSha256) && text(edit.before) && text(edit.after), 'Edit requires exact content and hashes');
      demand(digest(edit.before) === edit.beforeSha256 && digest(edit.after) === edit.afterSha256, 'Edit hash/content mismatch');
      demand(edit.before !== edit.after, 'No-op edit not allowed');
    }
  }
  const paths = c.units.flatMap((u) => u.edits.map((e) => e.file));
  demand(new Set(paths).size === paths.length, 'Units cannot edit the same file; combine coupled edits');
  for (const usage of c.usages) {
    demand(id(usage.id) && c.sources.includes(usage.source), 'Invalid usage source');
    relativePath(usage.file);
    demand(text(usage.anchor), 'Usage requires a unique source anchor');
    demand(['mapped', 'target-gap', 'unsupported'].includes(usage.disposition), 'Invalid disposition');
    if (usage.disposition === 'mapped') {
      demand(c.units.some((u) => u.id === usage.unit && u.edits.some((e) => e.file === usage.file)), 'Mapped usage must reference an edit in its unit');
    } else demand(text(usage.reason) && text(usage.owner), 'Unresolved usage requires reason and owner');
  }
  for (const unit of c.units) demand(c.usages.some((u) => u.unit === unit.id), 'Unit has no registered usages');
  demand(list(c.requiredChecks) && c.requiredChecks.every(id), 'Required checks must be explicit');
  demand(new Set(c.requiredChecks).size === c.requiredChecks.length, 'Duplicate required checks');
  demand(Array.isArray(c.checks), 'Checks must be an array');
  unique(c.checks, 'check');
  for (const check of c.checks) {
    demand(id(check.id) && text(check.description), 'Invalid check');
    relativePath(check.oracle);
    demand(check.oracle.endsWith('.test.mjs') && hash(check.sha256), 'Checks require a pinned Node test oracle');
    demand(Number.isInteger(check.expectedTests) && check.expectedTests > 0, 'Expected assertion count required');
    demand(Number.isInteger(check.timeoutMs) && check.timeoutMs >= 100 && check.timeoutMs <= 60000, 'Check timeout must be 100..60000 ms');
  }
  topologicalUnits(c.units);
  return c;
}

export function topologicalUnits(units) {
  const result = []; const visiting = new Set(); const visited = new Set();
  function visit(unit) {
    if (visited.has(unit.id)) return;
    demand(!visiting.has(unit.id), 'Cyclic unit prerequisites');
    visiting.add(unit.id);
    for (const prerequisite of unit.requires) visit(units.find((u) => u.id === prerequisite));
    visiting.delete(unit.id); visited.add(unit.id); result.push(unit);
  }
  units.forEach(visit);
  return result;
}

export async function loadCase(file) {
  const caseFile = path.resolve(file);
  const c = validateContract(await readJson(caseFile));
  const base = await fs.realpath(path.dirname(caseFile));
  const consumer = await safePath(base, c.consumer);
  const input = await snapshot(consumer);
  const oracles = {};
  for (const check of c.checks) {
    const oracle = await safePath(base, check.oracle);
    demand(!oracle.startsWith(consumer + path.sep), 'Oracle must be outside the consumer tree');
    const content = await fs.readFile(oracle);
    demand(content.length <= 1_000_000 && digest(content) === check.sha256, `Oracle hash mismatch: ${check.id}`);
    oracles[check.id] = { file: oracle, sha256: check.sha256 };
  }
  for (const usage of c.usages) {
    demand(input.files[usage.file], `Missing usage file: ${usage.file}`);
  }
  return { caseFile, contract: c, contractHash: jsonDigest(c), consumer, input, oracles };
}

export async function createPlan(file) {
  const loaded = await loadCase(file);
  const { contract: c, consumer, input } = loaded;
  const units = [];
  for (const unit of topologicalUnits(c.units)) {
    const hashes = unit.edits.map((e) => input.files[e.file]?.sha256);
    const before = unit.edits.every((e, i) => hashes[i] === e.beforeSha256);
    const after = unit.edits.every((e, i) => hashes[i] === e.afterSha256);
    demand(before || after, `Stale or partially applied unit: ${unit.id}`);
    const pending = unit.decisions.filter((key) => c.decisions.find((d) => d.id === key).status !== 'approved');
    const blockedBy = unit.requires.filter((key) => units.find((u) => u.id === key).status === 'blocked');
    const status = pending.length || blockedBy.length ? 'blocked' : after ? 'already-applied' : 'planned';
    units.push({ id: unit.id, summary: unit.summary, status, pending, blockedBy });
  }
  const usages = [];
  for (const usage of c.usages) {
    const unit = units.find((u) => u.id === usage.unit);
    const content = await fs.readFile(await safePath(consumer, usage.file), 'utf8');
    // The inventory is manual. Validate source anchors, do not imply discovery.
    if (unit?.status !== 'already-applied') {
      demand(content.split(usage.anchor).length === 2, `Missing or ambiguous usage anchor: ${usage.id}`);
    }
    usages.push({ ...usage, status: unit ? unit.status : usage.disposition });
  }
  const payload = {
    schemaVersion: 1, caseFile: loaded.caseFile, caseId: c.id,
    kind: c.kind, contractHash: loaded.contractHash, input,
    inventory: c.inventory, units, usages,
  };
  return { ...payload, planHash: jsonDigest(payload) };
}

export async function validatePlan(plan) {
  const { planHash, ...payload } = plan;
  demand(jsonDigest(payload) === planHash, 'Plan was altered');
  const fresh = await createPlan(plan.caseFile);
  demand(fresh.planHash === planHash, 'Stale plan: consumer, contract or oracle changed; plan again');
  return loadCase(plan.caseFile);
}
