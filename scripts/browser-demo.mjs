import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execute } from '../src/sandbox.mjs';
import { runProcess } from '../src/process.mjs';

const require = createRequire(import.meta.url);

function validateOptions({ project, phase, outputDir, toolchain, image, retainedUnresolved }) {
  if (!['baseline', 'candidate'].includes(phase)) throw new Error('Browser phase must be baseline or candidate');
  for (const [label, value] of Object.entries({ project, outputDir, image })) {
    if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is required`);
  }
  if (!path.isAbsolute(project) || !path.isAbsolute(outputDir)) throw new Error('project and outputDir must be absolute');
  const projectRelativeOutput = path.relative(project, outputDir);
  if (projectRelativeOutput === '' || (!projectRelativeOutput.startsWith(`..${path.sep}`) && projectRelativeOutput !== '..')) {
    throw new Error('Browser outputDir must be outside the source project');
  }
  if (!toolchain || !path.isAbsolute(toolchain.esbuildPath ?? '') || !path.isAbsolute(toolchain.nodeModules ?? '')) {
    throw new Error('Explicit absolute esbuildPath and nodeModules toolchain paths are required');
  }
  if (retainedUnresolved !== undefined && typeof retainedUnresolved !== 'boolean') throw new Error('retainedUnresolved must be boolean');
}

class CheckStopped extends Error {
  constructor(reason, stage) {
    super(`Browser verification ${reason} ${stage}`);
    this.reason = reason;
    this.stage = stage;
  }
}

function throwIfAborted(signal, reason, stage) {
  if (signal.aborted) throw new CheckStopped(reason(), stage);
}

function raceAbort(promise, signal, reason, stage) {
  if (signal.aborted) return Promise.reject(new CheckStopped(reason(), stage));
  let abort;
  const stopped = new Promise((_, reject) => {
    abort = () => reject(new CheckStopped(reason(), stage));
    signal.addEventListener('abort', abort, { once: true });
  });
  return Promise.race([promise, stopped]).finally(() => signal.removeEventListener('abort', abort));
}

async function cleanupBuildContext(context) {
  if (!context) return;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 5_000);
    (async () => { await context.cancel(); await context.dispose(); })()
      .catch(() => {})
      .finally(() => { clearTimeout(timer); resolve(); });
  });
}

function browserOracle(phase, retainedUnresolved = false) {
  const expectedSystem = phase === 'baseline' ? 'commerce' : 'foundation';
  const unresolvedAssertions = retainedUnresolved ? `
    const unresolved = page.getByTestId('unresolved-source');
    assert.equal(await unresolved.evaluate((node) => node.tagName), 'BUTTON', 'unresolved usage still renders as a button');
    assert.equal(await unresolved.getAttribute('type'), 'button', 'unresolved usage remains non-submit');
    await unresolved.click();
    assert.equal(await page.evaluate(() => document.body.dataset.unresolved), 'clicked', 'unresolved callback remains active');
    assert.equal(await page.getByTestId('submit-count').textContent(), '1', 'unresolved usage does not submit');` : '';
  const assertions = retainedUnresolved ? 17 : 13;
  return `'use strict';
const { chromium } = require('/usr/src/app/node_modules/playwright-core');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    await page.goto('file:///demo/index.html');
    await page.getByTestId('provider').waitFor();
    assert.equal(await page.getByTestId('provider').getAttribute('data-system'), ${JSON.stringify(expectedSystem)}, 'provider system');
    assert.equal(await page.getByTestId('submit-action').getAttribute('type'), 'submit', 'submit button type');
    await page.getByTestId('submit-action').click();
    assert.equal(await page.getByTestId('submit-count').textContent(), '1', 'form submits exactly once');
    assert.equal(await page.getByTestId('action-count').textContent(), '1', 'submit action callback fires');
    assert.equal(await page.getByTestId('admin-action').getAttribute('type'), 'button', 'action is non-submit');
    await page.getByTestId('admin-action').click();
    assert.equal(await page.getByTestId('submit-count').textContent(), '1', 'action does not submit');
    assert.equal(await page.getByTestId('action-count').textContent(), '2', 'action callback fires');
    assert.equal(await page.getByTestId('admin-toggle').getAttribute('aria-pressed'), 'false', 'toggle starts unpressed');
    await page.getByTestId('admin-toggle').click();
    assert.equal(await page.getByTestId('admin-toggle').getAttribute('aria-pressed'), 'true', 'toggle updates pressed state');
    assert.equal(await page.getByTestId('submit-count').textContent(), '1', 'toggle does not submit');
    const link = page.getByTestId('admin-link');
    assert.equal(await link.evaluate((node) => node.tagName), 'A', 'link keeps anchor semantics');
    assert.equal(await link.getAttribute('href'), '#destination', 'link keeps destination');
    await link.click();
    assert.equal(await page.evaluate(() => location.hash), '#destination', 'link navigation changes destination');
${unresolvedAssertions}
    process.stdout.write(JSON.stringify({ assertions: ${assertions}, phase: ${JSON.stringify(phase)}, provider: ${JSON.stringify(expectedSystem)}, retainedUnresolved: ${retainedUnresolved} }) + '\\n');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
`;
}

async function buildDemo({ project, outputDir, toolchain, phase, retainedUnresolved = false, signal, reason }) {
  throwIfAborted(signal, reason, 'before build');
  const esbuild = require(toolchain.esbuildPath);
  if (typeof esbuild.build !== 'function') throw new Error('Configured esbuildPath does not export build()');
  const reactPackage = JSON.parse(await fs.readFile(path.join(toolchain.nodeModules, 'react/package.json'), 'utf8'));
  const reactDomPackage = JSON.parse(await fs.readFile(path.join(toolchain.nodeModules, 'react-dom/package.json'), 'utf8'));
  await fs.mkdir(outputDir, { recursive: true });
  const buildOptions = {
    entryPoints: [path.join(project, 'src/index.jsx')],
    outfile: path.join(outputDir, 'app.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    nodePaths: [toolchain.nodeModules],
    plugins: [],
    write: true,
    logLevel: 'silent',
  };
  let context; let disposed = false;
  const dispose = async () => {
    if (!context || disposed) return;
    disposed = true;
    await cleanupBuildContext(context);
  };
  const creating = esbuild.context(buildOptions);
  try {
    context = await raceAbort(creating, signal, reason, 'while creating build context');
    const rebuilding = context.rebuild();
    let buildResult;
    try {
      buildResult = await raceAbort(rebuilding, signal, reason, 'during build');
    } catch (error) {
      if (error instanceof CheckStopped) await dispose();
      throw error;
    }
    throwIfAborted(signal, reason, 'after build');
    await dispose();
    throwIfAborted(signal, reason, 'after build cleanup');
    await fs.copyFile(path.join(project, 'index.html'), path.join(outputDir, 'index.html'));
  await fs.writeFile(path.join(outputDir, 'browser-check.cjs'), browserOracle(phase, retainedUnresolved));
    throwIfAborted(signal, reason, 'after build output');
    return {
      warnings: buildResult.warnings.map((warning) => warning.text),
      esbuildVersion: esbuild.version,
      reactVersion: reactPackage.version,
      reactDomVersion: reactDomPackage.version,
    };
  } catch (error) {
    if (!context && !disposed && signal.aborted) {
      disposed = true;
      void creating.then(cleanupBuildContext, () => {});
    }
    throw error;
  } finally {
    await dispose();
  }
}

async function resolveBrowserImage(image, signal, reason, remainingMs) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/@:-]{0,255}$/.test(image)) throw new Error('Invalid Docker image reference');
  throwIfAborted(signal, reason, 'before image resolution');
  const result = await runProcess('docker', ['image', 'inspect', '--format', '{{.Id}}', image], {
    timeoutMs: Math.max(1, remainingMs()), signal,
  });
  if (result.stopped) throw new CheckStopped(reason(result.stopped), 'during image resolution');
  if (result.code !== 0) throw new Error('Docker image unavailable locally; no image was pulled');
  const identity = result.stdout.trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(identity)) throw new Error('Docker returned invalid image identity');
  throwIfAborted(signal, reason, 'after image resolution');
  return identity;
}

function dockerArgs({ name, image, outputDir }) {
  if (/[\x00-\x1f,]/.test(outputDir)) throw new Error('Unsupported browser output mount path');
  return [
    'run', '--rm', '--pull=never', '--name', name,
    '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--user=65534:65534', '--pids-limit=256', '--memory=512m', '--memory-swap=512m', '--cpus=2',
    '--tmpfs=/tmp:rw,exec,nosuid,size=128m', '--tmpfs=/dev/shm:rw,exec,nosuid,size=128m',
    '--mount', `type=bind,source=${outputDir},target=/demo,readonly`,
    '--workdir=/demo', '--entrypoint=/usr/bin/env', image, 'node', '/demo/browser-check.cjs',
  ];
}

export async function verifyBrowserDemo(options) {
  validateOptions(options);
  const started = performance.now();
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error('Browser timeoutMs must be a positive integer');
  const deadline = started + timeoutMs;
  const controller = new AbortController();
  let stopReason = null;
  const reason = (fallback) => stopReason ?? fallback ?? (options.signal?.aborted ? 'cancelled' : 'timeout');
  const parentAbort = () => { if (!stopReason) stopReason = 'cancelled'; controller.abort(); };
  options.signal?.addEventListener('abort', parentAbort, { once: true });
  if (options.signal?.aborted) parentAbort();
  const timer = setTimeout(() => { if (!stopReason) stopReason = 'timeout'; controller.abort(); }, timeoutMs);
  const remainingMs = () => Math.max(1, Math.ceil(deadline - performance.now()));
  let build; let name = null;
  try {
    build = await buildDemo({ ...options, signal: controller.signal, reason });
    throwIfAborted(controller.signal, reason, 'after build');
    const resolvedImage = await resolveBrowserImage(options.image, controller.signal, reason, remainingMs);
    throwIfAborted(controller.signal, reason, 'after image resolution');
    name = `shift-browser-${randomUUID()}`;
    const result = await runProcess('docker', dockerArgs({ name, image: resolvedImage, outputDir: options.outputDir }), {
      timeoutMs: remainingMs(),
      signal: controller.signal,
    });
    if (controller.signal.aborted && !result.stopped) result.stopped = reason();
    if (result.stopped) throw new CheckStopped(reason(result.stopped), 'during browser execution');
    throwIfAborted(controller.signal, reason, 'after browser execution');
    return {
      status: result.code === 0 ? 'passed' : 'failed',
      scope: 'browser', phase: options.phase, image: resolvedImage, stopped: result.stopped,
      toolchain: {
        esbuildVersion: build.esbuildVersion,
        reactVersion: build.reactVersion,
        reactDomVersion: build.reactDomVersion,
        esbuildPath: options.toolchain.esbuildPath,
        nodeModules: options.toolchain.nodeModules,
      },
      durationMs: Math.round(performance.now() - started),
      logs: { stdout: result.stdout, stderr: result.stderr, stopped: result.stopped },
    };
  } catch (error) {
    if (error instanceof CheckStopped) {
      return {
        status: 'inconclusive', scope: 'browser', phase: options.phase, stopped: error.reason,
        durationMs: Math.round(performance.now() - started),
        logs: { stdout: '', stderr: error.message, stopped: error.reason },
      };
    }
    return {
      status: 'failed', scope: 'browser', phase: options.phase,
      durationMs: Math.round(performance.now() - started),
      logs: { stdout: '', stderr: `Build failed: ${error.message}` },
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', parentAbort);
    if (name) await execute('docker', ['rm', '-f', name], 5_000);
  }
}
