import { proxyAssessment } from './_assessment-proxy.mjs';
await proxyAssessment((assessment) => { assessment.target.identity.version = '999.0.0-forged'; });
