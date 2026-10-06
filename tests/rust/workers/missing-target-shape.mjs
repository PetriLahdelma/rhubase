import { readRequest, validEnvelope, writeJson, firstEvidence } from './_worker-helper.mjs';
const request = await readRequest(); const response = await validEnvelope(request); const evidence = await firstEvidence(response.result);
response.result.proposals = [{ id: 'fixture-missing-target', kind: 'component-rename', source: { export: 'OldAction' }, target: {}, basis: 'documentation-explicit', reason: 'fixture', status: 'needs-review', executable: false, evidence: [evidence] }];
writeJson(response);
