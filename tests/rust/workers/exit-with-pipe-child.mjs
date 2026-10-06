import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { readRequest, validEnvelope } from './_worker-helper.mjs';
const request = await readRequest();
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] });
await fs.writeFile(path.join(path.dirname(await fs.realpath(request.params.from)), 'pipe-child-pids.json'), JSON.stringify({ worker: process.pid, child: child.pid }) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify(await validEnvelope(request)) + '\n', () => process.exit(0));
