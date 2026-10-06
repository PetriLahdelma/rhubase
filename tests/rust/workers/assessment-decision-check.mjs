import { proxyAssessment } from './_assessment-proxy.mjs';
await proxyAssessment((assessment) => { assessment.decisionsRequired[0].requiredChecks = ['check:forged']; });
