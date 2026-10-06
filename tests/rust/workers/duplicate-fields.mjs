import { readRequest, validEnvelope } from './_worker-helper.mjs';
const request = await readRequest();
const json = JSON.stringify(await validEnvelope(request));
process.stdout.write(json.replace('"ok":true', '"ok":true,"ok":true') + '\n');
