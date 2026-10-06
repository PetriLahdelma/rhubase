import { spawn } from 'node:child_process';

// Fixed binaries and argument arrays are chosen by the operator/adapters.
// This utility never runs a shell or interprets repository-provided commands.
export function runProcess(binary, args, { cwd, input, timeoutMs = 30000, maxBytes = 2_000_000, env = {}, inheritEnv = true, signal } = {}) {
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(binary, args, { cwd, env: inheritEnv ? { ...process.env, ...env } : env, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let bytes = 0; let stopped = null;
    const kill = (reason) => {
      if (stopped) return;
      stopped = reason;
      try { if (process.platform === 'win32') child.kill('SIGKILL'); else process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') stderr += error.message; }
    };
    const abort = () => kill('cancelled');
    const timer = setTimeout(() => kill('timeout'), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    const capture = (stream, data) => {
      bytes += data.length;
      if (bytes > maxBytes) { kill('output-limit'); return; }
      if (stream === 'stdout') stdout += data.toString(); else stderr += data.toString();
    };
    child.stdout.on('data', (data) => capture('stdout', data));
    child.stderr.on('data', (data) => capture('stderr', data));
    child.once('error', (error) => { stopped = error.code ?? error.message; });
    child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') kill(error.code ?? 'input-error'); });
    child.stdin.end(input ?? '');
    child.once('close', (code, childSignal) => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      resolve({ code, signal: childSignal, stopped, stdout, stderr, durationMs: Math.round(performance.now() - started) });
    });
    if (signal?.aborted) abort();
  });
}
