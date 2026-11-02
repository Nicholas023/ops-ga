import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { importSWE } from '../benchmarks/import-swe.mjs';
import { initialize } from '../src/init.mjs';
import { usageGuard, parseHeadless } from '../src/runner.mjs';

test('SWE import strips gold/test patches and rejects overlapping splits', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ops-ga-swe-'));
  const source = path.join(root, 'rows.json'), out = path.join(root, 'tasks.json');
  await writeFile(source, JSON.stringify(['a__b-1', 'a__b-2', 'a__b-3'].map(instance_id => ({ instance_id, repo: 'a/b', base_commit: 'a'.repeat(40), problem_statement: 'Fix it', patch: 'GOLD', test_patch: 'TEST' }))));
  const options = { dataset: 'SWE-bench/SWE-bench_Lite', revision: 'pinned', repositoryRoot: root, groups: { train: ['a__b-1'], gate: ['a__b-2'], test: ['a__b-3'] } };
  await importSWE(source, out, options);
  const text = await readFile(out, 'utf8'); assert(!text.includes('GOLD')); assert(!text.includes('TEST'));
  await assert.rejects(() => importSWE(source, out, { ...options, groups: { train: ['a__b-1'], gate: ['a__b-1'], test: ['a__b-3'] } }), /Overlapping/);
});
test('Web handoff init requires explicit budget and never overwrites config', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ops-ga-init-')), file = path.join(root, 'private.json');
  await assert.rejects(() => initialize(file, { confirm: true }), /explicit/);
  await assert.rejects(() => initialize(file, { budgetUSD: 2 }), /approval/);
  await initialize(file, { budgetUSD: 2, confirm: true });
  const config = JSON.parse(await readFile(file)); assert.equal(config.budget.maxUSD, 2); assert.equal(config.budget.confirmedByUser, true); assert(config.lanes[0].endsWith('operations.json'));
  await assert.rejects(() => initialize(file, { budgetUSD: 2, confirm: true }), /overwrite/);
});
test('live usage guard stops at reservation and rejects missing usage', () => {
  const guard = usageGuard({ budget: { reserveTokensPerCall: 100 } });
  assert.throws(() => guard(JSON.stringify({ type: 'status', phase: 'step_end', usage: { inputTokens: 99, outputTokens: 1 } }) + '\n'), /reservation reached/);
  assert.throws(() => usageGuard({ budget: { reserveTokensPerCall: 100 } })(JSON.stringify({ type: 'status', phase: 'step_end' }) + '\n'), /Usage missing/);
});
