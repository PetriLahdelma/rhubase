import { proxyAssessment } from './_assessment-proxy.mjs';
await proxyAssessment((assessment) => { delete assessment.limitations; });
