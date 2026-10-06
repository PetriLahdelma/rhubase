import { readRequest, writeJson } from './_worker-helper.mjs';
const request = await readRequest();
writeJson({ protocolVersion: 1, requestId: request.requestId, ok: false, result: null, error: { code: 'INFERENCE_FAILED', message: 'fixture failure' } });
