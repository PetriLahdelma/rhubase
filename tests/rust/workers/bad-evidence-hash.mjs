import { readRequest, validEnvelope, writeJson } from './_worker-helper.mjs';
const request = await readRequest(); const response = await validEnvelope(request);
const item = [...response.result.changes, ...response.result.proposals, ...response.result.unresolved].find((entry) => entry.evidence?.length); item.evidence[0].sha256 = '0'.repeat(64); writeJson(response);
