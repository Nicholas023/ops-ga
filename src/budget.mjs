import { assert, integer } from './common.mjs';

// Integer millionths of the declared currency (not necessarily USD).
export function dollarsToMicros(value) {
  assert(typeof value === 'number' && Number.isFinite(value) && value > 0, 'Budget amount must be an explicit positive number');
  const amount = Math.ceil(value * 1000000);
  integer(amount, 1, Number.MAX_SAFE_INTEGER, 'currency millionths');
  return amount;
}
export function monetaryLimits(budget) {
  const currency = budget.currency ?? 'USD';
  return { currency, max: currency === 'CNY' ? budget.maxCNY : budget.maxUSD, reserve: currency === 'CNY' ? budget.reserveCNYPerCall : budget.reserveUSDPerCall };
}
export function validateBudget(config) {
  if (config.runner.type === 'mock') return;
  assert(['USD', 'CNY'].includes(config.budget.currency), 'Real runs require explicit USD or CNY budget currency');
  const money = monetaryLimits(config.budget);
  dollarsToMicros(money.max);
  dollarsToMicros(money.reserve);
  assert(money.reserve <= money.max, 'Call reservation exceeds total monetary budget');
  assert(config.budget.confirmedByUser === true, 'User must explicitly confirm budget before real runs');
  assert(config.budget.confirmation && typeof config.budget.confirmation === 'string', 'Record user budget confirmation without private data');
  validatePricing(config.budget);
  const conservativeReservation = config.budget.reserveTokensPerCall * highestRate(config) / 1000000;
  assert(money.reserve >= conservativeReservation, 'Monetary reservation must cover token reservation at the highest configured rate');
}
export function validatePricing({ currency, rates }) {
  assert(['USD', 'CNY'].includes(currency), 'Pricing requires explicit USD or CNY currency');
  assert(rates && typeof rates === 'object', 'Real run needs pinned provider rates');
  for (const category of ['input', 'output']) assert(Number.isFinite(rates[`${category}${currency}PerMillion`]) && rates[`${category}${currency}PerMillion`] > 0, `Invalid positive price ${category}`);
  for (const category of ['cacheRead', 'cacheWrite']) {
    const rate = rates[`${category}${currency}PerMillion`];
    assert(rate === undefined || (Number.isFinite(rate) && rate >= 0), `Invalid price ${category}`);
  }
  assert(typeof rates.source === 'string' && rates.source.trim() && typeof rates.checkedAt === 'string' && rates.checkedAt.trim(), 'Pin pricing source and date');
  assert(!/REPLACE|PIN_|YOUR_/i.test(rates.source + rates.checkedAt), 'Replace pricing source/date placeholders before running');
}
function highestRate(config) {
  const rates = config.budget.rates, currency = config.budget.currency;
  return Math.max(...['input', 'output', 'cacheRead', 'cacheWrite'].map(k => rates[`${k}${currency}PerMillion`] ?? 0));
}
export function priceUsage(result, config) {
  integer(result.tokens, 0, Number.MAX_SAFE_INTEGER, 'priced tokens');
  if (config.runner.type === 'mock') return { estimatedMicros: 0, conservativeMicros: 0, method: 'synthetic', invoiceVerified: false };
  const conservativeMicros = Math.ceil(result.tokens * highestRate(config));
  integer(conservativeMicros, 0, Number.MAX_SAFE_INTEGER, 'conservative cost');
  const u = result.usage;
  // A total-only trusted adapter remains conservative; never infer a cache hit ratio.
  if (!u) return { estimatedMicros: conservativeMicros, conservativeMicros, method: 'total-only-upper-bound', invoiceVerified: false };
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) integer(u[key], 0, Number.MAX_SAFE_INTEGER, key);
  assert(u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens === result.tokens, 'Usage breakdown disagrees with priced tokens');
  if (u.reasoningTokens !== undefined) integer(u.reasoningTokens, 0, u.outputTokens, 'reasoning subset');
  const rates = config.budget.rates, currency = config.budget.currency;
  const rate = category => rates[`${category}${currency}PerMillion`];
  // Unknown cache prices use the upper bound, not an invented provider discount.
  const maxRate = highestRate(config);
  const cacheReadRate = rate('cacheRead') ?? maxRate, cacheWriteRate = rate('cacheWrite') ?? maxRate;
  const estimatedMicros = Math.ceil(u.inputTokens * rate('input') + u.outputTokens * rate('output') + u.cacheReadTokens * cacheReadRate + u.cacheWriteTokens * cacheWriteRate);
  integer(estimatedMicros, 0, Number.MAX_SAFE_INTEGER, 'estimated cost');
  return { estimatedMicros, conservativeMicros, method: 'usage-breakdown', cachePricesComplete: (!u.cacheReadTokens || rate('cacheRead') !== undefined) && (!u.cacheWriteTokens || rate('cacheWrite') !== undefined), invoiceVerified: false };
}
export function costMicros(result, config) { return priceUsage(result, config).estimatedMicros; }
