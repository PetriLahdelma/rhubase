import test from 'node:test';
import assert from 'node:assert/strict';
import { assertComparableImages } from '../../src/workflow-checks.mjs';
import { validateAgentResponse } from '../../src/workflow-agent.mjs';
import { loadWorkflowConfig } from '../../src/workflow-config.mjs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('passing checks from different container images cannot establish readiness', () => {
  assert.throws(() => assertComparableImages({ status: 'passed', image: 'sha256:a' }, { status: 'passed', image: 'sha256:b' }, 'sha256:a'), /images differ/);
  assert.doesNotThrow(() => assertComparableImages({ status: 'passed', image: 'sha256:a' }, { status: 'passed', image: 'sha256:a' }, 'sha256:a'));
});

test('successful agent protocol validates typed metadata and respects reported budget', () => {
  const valid = { type: 'result', subtype: 'success', is_error: false, result: 'Changed two files', total_cost_usd: 0.25, num_turns: 12, modelUsage: { model: { inputTokens: 100, outputTokens: 30, costUSD: 0.25 } } };
  assert.equal(validateAgentResponse(valid, 3), valid);
  for (const update of [{ result: {} }, { is_error: 'false' }, { total_cost_usd: '0.25' }, { total_cost_usd: -1 }, { total_cost_usd: 4 }, { modelUsage: [] }, { modelUsage: { model: { inputTokens: -1 } } }]) {
    assert.throws(() => validateAgentResponse({ ...valid, ...update }, 3));
  }
});

test('mixed configs reject malformed source rules and ignored verifier fields', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shift-config-boundary-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const base = { schemaVersion: 1, name: 'boundary', project: path.resolve('examples/react-consolidation'), recipes: [path.resolve('examples/react-consolidation/recipe.json')], checks: [{ id: 'syntax', kind: 'syntax', required: true }] };
  const file = path.join(root, 'config.json');
  for (const change of [
    { sources: {} },
    { sources: [{ module: 'legacy', exports: [12] }] },
    { checks: [{ id: 'syntax', kind: 'syntax', required: true, command: ['node', 'test.js'] }] },
    { checks: [{ id: 'browser', kind: 'browser-demo', required: true, image: 'browser', command: ['true'] }] },
  ]) {
    await fs.writeFile(file, JSON.stringify({ ...base, ...change }));
    await assert.rejects(loadWorkflowConfig(file));
  }
});
