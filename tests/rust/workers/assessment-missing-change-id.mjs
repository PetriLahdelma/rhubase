import { proxyAssessment } from './_assessment-proxy.mjs';
await proxyAssessment((assessment) => { const group = assessment.mappingGroups.find((item) => item.contractChangeIds.length); group.contractChangeIds = []; });
