import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

// Tests use explicit environment tools or the local config created by `init`.
// They never search other projects, install tooling, or silently skip suites.
const settings = {};
try {
  const config = JSON.parse(await fs.readFile('.shift/working-react.json', 'utf8'));
  settings.compiler = config.compiler;
  settings.toolchain = config.toolchain;
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const env = { ...process.env };
env.SHIFT_TYPESCRIPT_PATH ??= settings.compiler;
const configuredModules = typeof settings.toolchain === 'string' ? settings.toolchain : settings.toolchain?.nodeModules;
env.SHIFT_REACT_NODE_MODULES ??= env.SHIFT_TOOLCHAIN ?? configuredModules;
env.SHIFT_ESBUILD_PATH ??= (typeof settings.toolchain === 'object' ? settings.toolchain.esbuildPath : undefined)
  ?? (env.SHIFT_REACT_NODE_MODULES ? path.join(env.SHIFT_REACT_NODE_MODULES, 'esbuild/lib/main.js') : undefined);
if (!env.SHIFT_TYPESCRIPT_PATH || !env.SHIFT_REACT_NODE_MODULES || !env.SHIFT_ESBUILD_PATH) {
  console.error('Full suite needs SHIFT_TYPESCRIPT_PATH and SHIFT_TOOLCHAIN (existing node_modules with React/esbuild), or an initialized .shift/working-react.json. No tests were skipped.');
  process.exitCode = 1;
} else {
  const files = (await fs.readdir('tests', { recursive: true })).filter((file) => file.endsWith('.test.mjs') && !file.startsWith('probes/')).map((file) => path.join('tests', file)).sort();
  const child = spawn(process.execPath, ['--test', ...files], { env, stdio: 'inherit', shell: false });
  child.once('error', (error) => { console.error(error.message); process.exitCode = 1; });
  child.once('close', (code) => { process.exitCode = code ?? 1; });
}
