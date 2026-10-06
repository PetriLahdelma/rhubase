import { proxyAssessment } from './_assessment-proxy.mjs';
await proxyAssessment((assessment) => { assessment.sources[0].importName = '@forged/source'; });
