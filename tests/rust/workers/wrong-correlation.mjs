import { readRequest, validEnvelope, writeJson } from './_worker-helper.mjs';
const request = await readRequest();
const response = await validEnvelope(request); response.requestId = (request.requestId[0] === 'a' ? 'b' : 'a') + request.requestId.slice(1); writeJson(response);
