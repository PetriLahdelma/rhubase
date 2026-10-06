import { readRequest, validEnvelope, writeJson, firstEvidence } from './_worker-helper.mjs';
const request = await readRequest(); const response = await validEnvelope(request); const evidence = await firstEvidence(response.result);
response.result.proposals = [{ id: 'fixture-executable', kind: 'component-rename', source: { export: 'OldAction' }, target: { export: 'PrimaryAction' }, basis: 'documentation-explicit', reason: 'fixture', status: 'needs-review', executable: true, evidence: [evidence] }];
writeJson(response);
