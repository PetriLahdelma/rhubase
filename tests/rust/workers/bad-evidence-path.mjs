import { readRequest, validEnvelope, writeJson } from './_worker-helper.mjs';
const request = await readRequest(); const response = await validEnvelope(request);
const item = [...response.result.changes, ...response.result.proposals, ...response.result.unresolved].find((entry) => entry.evidence?.length); item.evidence[0].file = '../outside.d.ts'; writeJson(response);
