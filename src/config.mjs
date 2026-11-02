import path from 'node:path';
import { assert, integer, load, hash } from './common.mjs';
import { validateBudget } from './budget.mjs';
import { baseline, validateGenome, validateLane } from './genome.mjs';

export async function readConfig(file) {
  const config = await load(file);
  const base = path.dirname(path.resolve(file));
  assert(config.version === 1, 'Expected config version 1');
  assert(['mock', 'dsh', 'adapter'].includes(config.runner?.type), 'runner.type must be mock, dsh or adapter');
  integer(config.seed, 0, 0xffffffff, 'seed');
  integer(config.search?.population, 2, 100, 'population');
  integer(config.search.generations, 1, 10000, 'generations');
  integer(config.search.elites, 1, config.search.population - 1, 'elites');
  integer(config.budget?.maxEpisodes, 1, 10000000, 'maxEpisodes');
  integer(config.budget.maxTokens, 1, Number.MAX_SAFE_INTEGER, 'maxTokens');
  integer(config.budget.reserveTokensPerCall, 1, config.budget.maxTokens, 'reserveTokensPerCall');
  integer(config.budget.maxCalls, 1, 10000000, 'maxCalls');
  integer(config.maxRegressions ?? 0, 0, 1000000, 'maxRegressions');
  assert(typeof config.output === 'string', 'Output path required');
  config.output = path.resolve(base, config.output);
  assert(Array.isArray(config.lanes) && config.lanes.length > 0, 'No lanes');
  config.lanes = await Promise.all(config.lanes.map(async entry => typeof entry === 'string' ? load(path.resolve(base, entry)) : entry));
  assert(new Set(config.lanes.map(l => l.id)).size === config.lanes.length, 'Duplicate lanes');
  for (const lane of config.lanes) { validateLane(lane); validateGenome(lane, baseline(lane)); }
  if (config.tasksFile) config.tasks = await load(path.resolve(base, config.tasksFile));
  assert(Array.isArray(config.tasks) && config.tasks.length > 0, 'No tasks');
  assert(new Set(config.tasks.map(t => t.id)).size === config.tasks.length, 'Duplicate tasks');
  for (const task of config.tasks) {
    assert(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,160}$/.test(task.id), 'Invalid task id');
    assert(['train', 'gate', 'test'].includes(task.split), 'Invalid task split');
    assert(typeof task.prompt === 'string', 'Missing task prompt');
    assert(task.files && typeof task.files === 'object' && !Array.isArray(task.files), 'Task files required');
    assert(task.check && ['file-equals', 'answer-includes'].includes(task.check.type), 'Unsupported task verifier');
    assert(typeof task.check.value === 'string', 'Missing expected value');
    if (task.check.type === 'file-equals') assert(typeof task.check.path === 'string', 'Missing checked path');
    if (task.benchmark?.datasetFile) {
      const bytes = await import('node:fs/promises').then(fs => fs.readFile(task.benchmark.datasetFile, 'utf8'));
      assert(hash(bytes) === task.benchmark.datasetHash, 'Benchmark dataset export changed before run');
    }
    assert(Object.values(task.files).every(v => typeof v === 'string'), 'Fixture must contain text files');
  }
  for (const split of ['train', 'gate', 'test']) assert(config.tasks.some(t => t.split === split), `Missing ${split} tasks`);
  if (config.runner.type === 'dsh') {
    assert(typeof config.runner.command === 'string', 'DSH command required');
    assert(Array.isArray(config.runner.args) && config.runner.args.every(a => typeof a === 'string'), 'DSH launcher args required');
    assert(typeof config.runner.home === 'string', 'Dedicated DSH home required');
    config.runner.home = path.resolve(base, config.runner.home);
    assert(config.runner.acknowledgeIsolation === true, 'Explicit isolation acknowledgment required');
    assert(config.runner.provider && typeof config.runner.provider === 'string', 'Pin deployment provider');
    assert(config.runner.model && typeof config.runner.model === 'string', 'Pin deployment model');
    assert(config.runner.profile && typeof config.runner.profile === 'string', 'Pin isolated profile');
    assert(config.runner.permission === 'read-only' || config.runner.permission === 'workspace-write', 'No full-access benchmark permission');
    assert(config.runner.provenance && typeof config.runner.provenance.dsh === 'string' && typeof config.runner.provenance.ops === 'string', 'Pin DSH and OPS version/ref in provenance');
    for (const value of [config.runner.provider, config.runner.model, ...Object.values(config.runner.provenance)]) assert(!/REPLACE|YOUR_|PIN_/i.test(value), 'Replace all provider/model/provenance placeholders');
    assert(config.runner.captureSessions === true, 'Real evidence runs must explicitly enable private session capture');
    integer(config.runner.timeoutMs, 1000, 3600000, 'timeoutMs');
  }
  if (config.runner.type === 'adapter') {
    assert(config.runner.trusted === true, 'Adapter executes trusted local code: explicit opt-in required');
    config.runner.module = path.resolve(base, config.runner.module);
    config.runner.moduleHash = hash(await import('node:fs/promises').then(fs => fs.readFile(config.runner.module, 'utf8')));
    const fsAdapter = await import('node:fs/promises');
    const moduleDir = path.dirname(config.runner.module);
    config.runner.dependencyHash = hash(await Promise.all((await fsAdapter.readdir(moduleDir)).filter(n => n.endsWith('.mjs')).sort().map(async n => [n, hash(await fsAdapter.readFile(path.join(moduleDir, n), 'utf8'))])));
    if (config.runner.module.endsWith('swe-adapter.mjs')) {
      const r = config.runner.options?.dsh;
      assert(r && r.type !== 'adapter' && r.provider && r.model && r.command && r.profile && r.permission === 'workspace-write' && r.captureSessions === true, 'SWE adapter requires explicit isolated DSH route');
      assert(path.isAbsolute(r.home) && r.home !== path.resolve(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh'), 'SWE adapter needs non-default absolute dedicated DSH_HOME');
      assert(r.acknowledgeIsolation === true && r.provenance?.dsh && r.provenance?.ops, 'SWE adapter requires isolation acknowledgment and DSH/OPS provenance');
      assert(!/REPLACE|YOUR_|PIN_/i.test([r.provider, r.model, r.provenance.dsh, r.provenance.ops].join(' ')), 'Replace SWE DSH route placeholders');
      integer(r.timeoutMs, 1000, 3600000, 'nested DSH timeoutMs');
    }
    integer(config.runner.timeoutMs, 1000, 3600000, 'timeoutMs');
  }
  assert(config.runner.type !== 'dsh' || config.runner.home !== path.resolve(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh'), 'Refusing default stable DSH home');
  validateBudget(config);
  // Bump when evaluator, accounting or selection semantics change; old evidence must never be silently reused.
  config.engineVersion = 'ops-ga-engine-1';
  const fs = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const sourceDir = fileURLToPath(new URL('.', import.meta.url));
  config.engineHash = hash(await Promise.all((await fs.readdir(sourceDir)).filter(n => n.endsWith('.mjs')).sort().map(async n => [n, hash(await fs.readFile(path.join(sourceDir, n), 'utf8'))])));
  config.fingerprint = hash(config);
  return config;
}
