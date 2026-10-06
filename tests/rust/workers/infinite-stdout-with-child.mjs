import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { readRequest } from './_worker-helper.mjs';
const request = await readRequest();
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
await fs.writeFile(path.join(path.dirname(await fs.realpath(request.params.from)), 'infinite-child-pids.json'), JSON.stringify({ worker: process.pid, child: child.pid }) + '\n', { flag: 'wx' });
const chunk = 'x'.repeat(4096);
function flood() { while (process.stdout.write(chunk)) {} setImmediate(flood); }
flood();
