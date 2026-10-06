import { proxyAssessment } from './_assessment-proxy.mjs';
await proxyAssessment((assessment) => { const [one, two] = assessment.mappingGroups; const id = one.usageIds[0]; two.usageIds.push(id); two.count = two.usageIds.length; const usage = assessment.usageInventory.usages.find((item) => item.id === id); two.evidence.push(...usage.evidence); });
