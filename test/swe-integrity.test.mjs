import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { gradeInference } from '../benchmarks/swe-grading.mjs';
import { evaluateSWE } from '../benchmarks/swe-bench.mjs';
import { Budget, runSearch } from '../src/search.mjs';
import { select } from '../src/genome.mjs';
import { execute } from '../src/process.mjs';
import { readConfig } from '../src/config.mjs';
const tmp = () => mkdtemp(path.join(os.tmpdir(), 'ops-ga-swe-integrity-'));
const run = { tokens: 100, success: true, safety: true, steps: 1, synthetic: false, usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 80, cacheWriteTokens: 0 } };
test('grading failure retains known inference usage and settles instead of locking unknown billing', async () => {
  const directory = await tmp();
  const result = await gradeInference(run, { instanceId: 'repo__issue-1', prediction: 'patch.jsonl', runId: 'unique', directory }, () => { throw new Error('Docker unavailable'); });
  assert.equal(result.selectionEligible, false); assert.equal(result.gradingOutcome, 'infrastructure_failed'); assert.equal(result.tokens, 100);
  assert.equal(JSON.parse(await readFile(path.join(directory, 'grading-failure.json'))).usageKnown, true);
  const c = { runner: { type: 'adapter' }, budget: { currency: 'CNY', maxCNY: 1, reserveCNYPerCall: .1, reserveTokensPerCall: 1000, maxTokens: 10000, maxCalls: 10, maxEpisodes: 10, rates: { inputCNYPerMillion: 2, outputCNYPerMillion: 8, cacheReadCNYPerMillion: .04 } } };
  const state = { budget: { calls: 0, episodes: 0, tokens: 0 } }, budget = new Budget(c, state, async () => {});
  await budget.reserve(true); await budget.settle(result); assert.equal(state.budget.pending, false); assert.equal(state.budget.tokens, 100);
  assert.deepEqual(select([{ id: 'bad', results: [result], tokens: 100, successes: 0 }], { results: [{ success: false }] }), []);
});
test('baseline grading failure settles persisted episodes and resume does not rerun inference', async () => {
  const c = await readConfig('examples/demo.json'), dir = await tmp(), module = path.join(dir, 'adapter.mjs');
  await writeFile(module, 'export async function evaluate(){return {tokens:100,success:false,safety:true,synthetic:false,selectionEligible:false,gradingOutcome:"infrastructure_failed"}}');
  c.output = path.join(dir, 'run'); c.runner = { type: 'adapter', module, timeoutMs: 10000 };
  c.budget.currency = 'CNY'; c.budget.maxCNY = 10; c.budget.reserveCNYPerCall = 1;
  c.budget.rates = { inputCNYPerMillion: 2, outputCNYPerMillion: 8 }; c.budget.reserveTokensPerCall = 1000;
  await assert.rejects(() => runSearch(c, c.lanes[0]), /Baseline grading infrastructure failed/);
  const file = path.join(c.output, c.lanes[0].id, 'state.json'), before = JSON.parse(await readFile(file));
  assert.equal(before.budget.pending, false); assert.equal(Object.keys(before.evaluations).length, 1);
  assert.equal(before.budget.calls, 1);
  await assert.rejects(() => runSearch(c, c.lanes[0]), /Baseline grading infrastructure failed/);
  assert.equal(JSON.parse(await readFile(file)).budget.calls, before.budget.calls);
});
test('resolved patch does not erase abnormal agent completion; missing/infra reports are not unresolved outcomes', async () => {
  const directory = await tmp(), context = { instanceId: 'repo__issue-1', prediction: 'p', runId: 'id', directory };
  const grade = async () => ({ result: { resolved_ids: ['repo__issue-1'], unresolved_ids: [] }, report: 'r' });
  assert.equal((await gradeInference({ ...run, success: false }, context, grade)).success, false);
  assert.equal((await gradeInference(run, context, grade)).success, true);
  for (const result of [{ resolved_ids: [], unresolved_ids: [] }, { resolved_ids: [], unresolved_ids: ['repo__issue-1'], infra_failure_ids: ['repo__issue-1'] }]) {
    assert.equal((await gradeInference(run, context, async () => ({ result }))).selectionEligible, false);
  }
});
test('SWE config without actual OPS exposure fails closed before paid inference', async () => {
  const c = JSON.parse(await readFile('examples/swe-adapter.json', 'utf8')), dir = await tmp();
  c.tasks = ['train', 'gate', 'test'].map((split, i) => ({ id: `t${i}`, split, prompt: split, files: {}, check: { type: 'answer-includes', value: 'yes' } })); delete c.tasksFile;
  c.runner.module = path.resolve('benchmarks/swe-adapter.mjs'); c.lanes = [path.resolve('lanes/operations.json')];
  Object.assign(c.runner.options.dsh, { provider: 'p', model: 'm', home: path.join(dir, 'home'), provenance: { dsh: 'version', ops: 'version' } });
  delete c.runner.options.dsh.exposure;
  const file = path.join(dir, 'config.json'); await writeFile(file, JSON.stringify(c));
  await assert.rejects(() => readConfig(file), /actual wire exposure/);
});
test('official harness failure preserves private stdout/stderr before report loading', async () => {
  const root = await tmp(); await execute('git', ['init', root]);
  await writeFile(path.join(root, 'pinned.txt'), 'fixture'); await execute('git', ['-C', root, 'add', '.']);
  await execute('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);
  const revision = (await execute('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
  // Fake Python carrier, no Docker or API. It ignores Python argv after printing diagnostics.
  const bin = await tmp(), script = path.join(bin, 'fake-python.mjs');
  await writeFile(script, 'console.log("harness-started");console.error("docker-failed");process.exit(3)');
  await assert.rejects(() => evaluateSWE({ python: process.execPath, pythonArgs: [script], harnessCwd: root, revision }, { predictions: 'pred.jsonl', dataset: 'local.json', instanceIds: ['repo__issue-1'], runId: 'failed-run', outDir: path.join(bin, 'grade') }), /exited/);
  assert((await readFile(path.join(bin, 'grade/stdout.txt'), 'utf8')).includes('harness-started'));
  assert((await readFile(path.join(bin, 'grade/stderr.txt'), 'utf8')).includes('docker-failed'));
});
