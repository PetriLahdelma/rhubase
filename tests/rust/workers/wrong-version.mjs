import { readRequest, validEnvelope, writeJson } from './_worker-helper.mjs';
const request = await readRequest();
const response = await validEnvelope(request); response.protocolVersion = 2; writeJson(response);
