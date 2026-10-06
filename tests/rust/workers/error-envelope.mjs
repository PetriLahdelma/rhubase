import { readRequest, writeJson } from './_worker-helper.mjs';
const request = await readRequest();
writeJson({ protocolVersion: 1, requestId: request.requestId, ok: false, error: { code: 'FIXTURE_ERROR', message: 'bounded fixture failure' } });
