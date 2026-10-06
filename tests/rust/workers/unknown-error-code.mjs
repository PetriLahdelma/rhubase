import { readRequest, writeJson } from './_worker-helper.mjs';
const request = await readRequest();
writeJson({ protocolVersion: 1, requestId: request.requestId, ok: false, error: { code: 'MADE_UP_CODE', message: 'fixture unknown error code' } });
