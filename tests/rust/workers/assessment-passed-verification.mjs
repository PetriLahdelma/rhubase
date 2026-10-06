import { proxyAssessment } from './_assessment-proxy.mjs';
await proxyAssessment((assessment) => { assessment.verificationCandidates[0].status = 'passed'; });
