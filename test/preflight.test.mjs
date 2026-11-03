import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { doctor } from '../src/doctor.mjs';
import { runtimePatch } from '../src/runner.mjs';
import { preflight, preflightSummary } from '../src/preflight.mjs';
import { readConfig } from '../src/config.mjs';
import { runSearch } from '../src/search.mjs';
import { execute } from '../src/process.mjs';
import { checkSubmission } from '../src/submission.mjs';
const tmp = () => mkdtemp(path.join(os.tmpdir(), 'ops-ga-preflight-'));

test('nested SWE doctor checks actual CLI composition offline without persisting dump secrets', async () => {
  const root = await tmp(), script = path.join(root, 'dsh.mjs'), log = path.join(root, 'calls.jsonl');
  const runner = { command: process.execPath, args: [script], home: path.join(root, 'home'), profile: 'headless', provider: 'p', model: 'm', permission: 'workspace-write' };
  const dump = runtimePatch(runner).map(row => `- id: ${row.id}\n${row.disabled ? '  disabled: true' : Object.entries(row.config).map(([k,v]) => `  ${k}: ${v}`).join('\n')}`).join('\n');
  await writeFile(script, `import {appendFileSync} from 'node:fs';
appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2))+'\\n');
if(process.argv.includes('--version')) console.log('fixture-v1');
else if(process.argv.includes('--help')) console.log('--json --dump-config');
else if(process.argv.includes('--dump-config')) console.log(${JSON.stringify(dump + '\napiKey: PRIVATE_DUMP_SENTINEL')});
else throw Error('Inference forbidden in doctor fixture');`);
  const config = { output: path.join(root, 'output'), fingerprint: 'fixture', runner: { type: 'adapter', module: 'swe-adapter.mjs', options: { dsh: runner } } };
  const result = await doctor(config);
  assert.equal(result.runtimeChecked, true); assert.equal(result.wireExposureVerified, false); assert.equal(result.inferenceRun, false);
  assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, 3);
  assert(!JSON.stringify(result).includes('PRIVATE_DUMP_SENTINEL'));
  assert.deepEqual(await readdir(config.output), ['doctor.patch.json']);
  await writeFile(script, `console.log(process.argv.includes('--version')?'v1':process.argv.includes('--help')?'--json':'- id: agent-default-model');`);
  await assert.rejects(() => doctor(config), /Runtime config mismatch|Runtime overlay missing/);
});

test('preflight includes repeats, proposal attempt cap, final pairs and one shared budget without writes', async () => {
  const c = await readConfig('examples/demo.json');
  c.runner.type = 'adapter'; c.search.llmMutation = true;
  c.evaluation.repetitions = 3;
  const report = preflight(c, c.lanes[0]);
  assert.equal(report.suite.train, 6);
  assert.equal(report.upperBound.calls - report.upperBound.episodes, c.search.generations * c.search.population * 6);
  assert.equal(report.upperBound.episodes, 9 + c.search.generations * (c.search.population * 6 + c.search.elites * 3) + 6);
  const shared = preflightSummary(c, [report, report]);
  assert.equal(shared.upperBound.calls, report.upperBound.calls * 2);
  c.search.llmMutation = false;
  assert.equal(preflight(c, c.lanes[0]).upperBound.calls, report.upperBound.episodes);
});

test('CLI preflight is available without paid consent and does not create an output directory', async () => {
  const root = await tmp(), c = JSON.parse(await readFile('examples/demo.json', 'utf8'));
  c.output = path.join(root, 'output'); c.lanes = [path.resolve('lanes/operations.json')];
  const file = path.join(root, 'config.json'); await writeFile(file, JSON.stringify(c));
  const result = await execute(process.execPath, ['bin/ops-ga.mjs', 'preflight', '--config', file]);
  assert.equal(JSON.parse(result.stdout).inferenceRun, false);
  assert.deepEqual(await readdir(root), ['config.json']);
});

test('status reports the global ledger after another lane spends', async () => {
  const root = await tmp(), raw = JSON.parse(await readFile('examples/demo.json', 'utf8'));
  raw.output = path.join(root, 'output'); raw.lanes = ['operations', 'interface'].map(id => path.resolve(`lanes/${id}.json`));
  const file = path.join(root, 'config.json'); await writeFile(file, JSON.stringify(raw));
  const c = await readConfig(file);
  await runSearch(c, c.lanes[0]);
  const stale = JSON.parse(await readFile(path.join(c.output, 'operations', 'state.json'))).budget.calls;
  await runSearch(c, c.lanes[1]);
  const shared = JSON.parse(await readFile(path.join(c.output, 'budget.json'))).budget.calls;
  const result = JSON.parse((await execute(process.execPath, ['bin/ops-ga.mjs', 'status', '--config', file, '--lane', 'operations'])).stdout);
  assert(shared > stale); assert.equal(result.budget.calls, shared);
});

test('hash-pinned evidence stays LF even in a core.autocrlf=true checkout', async () => {
  const root = await tmp(); await execute('git', ['init', root]);
  await writeFile(path.join(root, '.gitattributes'), await readFile('.gitattributes'));
  await writeFile(path.join(root, 'evidence.json'), '{\n  "evidence": true\n}\n');
  await execute('git', ['-C', root, 'add', '.']);
  const checkout = path.join(root, 'checkout');
  await execute('git', ['-C', root, '-c', 'core.autocrlf=true', 'checkout-index', '--all', '--prefix=' + checkout.replaceAll('\\', '/') + '/']);
  assert.equal(await readFile(path.join(checkout, 'evidence.json'), 'utf8'), '{\n  "evidence": true\n}\n');
});

test('merged submissions validate and expose OPS absence, per-instance deltas and identity controls', async () => {
  const discovery = await checkSubmission('external-pr/discovery-guidance-2026-11-03/submission.json');
  assert.equal(discovery.valid, true); assert.equal(discovery.opsUsageObserved, false);
  assert.equal(discovery.sessions.length, 4); assert(discovery.warnings.some(w => w.includes('No ops_*')));
  assert(discovery.pairs.some(p => p.tokenDelta > 0)); assert(discovery.pairs.some(p => p.tokenDelta < 0));
  for (const dir of ['harmonyos-ops-044-003', 'harmonyos-ops-pilot-002']) {
    const control = await checkSubmission(`external-pr/${dir}/submission.json`);
    assert.equal(control.valid, true); assert.equal(control.tokenSavings, 0); assert(control.pairs.every(p => p.identityControl));
  }
});
