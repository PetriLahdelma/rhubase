import { proxyAssessment } from './_assessment-proxy.mjs';
await proxyAssessment((assessment) => { assessment.decisionsRequired[0].candidateOwners = ['@forged-owner']; assessment.decisionsRequired[0].ownerStatus = 'unassigned'; });
