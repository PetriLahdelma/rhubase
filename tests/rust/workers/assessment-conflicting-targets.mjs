import { proxyAssessment } from './_assessment-proxy.mjs';
await proxyAssessment((assessment) => { const group = assessment.mappingGroups.find((item) => item.route === 'mapping-to-review'); group.candidateTargets.push({ ...group.candidateTargets[0], prop: 'forged-different-coordinate' }); });
