import { proxyAssessment } from './_assessment-proxy.mjs';
await proxyAssessment((assessment) => { assessment.usageInventory.usages[0].evidence[0].sha256 = '0'.repeat(64); assessment.usageInventory.usages[0].evidence[0].file = '../outside.tsx'; });
