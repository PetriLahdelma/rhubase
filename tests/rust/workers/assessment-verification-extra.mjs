import { proxyAssessment } from './_assessment-proxy.mjs';
await proxyAssessment((assessment) => { assessment.verificationCandidates.push({ category: 'test', manifest: 'package.json', script: 'forged', status: 'declared-not-run' }); });
