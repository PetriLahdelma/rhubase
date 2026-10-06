import * as fs from 'node:fs/promises';
import path from 'node:path';
import { demand, readJson, digest, relativePath } from './files.mjs';
import { isProtectedSourceFile } from './migration-policy.mjs';
import { validateSourceRules } from './source-analysis.mjs';

const kinds = new Set(['syntax', 'superset-source', 'docker', 'browser-demo']);
const identifier = (value) => typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value);
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
function keys(object, allowed, label) {
  demand(object && typeof object === 'object' && !Array.isArray(object), `${label} must be an object`);
  for (const key of Object.keys(object)) demand(allowed.includes(key), `Unknown ${label} field: ${key}`);
}

export async function loadWorkflowConfig(file, overrides = {}) {
  file = path.resolve(file);
  const raw = await readJson(file);
  keys(raw, ['schemaVersion', 'name', 'project', 'output', 'compiler', 'recipes', 'sources', 'references', 'checks', 'agent', 'git', 'toolchain'], 'config');
  demand(raw.schemaVersion === 1 && identifier(raw.name), 'Config needs schemaVersion 1 and a lowercase name');
  demand(nonempty(raw.project), 'Config needs project source directory');
  const resolve = (value) => path.resolve(path.dirname(file), value);
  const project = resolve(raw.project);
  demand((await fs.lstat(project)).isDirectory(), 'Project source directory not found');
  if (raw.sources !== undefined) {
    demand(Array.isArray(raw.sources), 'sources must be an array');
    if (raw.sources.length) validateSourceRules({ schemaVersion: 1, sources: raw.sources });
  }
  demand(Array.isArray(raw.recipes ?? []), 'recipes must be an array');
  const recipeFiles = (raw.recipes ?? []).map((value) => { demand(nonempty(value), 'Recipe paths must be strings'); return resolve(value); });
  demand(Array.isArray(raw.references ?? []), 'references must be an array');
  const references = (raw.references ?? []).map((value) => { demand(nonempty(value), 'Reference paths must be strings'); return resolve(value); });
  for (const ref of references) demand((await fs.lstat(ref)).isDirectory(), 'Each reference must be a directory');
  if (raw.git !== undefined) demand(typeof raw.git === 'boolean', 'git must be boolean');
  const checks = raw.checks ?? [{ id: 'syntax', kind: 'syntax', required: true }];
  demand(Array.isArray(checks) && checks.length > 0, 'At least one verification check required');
  const seen = new Set();
  for (const check of checks) {
    keys(check, ['id', 'kind', 'required', 'image', 'command', 'timeoutMs', 'expectedTests', 'retainedUnresolved'], 'check');
    demand(identifier(check.id) && !seen.has(check.id), 'Check IDs must be unique lowercase names'); seen.add(check.id);
    demand(check.id !== 'shift-syntax' || check.kind === 'syntax', 'shift-syntax is reserved for the mandatory parser check');
    demand(kinds.has(check.kind), `Unknown check adapter: ${check.kind}`);
    if (['syntax', 'superset-source'].includes(check.kind)) demand(!['image', 'command', 'timeoutMs', 'expectedTests', 'retainedUnresolved'].some((key) => key in check), 'Source check adapter does not accept container command/budget fields');
    if (check.kind === 'browser-demo') demand(!('command' in check) && !('expectedTests' in check), 'browser-demo uses its fixed browser oracle, not a custom test command');
    demand(typeof check.required === 'boolean', 'Each check needs explicit required: true/false');
    if (check.retainedUnresolved !== undefined) demand(check.kind === 'browser-demo' && typeof check.retainedUnresolved === 'boolean', 'retainedUnresolved is a browser-demo boolean');
    if (['docker', 'browser-demo'].includes(check.kind)) demand(nonempty(check.image), 'Container checks require an explicit local image');
    if (check.timeoutMs !== undefined) demand(Number.isInteger(check.timeoutMs) && check.timeoutMs >= 100 && check.timeoutMs <= 300000, 'Check timeout must be 100..300000 ms');
    if (check.kind === 'docker') {
      demand(Array.isArray(check.command) && check.command.length && check.command.every((x) => nonempty(x) && !x.includes('\0')), 'Docker check command must be a nonempty argument array');
      demand(Number.isInteger(check.expectedTests) && check.expectedTests > 0, 'Docker checks require an expected Node TAP test count');
    }
  }
  demand(checks.some((c) => c.required), 'At least one check must be required');
  let agent = null;
  if (raw.agent !== undefined && raw.agent !== false) {
    keys(raw.agent, ['enabled', 'goalFile', 'budgetUsd', 'timeoutMs', 'extraFiles'], 'agent');
    demand(typeof raw.agent.enabled === 'boolean', 'agent.enabled must be explicit');
    if (raw.agent.enabled) {
      demand(nonempty(raw.agent.goalFile), 'Agent requires a goalFile');
      demand(typeof raw.agent.budgetUsd === 'number' && raw.agent.budgetUsd > 0 && raw.agent.budgetUsd <= 25, 'Agent budget must be >0 and <=25 USD');
      demand(Number.isInteger(raw.agent.timeoutMs) && raw.agent.timeoutMs >= 1000 && raw.agent.timeoutMs <= 300000, 'Agent timeout must be 1000..300000 ms');
      const goalFile = resolve(raw.agent.goalFile);
      const content = await fs.readFile(goalFile, 'utf8');
      demand(content.trim() && content.length < 100000, 'Goal file is empty or too large');
      demand(Array.isArray(raw.agent.extraFiles ?? []), 'Agent extraFiles must be an explicit path array');
      (raw.agent.extraFiles ?? []).forEach(relativePath);
      demand((raw.agent.extraFiles ?? []).every((file) => !isProtectedSourceFile(file)), 'Agent extraFiles cannot include tests, stories, or configuration');
      agent = { ...raw.agent, goalFile, goal: content, goalHash: digest(content), extraFiles: raw.agent.extraFiles ?? [] };
    }
  }
  demand(recipeFiles.length || agent, 'Configure recipes, an enabled agent, or both');
  if (!recipeFiles.length) demand(Array.isArray(raw.sources) && raw.sources.length, 'Agent-only runs require explicit source module/export rules');
  const selectedToolchain = overrides.toolchain ?? raw.toolchain ?? process.env.SHIFT_TOOLCHAIN;
  let toolchain;
  if (selectedToolchain) {
    if (typeof selectedToolchain === 'string') {
      const nodeModules = resolve(selectedToolchain);
      toolchain = { nodeModules, esbuildPath: path.join(nodeModules, 'esbuild/lib/main.js') };
    } else {
      keys(selectedToolchain, ['nodeModules', 'esbuildPath'], 'toolchain');
      demand(nonempty(selectedToolchain.nodeModules) && nonempty(selectedToolchain.esbuildPath), 'Toolchain requires nodeModules and esbuildPath');
      toolchain = { nodeModules: resolve(selectedToolchain.nodeModules), esbuildPath: resolve(selectedToolchain.esbuildPath) };
    }
  }
  return {
    file, raw, name: raw.name, project, output: resolve(overrides.output ?? raw.output ?? '.shift-runs'),
    compiler: overrides.compiler ?? (raw.compiler ? resolve(raw.compiler) : process.env.SHIFT_TYPESCRIPT_PATH),
    toolchain,
    recipeFiles, references, checks, agent, sources: raw.sources ?? [], git: raw.git !== false,
  };
}
