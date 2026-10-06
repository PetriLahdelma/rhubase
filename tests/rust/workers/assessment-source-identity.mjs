import { proxyAssessment } from './_assessment-proxy.mjs';
await proxyAssessment((assessment) => { assessment.sources[0].identity.version = '999.0.0-forged'; });
