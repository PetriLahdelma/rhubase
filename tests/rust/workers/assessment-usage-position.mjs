import { proxyAssessment } from './_assessment-proxy.mjs';
await proxyAssessment((assessment) => { const usage = assessment.usageInventory.usages[0]; usage.line += 1; usage.column += 2; usage.start += 3; usage.end += 4; });
