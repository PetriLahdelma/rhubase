import { proxyAssessment } from './_assessment-proxy.mjs';
await proxyAssessment((assessment) => { const group = assessment.mappingGroups[0]; group.usageIds.push(group.usageIds[0]); group.count = group.usageIds.length; });
