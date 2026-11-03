import { assert } from './common.mjs';
import { dollarsToMicros, monetaryLimits } from './budget.mjs';

// Planning only: no sessions, no holdout answers, no state writes. Settled usage
// can be cheaper than these bounds; never turn an estimate into spend authority.
export function preflight(config, lane) {
  assert(config.tasks?.length > 0, 'Preflight requires loaded tasks');
  const repetitions = config.evaluation?.repetitions ?? 1;
  const count = split => config.tasks.filter(task => task.split === split).length * repetitions;
  const train = count('train'), gate = count('gate'), test = count('test');
  const baselineEpisodes = train + gate;
  const proposalsPerGeneration = config.runner.type !== 'mock' && config.search.llmMutation !== false && lane.kind !== 'source'
    ? config.search.population * 6 : 0;
  // Conservative: ignores candidate cache hits, identity-control holdouts, and
  // early rejection. Proposal attempts have the same bound as runSearch.
  const searchEpisodes = baselineEpisodes + config.search.generations * (config.search.population * train + config.search.elites * gate);
  const episodes = searchEpisodes + test * 2;
  const calls = episodes + config.search.generations * proposalsPerGeneration;
  const money = monetaryLimits(config.budget);
  const reserveMicros = config.runner.type === 'mock' || !money.reserve ? 0 : dollarsToMicros(money.reserve);
  const upperBound = { calls, episodes, tokens: calls * config.budget.reserveTokensPerCall, reservedMicros: calls * reserveMicros };
  const plannedFits = upperBound.calls <= config.budget.maxCalls && upperBound.episodes <= config.budget.maxEpisodes && upperBound.tokens <= config.budget.maxTokens &&
    (!money.max || upperBound.reservedMicros <= dollarsToMicros(money.max));
  return { lane: lane.id, inferenceRun: false, suite: { train, gate, test, repetitions }, baselineEpisodes, upperBound, currency: money.currency,
    baselineCallCapsFit: baselineEpisodes <= Math.min(config.budget.maxCalls, config.budget.maxEpisodes), plannedFits,
    warnings: [...(!plannedFits ? ['Conservative full-campaign bound exceeds configured caps; the ledger may stop before completion. Do not raise the approved monetary ceiling without authorization.'] : []),
      ...(config.runner.type !== 'mock' && proposalsPerGeneration ? ['Duplicate/invalid LLM proposals can consume paid calls; reviewed seeds and llmMutation:false avoid this overhead.'] : [])],
    note: 'Fresh-run conservative bound, not required spend or a completion guarantee. Actual usage settles after each session; cache savings are never assumed. Each lane shares the same total ledger.' };
}
export function preflightSummary(config, reports) {
  const total = reports.reduce((a, r) => { for (const k of Object.keys(a)) a[k] += r.upperBound[k]; return a; }, { calls: 0, episodes: 0, tokens: 0, reservedMicros: 0 });
  const money = monetaryLimits(config.budget);
  return { upperBound: total, currency: money.currency, plannedFits: total.calls <= config.budget.maxCalls && total.episodes <= config.budget.maxEpisodes && total.tokens <= config.budget.maxTokens && (!money.max || total.reservedMicros <= dollarsToMicros(money.max)), inferenceRun: false };
}
