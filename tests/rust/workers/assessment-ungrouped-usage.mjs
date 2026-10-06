import { proxyAssessment } from './_assessment-proxy.mjs';
await proxyAssessment((assessment) => { const group = assessment.mappingGroups.find((item) => item.usageIds.length === 1); group.usageIds = []; group.count = 0; group.evidence = []; });
