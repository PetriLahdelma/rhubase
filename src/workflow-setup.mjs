import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { demand, writeJson } from './files.mjs';
import { loadWorkflowConfig } from './workflow-config.mjs';
import { loadCompiler } from './source-analysis.mjs';
import { resolveImage } from './sandbox.mjs';
import { runProcess } from './process.mjs';
import { validateRecipe } from './recipes.mjs';
import { validateSourceRules } from './source-analysis.mjs';
import { treeSnapshot, resolveOutputRoot } from './workflow-files.mjs';
import { validateAgentContext } from './workflow-agent.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function initializeConfig({ out, preset = 'demo', project, recipe, compiler, toolchain, output }) {
  demand(out, 'init needs --out <new-config.json>');
  const file = path.resolve(out);
  let config;
  if (project) {
    demand(recipe, 'init --project needs an explicitly reviewed --recipe file');
    config = { schemaVersion: 1, name: 'design-system-migration', project: path.resolve(project), recipes: [path.resolve(recipe)], checks: [{ id: 'syntax', kind: 'syntax', required: true }] };
  } else if (preset === 'demo') {
    config = {
      schemaVersion: 1, name: 'react-consolidation', project: path.join(packageRoot, 'examples/react-consolidation'),
      recipes: [path.join(packageRoot, 'examples/react-consolidation/recipe.json')],
      checks: [{ id: 'syntax', kind: 'syntax', required: true }, { id: 'browser', kind: 'browser-demo', required: true, image: 'ghcr.io/browserless/chromium:v2.38.2' }],
    };
  } else if (preset === 'superset' || preset === 'superset-agent') {
    const source = path.join(packageRoot, 'experiments/superset-dropdown');
    config = {
      schemaVersion: 1, name: preset, project: path.join(source, 'input'),
      recipes: preset === 'superset' ? [path.join(packageRoot, 'recipes/superset-dropdown.json')] : [],
      references: [path.join(source, 'reference')],
      sources: [{ module: 'react-bootstrap', exports: ['DropdownButton'] }],
      checks: [{ id: 'syntax', kind: 'syntax', required: true }, { id: 'migration-contract', kind: 'superset-source', required: true }],
    };
    if (preset === 'superset-agent') config.agent = { enabled: true, goalFile: path.join(source, 'task.md'), budgetUsd: 3, timeoutMs: 180000 };
  } else throw new Error(`Unknown preset: ${preset}`);
  const proposedOutput = path.join(path.dirname(file), 'shift-runs');
  const inSource = proposedOutput === config.project || proposedOutput.startsWith(config.project + path.sep);
  const defaultOutput = inSource ? path.join(path.dirname(config.project), `.shift-runs-${path.basename(config.project)}`) : proposedOutput;
  config.output = path.resolve(output ?? defaultOutput);
  config.git = true;
  if (compiler) config.compiler = path.resolve(compiler);
  if (toolchain) config.toolchain = path.resolve(toolchain);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeJson(file, config);
  return { configFile: file, next: `shift-ds doctor --config ${file}`, agentEnabled: !!config.agent?.enabled };
}

export async function doctorWorkflow(configFile, overrides = {}) {
  const config = configFile ? await loadWorkflowConfig(configFile, overrides) : null;
  const checks = [{ name: 'Node', status: Number(process.versions.node.split('.')[0]) >= 22 ? 'available' : 'missing', detail: process.version }];
  async function probe(name, operation, hint) {
    try { checks.push({ name, status: 'available', detail: await operation() }); }
    catch (error) { checks.push({ name, status: 'missing', detail: error.message, hint }); }
  }
  if (config) await probe('Migration inputs', async () => {
    for (const file of config.recipeFiles) validateRecipe(JSON.parse(await fs.readFile(file, 'utf8')));
    if (config.sources.length) validateSourceRules({ schemaVersion: 1, sources: config.sources });
    const source = await treeSnapshot(config.project);
    const referenceSnapshots = await Promise.all(config.references.map((reference) => treeSnapshot(reference)));
    if (config.agent) validateAgentContext(source, referenceSnapshots, config.agent.goal);
    await resolveOutputRoot(config.output, [config.project, ...config.references]);
    return { sourceFiles: Object.keys(source.files).length, recipes: config.recipeFiles.length, excluded: source.excluded };
  }, 'Fix the declared recipe/source/reference paths or move output outside source/reference roots.');
  await probe('TypeScript compiler', async () => (await loadCompiler(config?.compiler ?? overrides.compiler ?? process.env.SHIFT_TYPESCRIPT_PATH)).identity,
    'Supply --compiler /absolute/path/to/typescript/lib/typescript.js or SHIFT_TYPESCRIPT_PATH (tested 5.9.x). No compiler is installed automatically.');
  if (!config || config.git) await probe('Git', async () => {
    const result = await runProcess('git', ['--version']); demand(result.code === 0, result.stderr || 'git not found'); return result.stdout.trim();
  }, 'Install Git or explicitly configure git:false for patch-only output.');
  for (const image of new Set((config?.checks ?? []).filter((c) => c.image).map((c) => c.image))) await probe(`Docker image ${image}`, () => resolveImage(image), 'Start Docker and provide the declared local image. Shift will not pull it.');
  if (config?.checks.some((c) => c.kind === 'browser-demo')) await probe('Browser build toolchain', async () => {
    demand(config.toolchain, 'Explicit toolchain required');
    await fs.access(config.toolchain.esbuildPath);
    const versions = {};
    for (const name of ['esbuild', 'react', 'react-dom']) versions[name] = JSON.parse(await fs.readFile(path.join(config.toolchain.nodeModules, name, 'package.json'), 'utf8')).version;
    return versions;
  }, 'Supply --toolchain /absolute/path/to/existing/node_modules or SHIFT_TOOLCHAIN with esbuild, React and ReactDOM.');
  if (config?.agent) await probe('Claude CLI', async () => {
    const result = await runProcess('claude', ['--version'], { timeoutMs: 10000 }); demand(result.code === 0, 'Claude CLI not available'); return result.stdout.trim() + '; authentication is checked when the agent runs';
  }, 'Use an installed, authenticated Claude CLI. Deterministic configurations do not need it.');
  return { ready: checks.every((c) => c.status === 'available'), checks, configuredAgent: !!config?.agent };
}
