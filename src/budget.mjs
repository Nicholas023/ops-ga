import { assert, integer } from './common.mjs';

// USD uses integer microdollars to avoid floating point accumulated balances.
export function dollarsToMicros(value) {
  assert(typeof value === 'number' && Number.isFinite(value) && value > 0, 'Budget USD must be an explicit positive number');
  const amount = Math.ceil(value * 1000000);
  integer(amount, 1, Number.MAX_SAFE_INTEGER, 'USD microdollars');
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
  assert(config.budget.rates && typeof config.budget.rates === 'object', 'Real run needs conservative provider rates');
  for (const key of [`input${money.currency}PerMillion`, `output${money.currency}PerMillion`]) assert(Number.isFinite(config.budget.rates[key]) && config.budget.rates[key] >= 0, `Invalid price ${key}`);
  const inputRate = config.budget.rates[`input${money.currency}PerMillion`], outputRate = config.budget.rates[`output${money.currency}PerMillion`];
  assert(inputRate > 0 && outputRate > 0, 'Real run pricing must be positive');
  const conservativeReservation = config.budget.reserveTokensPerCall * Math.max(inputRate, outputRate) / 1000000;
  assert(money.reserve >= conservativeReservation, 'Monetary reservation must cover token reservation at the highest configured rate');
  assert(!/REPLACE|PIN_|YOUR_/i.test(config.budget.rates.source + config.budget.rates.checkedAt), 'Replace pricing source/date placeholders before running');
  assert(typeof config.budget.rates.source === 'string' && typeof config.budget.rates.checkedAt === 'string', 'Pin pricing source and date');
}
export function costMicros(result, config) {
  if (config.runner.type === 'mock') return 0;
  // Missing input/output breakdown: price ALL tokens at the more expensive rate.
  // Cached tokens charged at uncached price intentionally; pricing estimate != provider invoice.
  const rates = config.budget.rates;
  const currency = config.budget.currency;
  const rate = Math.max(rates[`input${currency}PerMillion`], rates[`output${currency}PerMillion`]);
  return Math.ceil(result.tokens * rate);
}
