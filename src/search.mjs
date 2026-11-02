import path from 'node:path';
import { mkdir, open, unlink, readFile } from 'node:fs/promises';
import { assert, hash, load, save, random } from './common.mjs';
import { baseline, breed, candidateId, render, select, validateGenome } from './genome.mjs';
import { evaluate, propose } from './runner.mjs';
import { costMicros, dollarsToMicros } from './budget.mjs';

export class Budget {
  constructor(config, state, persist) { this.config = config; this.limit = config.budget; this.state = state; this.persist = persist; }
  async reserve(episode) {
    const b = this.state.budget;
    assert(b.calls + 1 <= this.limit.maxCalls && b.episodes + Number(episode) <= this.limit.maxEpisodes && b.tokens + this.limit.reserveTokensPerCall <= this.limit.maxTokens, 'Budget exhausted; increase limits in a NEW run, or stop');
    const reserved = this.limit.reserveUSDPerCall ? dollarsToMicros(this.limit.reserveUSDPerCall) : 0;
    assert(!reserved || (b.costMicros ?? 0) + reserved <= dollarsToMicros(this.limit.maxUSD), 'USD budget exhausted: no further calls');
    b.calls++; b.episodes += Number(episode); b.tokens += this.limit.reserveTokensPerCall;
    b.costMicros = (b.costMicros ?? 0) + reserved;
    b.pending = true;
    await this.persist();
  }
  async settle(tokens) {
    const b = this.state.budget;
    b.tokens += tokens - this.limit.reserveTokensPerCall;
    if (this.limit.reserveUSDPerCall) b.costMicros += costMicros({ tokens }, this.config) - dollarsToMicros(this.limit.reserveUSDPerCall);
    b.pending = false;
    await this.persist();
    assert(b.tokens <= this.limit.maxTokens && (!this.limit.maxUSD || b.costMicros <= dollarsToMicros(this.limit.maxUSD)), 'Actual usage exceeded reservation: budget overshot; run stopped');
  }
}
export async function withState(config, lane, fn) {
  const root = path.resolve(path.join(config.output, lane.id));
  await mkdir(root, { recursive: true });
  // One global ledger/lock: all optimization lanes share the user's total budget.
  const lockPath = path.join(config.output, 'run.lock');
  let lock;
  try { lock = await open(lockPath, 'wx'); } catch (e) { if (e.code === 'EEXIST') throw new Error(`Run locked: ${lockPath}; verify no live owner before manual recovery`); throw e; }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
    const file = path.join(root, 'state.json');
    let state;
    try { state = await load(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!state) state = { version: 1, fingerprint: config.fingerprint, generation: 0, candidates: {}, evaluations: {}, plans: {}, history: [], budget: { calls: 0, episodes: 0, tokens: 0, pending: false }, synthetic: config.runner.type === 'mock' };
    assert(state.fingerprint === config.fingerprint, 'Configuration changed: choose a new output directory (cached results are fingerprint-bound)');
    const ledgerFile = path.join(config.output, 'budget.json');
    let ledger;
    try { ledger = await load(ledgerFile); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!ledger) ledger = { fingerprint: config.fingerprint, budget: state.budget };
    assert(ledger.fingerprint === config.fingerprint, 'Configuration changed: global budget fingerprint differs');
    state.budget = ledger.budget;
    assert(!state.budget.pending, 'Interrupted/unknown call: reservation retained. Inspect private evidence and budget before manual recovery; never auto-retry a possibly billed call');
    const persist = async () => { await save(ledgerFile, ledger); await save(file, state); };
    await persist();
    return await fn({ state, root, persist, budget: new Budget(config, state, persist) });
  } finally { await lock.close(); await unlink(lockPath); }
}
async function score(config, lane, genome, split, ctx) {
  const { state, root, persist, budget } = ctx;
  const id = candidateId(lane, genome);
  state.candidates[id] = genome;
  const results = [];
  for (const task of config.tasks.filter(t => t.split === split)) {
    const key = `${id}/${split}/${task.id}`;
    if (!state.evaluations[key]) {
      await budget.reserve(true);
      // Each trial is in its own workspace; saved results only reused within exact config fingerprint.
      const result = await evaluate(config, lane, genome, { ...task, baselineWithoutGuidance: id === candidateId(lane, baseline(lane)) }, path.join(root, 'episodes', id, split, task.id));
      state.evaluations[key] = result;
      await budget.settle(result.tokens);
      await persist();
    }
    results.push(state.evaluations[key]);
  }
  return { id, genome, results, successes: results.filter(r => r.success).length, tokens: results.reduce((s, r) => s + r.tokens, 0) };
}
export async function runSearch(config, lane) {
  return withState(config, lane, async ctx => {
    const { state, root, persist, budget } = ctx;
    assert(!state.finalStarted, 'Final holdout was already opened. Start a new run with a NEW held-out task suite');
    const initial = baseline(lane);
    const reference = await score(config, lane, initial, 'train', ctx);
    const gateReference = await score(config, lane, initial, 'gate', ctx);
    for (let generation = state.generation; generation < config.search.generations; generation++) {
      const rng = random(config.seed + generation);
      const previous = state.history.at(-1)?.elites ?? [reference.id];
      const parents = previous.map(id => state.candidates[id]);
      const plan = state.plans[generation] ?? [initial, ...parents].filter((g, i, a) => a.findIndex(x => hash(x) === hash(g)) === i);
      state.plans[generation] = plan;
      let attempts = 0;
      while (plan.length < config.search.population && attempts++ < config.search.population * 6) {
        let genome = breed(lane, parents[Math.floor(rng() * parents.length)], parents[Math.floor(rng() * parents.length)], rng);
        if (config.runner.type !== 'mock' && config.search.llmMutation !== false) {
          await budget.reserve(false);
          const reply = await propose(config, lane, parents, state.history.map(h => ({ generation: h.generation, training: h.training })).concat((state.rejections ?? []).slice(-10).map(r => ({ rejection: r.reason }))), path.join(root, 'proposals', `${generation}-${state.budget.calls}`));
          await budget.settle(reply.tokens);
          try { genome = validateGenome(lane, JSON.parse(reply.text)); }
          catch (error) { state.rejections ??= []; state.rejections.push({ generation, reason: error.message }); await persist(); continue; }
        }
        if (!plan.some(g => hash(g) === hash(genome))) { plan.push(genome); await persist(); }
      }
      const training = [];
      for (const genome of plan) training.push(await score(config, lane, genome, 'train', ctx));
      const shortlisted = select(training, reference, config.maxRegressions ?? 0).slice(0, config.search.elites);
      const gated = [];
      for (const row of shortlisted) gated.push(await score(config, lane, row.genome, 'gate', ctx));
      const qualified = select(gated, gateReference, config.maxRegressions ?? 0);
      const elites = qualified.length ? qualified.map(r => r.id) : [reference.id];
      state.history.push({ generation, elites, training: training.map(({ id, tokens, successes }) => ({ id, tokens, successes })), gate: gated.map(({ id, tokens, successes }) => ({ id, tokens, successes })) });
      state.winner = elites[0]; state.generation = generation + 1;
      await persist();
    }
    await save(path.join(root, 'candidate.json'), { lane: lane.id, genome: state.candidates[state.winner], fingerprint: config.fingerprint, synthetic: state.synthetic, status: 'selected-on-tuning-gate-not-final-validated' });
    return { lane: lane.id, winner: state.winner, generations: state.generation, budget: state.budget, synthetic: state.synthetic, artifact: path.join(root, 'candidate.json') };
  });
}
export async function validateFinal(config, lane) {
  return withState(config, lane, async ctx => {
    const { state, persist } = ctx;
    assert(state.winner && state.generation === config.search.generations, 'Search must finish before final evaluation');
    if (state.final) return state.final;
    state.finalStarted = true;
    await persist();
    const reference = await score(config, lane, baseline(lane), 'test', ctx);
    const candidate = await score(config, lane, state.candidates[state.winner], 'test', ctx);
    const regressions = candidate.results.filter((r, i) => reference.results[i].success && !r.success).map(r => r.task);
    state.final = { status: regressions.length || !candidate.results.every(r => r.safety) ? 'rejected' : 'no-observed-regression', regressions, baselineTokens: reference.tokens, candidateTokens: candidate.tokens, savings: 1 - candidate.tokens / reference.tokens, baselineSuccesses: reference.successes, candidateSuccesses: candidate.successes, tasks: reference.results.length, synthetic: state.synthetic, statisticalNonInferiorityProven: false };
    await persist(); return state.final;
  });
}
export async function exportWinner(config, lane, destination) {
  return withState(config, lane, async ({ state }) => {
    assert(state.final?.status === 'no-observed-regression' && !state.synthetic && Object.values(state.evaluations).every(r => r.synthetic === false), 'Export requires a real completed final evaluation without observed regressions');
    assert(state.final.baselineSuccesses > 0 && state.final.candidateSuccesses >= state.final.baselineSuccesses, 'Cannot export an all-failed or quality-degraded final suite');
    assert(state.final.candidateTokens < state.final.baselineTokens, 'No measured token improvement');
    await save(destination, { version: 1, lane: lane.id, fingerprint: config.fingerprint, guidance: render(lane, state.candidates[state.winner]), genome: state.candidates[state.winner], evidence: state.final, productionModelCallsAdded: 0 });
    return { destination, note: 'Review and integrate manually; no OPS source or profile was changed' };
  });
}
