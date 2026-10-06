import { readRequest, validEnvelope } from './_worker-helper.mjs';
const request = await readRequest();
process.stdout.write(JSON.stringify(await validEnvelope(request)) + '\n', () => { process.exitCode = 7; });
