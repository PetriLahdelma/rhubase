import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { demand } from './files.mjs';

// No shell, no user-supplied Docker flags, no automatic image pull.
export function execute(binary, args, timeoutMs = 30000, limit = 1_000_000) {
  return new Promise((resolve) => {
    const start = performance.now();
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stdout = ''; let stderr = ''; let bytes = 0; let stopped = null;
    const stop = (reason) => { stopped = reason; child.kill('SIGKILL'); };
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    const capture = (kind, data) => {
      bytes += data.length;
      if (bytes > limit) { stop('output-limit'); return; }
      if (kind === 'stdout') stdout += data.toString(); else stderr += data.toString();
    };
    child.stdout.on('data', (data) => capture('stdout', data));
    child.stderr.on('data', (data) => capture('stderr', data));
    child.once('error', (error) => { stopped = error.message; });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, stopped, durationMs: Math.round(performance.now() - start) });
    });
  });
}

export async function resolveImage(image) {
  demand(typeof image === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._/@:-]{0,255}$/.test(image), 'Invalid Docker image reference');
  const result = await execute('docker', ['image', 'inspect', '--format', '{{.Id}}', image], 10000);
  demand(result.code === 0 && !result.stopped, 'Docker image unavailable locally; no image was pulled');
  const identity = result.stdout.trim();
  demand(/^sha256:[a-f0-9]{64}$/.test(identity), 'Docker returned invalid image identity');
  return identity;
}

export function containerArgs({ name, image, consumer, oracle, phase = 'candidate' }) {
  demand(['baseline', 'candidate'].includes(phase), 'Invalid verification phase');
  for (const mount of [consumer, oracle]) demand(!/[\x00-\x1f,]/.test(mount), 'Unsupported Docker mount path');
  return [
    'run', '--rm', '--pull=never', '--name', name,
    '--network=none', '--read-only', '--cap-drop=ALL',
    '--security-opt=no-new-privileges', '--user=65534:65534',
    '--pids-limit=64', '--memory=256m', '--memory-swap=256m', '--cpus=1',
    '--tmpfs=/tmp:rw,noexec,nosuid,size=16m',
    '--mount', `type=bind,source=${consumer},target=/consumer,readonly`,
    '--mount', `type=bind,source=${oracle},target=/oracle/check.test.mjs,readonly`,
    '--workdir=/consumer', '--env', `SHIFT_PHASE=${phase}`, '--entrypoint=/usr/local/bin/node', image,
    '--test', '--test-reporter=tap', '/oracle/check.test.mjs',
  ];
}

export function interpretTest(result, expectedTests) {
  const total = result.stdout.match(/^# tests (\d+)$/m)?.[1];
  const passed = result.stdout.match(/^# pass (\d+)$/m)?.[1];
  const failed = result.stdout.match(/^# fail (\d+)$/m)?.[1];
  const skipped = result.stdout.match(/^# skipped (\d+)$/m)?.[1];
  const cancelled = result.stdout.match(/^# cancelled (\d+)$/m)?.[1];
  const todo = result.stdout.match(/^# todo (\d+)$/m)?.[1];
  const complete = Number(total) === expectedTests && Number(passed) === expectedTests
    && failed === '0' && skipped === '0' && cancelled === '0' && todo === '0';
  return result.stopped ? 'inconclusive' : result.code === 0 && complete ? 'passed' : 'failed';
}

export async function runCheck(options) {
  const name = `shift-check-${randomUUID()}`;
  const args = containerArgs({ ...options, name });
  let cancelled = false;
  const cleanup = () => { cancelled = true; void execute('docker', ['rm', '-f', name], 5000); };
  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);
  try {
    const result = await execute('docker', args, options.timeoutMs);
    if (cancelled) result.stopped = 'cancelled';
    return { ...result, status: interpretTest(result, options.expectedTests), image: options.image, container: name };
  } finally {
    process.removeListener('SIGINT', cleanup);
    process.removeListener('SIGTERM', cleanup);
    // Killing a Docker client need not kill its container. Always reconcile it.
    await execute('docker', ['rm', '-f', name], 5000);
  }
}
