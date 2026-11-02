import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { access } from 'node:fs/promises';
import { assert, load, save } from './common.mjs';

export async function initialize(file, options) {
  assert(Number.isFinite(options.budgetUSD) && options.budgetUSD > 0, 'Ask the paying user for an explicit positive --budget-usd first');
  assert(options.confirm === true, 'Use --confirm-budget only after explicit user approval');
  const out = path.resolve(file);
  try { await access(out); throw new Error('Refusing to overwrite local config'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const config = await load(path.join(root, 'examples', 'dsh.json'));
  config.output = path.join(path.dirname(out), '.runs', `run-${Date.now()}`);
  config.runner.home = path.join(path.dirname(out), '.local', 'dsh-home');
  if (process.platform === 'win32') config.runner.command = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd');
  config.lanes = ['operations', 'interface', 'ptc', 'discovery'].map(id => path.join(root, 'lanes', `${id}.json`));
  config.budget.maxUSD = options.budgetUSD;
  config.budget.reserveUSDPerCall = Math.min(1, options.budgetUSD);
  // Reduce the token reservation to fit the conservative per-call price reservation.
  const maxRate = Math.max(config.budget.rates.inputUSDPerMillion, config.budget.rates.outputUSDPerMillion);
  config.budget.reserveTokensPerCall = Math.floor(config.budget.reserveUSDPerCall * 1000000 / maxRate);
  config.budget.confirmedByUser = true;
  // init never authorizes the example prices; the paying user must replace/confirm actual rates.
  config.budget.rates.source = 'REPLACE_WITH_PROVIDER_PRICING_URL';
  config.budget.rates.checkedAt = 'REPLACE_WITH_DATE';
  config.budget.confirmation = `User explicitly approved at most USD ${options.budgetUSD}; ${new Date().toISOString()}`;
  await save(out, config);
  return { file: out, budgetUSD: options.budgetUSD, status: 'needs-provider-model-pricing-provenance-and-profile-setup', inferenceRun: false };
}
