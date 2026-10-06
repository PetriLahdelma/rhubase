// Runs only inside the explicitly invoked Docker tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import net from 'node:net';

test('unprivileged process with no effective capabilities', async () => {
  assert.equal(process.getuid(), 65534);
  assert.match(await fs.readFile('/proc/self/status', 'utf8'), /^CapEff:\s+0+$/m);
});
test('consumer and oracle mounts are read-only', async () => {
  await assert.rejects(fs.writeFile('/consumer/escape.txt', 'escape'));
  await assert.rejects(fs.writeFile('/oracle/check.test.mjs', 'overwrite'));
});
test('Docker socket and host sentinel are unavailable', async () => {
  await assert.rejects(fs.stat('/var/run/docker.sock'));
  assert.equal(process.env.SHIFT_HOST_SECRET_SENTINEL, undefined);
});
test('outbound connection is unavailable', async () => {
  const result = await new Promise((resolve) => {
    const socket = net.connect({ host: '1.1.1.1', port: 443 });
    socket.setTimeout(1000);
    socket.once('connect', () => { socket.destroy(); resolve('connected'); });
    socket.once('error', () => { socket.destroy(); resolve('denied'); });
    socket.once('timeout', () => { socket.destroy(); resolve('timeout'); });
  });
  assert.equal(result, 'denied');
});
