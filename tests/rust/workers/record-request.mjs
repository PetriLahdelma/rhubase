import { readRequest, validEnvelope, writeJson, recordRequest } from './_worker-helper.mjs';
const request = await readRequest();
await recordRequest(request);
writeJson(await validEnvelope(request));
