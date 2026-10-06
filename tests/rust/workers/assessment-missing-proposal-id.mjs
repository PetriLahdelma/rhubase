import { proxyAssessment } from './_assessment-proxy.mjs';
await proxyAssessment((assessment) => { const group = assessment.mappingGroups.find((item) => item.proposalIds.length); group.proposalIds = []; group.target = null; group.candidateTargets = []; });
