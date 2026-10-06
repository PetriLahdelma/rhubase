import { proxyAssessment } from './_assessment-proxy.mjs';
await proxyAssessment((assessment) => { assessment.repository.digest = '0'.repeat(64); });
