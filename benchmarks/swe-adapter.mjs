import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execute } from '../src/process.mjs';
import { assert, save, hash } from '../src/common.mjs';
import { evaluateWorkspace, propose as proposeDSH } from '../src/runner.mjs';
import { evaluateSWE } from './swe-bench.mjs';

// User-owned snapshots must be prepared separately. No implicit network, package install,
// model-provided shell commands, gold patch, or hidden test is exposed to the agent.
export async function evaluate(request) {
  const { task, workspace, genome, lane, runnerOptions, budget } = request;
  const swe = task.benchmark;
  assert(swe?.type === 'swe-bench' && /^[a-f0-9]{40}$/.test(swe.baseCommit), 'SWE task needs pinned baseCommit');
  assert(typeof swe.repository === 'string' && path.isAbsolute(swe.repository), 'Use pre-provisioned absolute local snapshot repo');
  assert(typeof swe.datasetFile === 'string' && hash(await readFile(swe.datasetFile, 'utf8')) === swe.datasetHash, 'Pinned official dataset export changed');
  const checkout = await execute('git', ['clone', '--no-hardlinks', '--no-checkout', '--', swe.repository, workspace], { timeoutMs: 120000 });
  await execute('git', ['-C', workspace, 'checkout', '--detach', swe.baseCommit], { timeoutMs: 120000 });
  const config = { runner: { ...runnerOptions.dsh, type: 'dsh' }, budget };
  const dir = path.dirname(workspace);
  const run = await evaluateWorkspace(config, lane, genome, { ...task, check: { type: 'answer-includes', value: '' } }, dir, workspace);
  await execute('git', ['-C', workspace, 'add', '-A', '--', '.'], { timeoutMs: 30000 });
  const diff = await execute('git', ['-C', workspace, 'diff', '--cached', '--binary', 'HEAD'], { timeoutMs: 30000 });
  const runId = `opsga-${path.basename(path.dirname(dir))}-${task.id}-${Date.now()}`;
  const predictions = path.join(dir, 'predictions.jsonl');
  await writeFile(predictions, JSON.stringify({ instance_id: swe.instanceId, model_name_or_path: 'ops-ga', model_patch: diff.stdout }) + '\n');
  const grade = await evaluateSWE(runnerOptions.harness, { predictions, dataset: swe.datasetFile, split: swe.split, instanceIds: [swe.instanceId], runId, outDir: path.join(dir, 'grade') });
  const report = grade.result;
  assert(Array.isArray(report.resolved_ids) && Array.isArray(report.unresolved_ids), 'Unsupported official SWE-bench report');
  assert(report.resolved_ids.includes(swe.instanceId) || report.unresolved_ids.includes(swe.instanceId), 'SWE-bench infrastructure failure/missing result, not an unresolved model patch');
  return { ...run, success: report.resolved_ids.includes(swe.instanceId), report: grade.report, prediction: predictions, benchmark: swe, synthetic: false };
}
export async function propose(request) {
  return proposeDSH({ runner: { ...request.runnerOptions.dsh, type: 'dsh' }, budget: request.budget }, request.lane, request.parents, request.feedback, process.cwd());
}
