import * as fs from 'node:fs/promises';
import path from 'node:path';
import { demand, digest } from './files.mjs';
import { treeSnapshot, copyTree, fileDigest } from './workflow-files.mjs';
import { runProcess } from './process.mjs';
import { isProtectedSourceFile } from './migration-policy.mjs';

export async function agentToolIdentity() {
  let executable;
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, process.platform === 'win32' ? 'claude.exe' : 'claude');
    try {
      await fs.access(candidate, fs.constants.X_OK);
      if ((await fs.stat(candidate)).isFile()) { executable = await fs.realpath(candidate); break; }
    } catch (error) { if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code)) throw error; }
  }
  demand(executable, 'Claude CLI is not available on PATH');
  const version = await runProcess(executable, ['--version'], { timeoutMs: 10000 });
  demand(version.code === 0 && !version.stopped, 'Cannot read Claude CLI version');
  return { path: executable, sha256: await fileDigest(executable), version: version.stdout.trim() };
}

export function validateAgentContext(input, references, goal) {
  const snapshots = [input, ...references];
  const count = snapshots.reduce((total, snapshot) => total + Object.keys(snapshot.files).length, 0) + 1;
  const bytes = snapshots.reduce((total, snapshot) => total + Object.values(snapshot.files).reduce((sum, file) => sum + file.bytes, 0), 0) + Buffer.byteLength(goal) + 4096;
  demand(count <= 10000 && bytes <= 100_000_000, 'Combined agent source/reference context exceeds 10,000 files or 100 MB; narrow the declared scope');
  return { files: count, bytes };
}

export function auditAgentCode(original, proposed, file) {
  const pattern = /@ts-(?:ignore|nocheck|expect-error)\b|(?:eslint|biome|oxlint)[-\s]+(?:disable|ignore)|(?:istanbul|c8)\s+ignore|\.\s*(?:skip|only)\s*(?:\(|\.|<|`)|process\s*\.\s*exit\s*\(/;
  const previous = new Map();
  for (const line of original.split('\n')) if (pattern.test(line)) previous.set(line.trim(), (previous.get(line.trim()) ?? 0) + 1);
  for (const line of proposed.split('\n')) {
    if (!pattern.test(line)) continue;
    const key = line.trim();
    demand((previous.get(key) ?? 0) > 0, `Agent introduced verification suppression: ${file}`);
    previous.set(key, previous.get(key) - 1);
  }
}

export function validateAgentResponse(response, budgetUsd) {
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
  demand(object(response) && response.type === 'result' && response.is_error === false && response.subtype === 'success', 'Agent did not return a successful result protocol');
  demand(typeof response.result === 'string', 'Agent result summary must be text');
  if (response.total_cost_usd !== undefined) {
    demand(Number.isFinite(response.total_cost_usd) && response.total_cost_usd >= 0, 'Agent reported invalid cost metadata');
    demand(response.total_cost_usd <= budgetUsd, 'Agent reported usage above the configured budget; candidate withheld');
  }
  if (response.duration_ms !== undefined) demand(Number.isFinite(response.duration_ms) && response.duration_ms >= 0, 'Agent reported invalid duration');
  if (response.num_turns !== undefined) demand(Number.isInteger(response.num_turns) && response.num_turns >= 0, 'Agent reported invalid turn count');
  if (response.modelUsage !== undefined) {
    demand(object(response.modelUsage), 'Agent reported invalid model metadata');
    for (const usage of Object.values(response.modelUsage)) {
      demand(object(usage), 'Agent model usage must be an object');
      for (const key of ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'thinkingTokens']) {
        if (usage[key] !== undefined) demand(Number.isInteger(usage[key]) && usage[key] >= 0, 'Agent reported invalid token metadata');
      }
      if (usage.costUSD !== undefined) demand(Number.isFinite(usage.costUSD) && usage.costUSD >= 0, 'Agent reported invalid model cost');
    }
  }
  return response;
}

export async function generateAgentCandidate({ candidate, references, goal, budgetUsd, timeoutMs, runDirectory, allowedFiles, toolIdentity, signal }) {
  const workspace = path.join(runDirectory, 'agent-workspace');
  await fs.mkdir(workspace);
  const sourceBefore = await treeSnapshot(candidate);
  await copyTree(candidate, path.join(workspace, 'project'), sourceBefore);
  for (const [index, reference] of references.entries()) await copyTree(reference.path, path.join(workspace, 'reference', String(index)), reference.snapshot);
  const task = `Workspace layout: consumer source is under project/; supplied reference directories are under reference/0, reference/1, etc. Relative paths in the following brief refer to those locations.\n\n${goal}\n\nExecution boundary: edit only existing .js/.jsx/.ts/.tsx/.mjs source files under project/. Do not alter tests, assertions, configs, manifests, reference/, TASK.md, or add/delete files. Do not introduce diagnostic suppression, disable tests, invent missing target APIs, or claim checks ran. Unknown semantics must remain unresolved in your final response. This source migration requires later independent verification.\n`;
  await fs.writeFile(path.join(workspace, 'TASK.md'), task, { flag: 'wx' });
  const before = await treeSnapshot(workspace, { excludeGenerated: false, rejectGit: true });
  const args = ['-p', '--restricted', '--safe-mode', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', '--permission-mode', 'acceptEdits', '--tools', 'Read,Edit,Write,Glob,Grep', '--allowedTools', 'Read,Edit,Write,Glob,Grep', '--max-budget-usd', String(budgetUsd), '--output-format', 'json'];
  const identity = toolIdentity ?? await agentToolIdentity();
  const result = await runProcess(identity.path, args, {
    cwd: workspace, input: 'Read TASK.md and the source/reference files. Implement the requested source migration within the stated boundary; summarize changed files and unresolved behavior.',
    timeoutMs, signal,
  });
  await fs.writeFile(path.join(runDirectory, 'agent.stdout.json'), result.stdout);
  await fs.writeFile(path.join(runDirectory, 'agent.stderr.txt'), result.stderr);
  demand(!result.stopped && result.code === 0, `Agent failed: ${result.stopped ?? 'exit ' + result.code}`);
  let response;
  try { response = JSON.parse(result.stdout); } catch { throw new Error('Agent returned malformed JSON; candidate withheld'); }
  validateAgentResponse(response, budgetUsd);
  const after = await treeSnapshot(workspace, { excludeGenerated: false, rejectGit: true });
  const changes = auditAgentChanges(before, after, allowedFiles);
  for (const file of changes) {
    const content = await fs.readFile(path.join(workspace, file));
    demand(digest(content) === after.files[file].sha256, 'Agent workspace changed during acceptance');
    const proposed = content.toString('utf8');
    const original = await fs.readFile(path.join(candidate, file.slice('project/'.length)), 'utf8');
    auditAgentCode(original, proposed, file);
  }
  // Publish to the candidate only after auditing the entire agent workspace.
  for (const file of changes) await fs.copyFile(path.join(workspace, file), path.join(candidate, file.slice('project/'.length)));
  return {
    provider: 'claude-cli', toolIdentity: identity, command: [identity.path, ...args], modelUsage: response.modelUsage,
    reportedCostUsd: response.total_cost_usd ?? null, costBasis: 'provider-reported, not an invoice',
    durationMs: result.durationMs, changedFiles: changes.map((p) => p.slice('project/'.length)),
    summary: response.result, taskHash: digest(task), budgetUsd, timeoutMs,
  };
}

export function auditAgentChanges(before, after, allowedFiles) {
  const original = Object.keys(before.files).sort(); const current = Object.keys(after.files).sort();
  demand(JSON.stringify(original) === JSON.stringify(current), 'Agent added or removed files; candidate withheld');
  const changes = original.filter((file) => before.files[file].sha256 !== after.files[file].sha256);
  for (const file of original) demand(before.files[file].mode === after.files[file].mode, `Agent changed file executable permissions: ${file}`);
  for (const file of changes) {
    if (allowedFiles) demand(allowedFiles.has(file.slice('project/'.length)), `Agent changed a file outside the discovered/declared migration scope: ${file}`);
    demand(file.startsWith('project/') && !isProtectedSourceFile(file.slice('project/'.length)), `Agent changed a protected file: ${file}`);
  }
  return changes;
}
