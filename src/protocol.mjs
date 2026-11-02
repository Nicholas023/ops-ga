import { assert, hash, integer, random } from './common.mjs';

export function validateProtocol(config) {
  const p = config.evaluation ??= { repetitions: 1, order: 'balanced' };
  integer(p.repetitions, 1, 30, 'evaluation repetitions');
  assert(p.order === 'balanced', 'Only deterministic balanced paired order is supported');
  if (p.requireRepresentativeSuite) {
    const required = ['discovery', 'paging', 'multi-file-edit', 'aggregation', 'triage', 'repair'];
    for (const split of ['train', 'gate', 'test']) {
      const rows = config.tasks.filter(t => t.split === split);
      for (const family of required) assert(rows.some(t => t.family === family), `Missing ${split} family ${family}`);
    }
  }
  const instances = config.tasks.map(t => t.benchmark ? `${t.benchmark.dataset}/${t.benchmark.revision}/${t.benchmark.instanceId}` : hash({ prompt: t.prompt, files: t.files, check: t.check }));
  assert(new Set(instances).size === instances.length, 'Repeated task identity across optimization splits/tasks');
  config.taskManifestHash = hash(config.tasks.map((t, i) => ({ id: t.id, split: t.split, identity: instances[i], family: t.family ?? null })));
}
export const trialName = (task, repetition, repetitions) => repetitions === 1 ? task.id : `${task.id}~r${repetition}`;
export function pairedSchedule(config, lane, baselineId, candidateId) {
  return config.tasks.filter(t => t.split === 'test').flatMap(task => {
    const first = parseInt(hash({ seed: config.seed, task: task.id }).slice(0, 8), 16) % 2;
    return Array.from({ length: config.evaluation?.repetitions ?? 1 }, (_, repetition) => ({
      task: task.id, repetition, pairId: hash({ fingerprint: config.fingerprint, lane: lane.id, candidateId, task: task.id, repetition }),
      order: baselineId === candidateId ? ['baseline'] : (first + repetition) % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'],
      independentArms: baselineId !== candidateId
    }));
  });
}
// Cluster by task, not repetitions: repeated observations of one fixture are not
// independent extra tasks. This descriptive bootstrap is not a safety/noninferiority proof.
export function pairedStatistics(pairs, seed = 0) {
  assert(pairs.length > 0, 'No pairs');
  const groups = new Map();
  for (const p of pairs) {
    const rows = groups.get(p.task) ?? []; rows.push(p.tokenDelta); groups.set(p.task, rows);
  }
  const means = [...groups.values()].map(a => a.reduce((s, v) => s + v, 0) / a.length);
  const rng = random(seed), draws = [];
  for (let i = 0; i < 1000; i++) draws.push(means.reduce(s => s + means[Math.floor(rng() * means.length)], 0) / means.length);
  draws.sort((a, b) => a - b);
  return { method: 'descriptive-task-cluster-bootstrap-v1', tasks: means.length, pairedObservations: pairs.length,
    meanTaskTokenDelta: means.reduce((s, v) => s + v, 0) / means.length,
    tokenDeltaCI95: means.length > 1 ? [draws[25], draws[974]] : null,
    baselineOnlyResolved: pairs.filter(p => p.baselineSuccess && !p.candidateSuccess).length,
    candidateOnlyResolved: pairs.filter(p => !p.baselineSuccess && p.candidateSuccess).length,
    statisticalNonInferiorityProven: false, providerSamplingControlled: false, cacheControlled: false };
}
