import { proxyAssessment } from './_assessment-proxy.mjs';
await proxyAssessment((assessment) => { const group = assessment.mappingGroups.find((item) => item.route === 'mapping-to-review'); const decision = assessment.decisionsRequired.find((item) => item.groupId === group.id); decision.kind = 'choose-migration-target'; });
