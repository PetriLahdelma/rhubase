import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { readRequest } from './_worker-helper.mjs';
import path from 'node:path';
const request = await readRequest();
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
const marker = path.join(path.dirname(await fs.realpath(request.params.from)), 'hang-pids.json');
await fs.writeFile(marker, JSON.stringify({ worker: process.pid, child: child.pid }) + '\n', { flag: 'wx' });
setInterval(() => {}, 1000);
