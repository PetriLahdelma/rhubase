import { proxyAssessment } from './_assessment-proxy.mjs';
await proxyAssessment((assessment) => { assessment.verificationCandidates.pop(); });
