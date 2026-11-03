#!/usr/bin/env node
import path from 'node:path';
import { readConfig } from '../src/config.mjs';
import { assert, save, load } from '../src/common.mjs';
import { runSearch, validateFinal, exportWinner } from '../src/search.mjs';
import { runtimePatch } from '../src/runner.mjs';
import { initialize } from '../src/init.mjs';
import { analyzeRun } from '../src/evidence.mjs';
import { writeRepresentativeSuite } from '../benchmarks/representative.mjs';
import { sourcePayload } from '../src/source-snapshot.mjs';
import { doctor as runDoctor } from '../src/doctor.mjs';
import { preflight, preflightSummary } from '../src/preflight.mjs';

const help = `ops-ga: offline genetic optimization, no production model overhead
Usage: node bin/ops-ga.mjs <command> --config <file> [options]
  init      Create private config: --out <file> --budget-usd <amount> --confirm-budget
  run       Search train + tuning gate (mock by default)
  validate  Evaluate the frozen winner once on held-out test tasks
  export    Export reviewed guidance: --lane <id> --out <file>
  suite     Write stratified 18-task local fixture suite: --out <file>; no inference
  payload   Inspect source candidate approval digest: --lane-file <file> --genome <file>
  analyze   Build private AI-readable index: --run-dir <existing-output> --out <file> [--pricing <file>]
  status    Print private-run aggregate state without opening holdout tasks
  doctor    Check configuration, CLI version/help and composed safety patch; no inference
  preflight Estimate lane calls/tokens/cost before inference; no inference
  patch     Write pinned runtime overlay: --out <file>
Options:
  --lane <id>         Run one isolated optimization direction
  --allow-paid       Explicit consent required for real/adapter run or validation
  --config <file>     Local config (never commit credentials or private tasks)
  --out <file>        Required for export/patch
  --help             Show this usage
Budget caps reserve per session invocation, not per model step; provider overshoot can exceed a reservation.
Model sessions are not an OS security boundary. Use a dedicated DSH_HOME and profile.
`;
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help' || args.includes('--help')) { console.log(help); return; }
  assert(['init', 'run', 'validate', 'export', 'status', 'doctor', 'patch', 'analyze', 'suite', 'payload', 'preflight'].includes(command), 'Unknown command');
  const options = {};
  for (let i = 0; i < args.length; i++) {
    assert(['--config', '--lane', '--out', '--run-dir', '--pricing', '--lane-file', '--genome', '--allow-paid', '--budget-usd', '--confirm-budget'].includes(args[i]), `Unknown option ${args[i]}`);
    if (args[i] === '--allow-paid') options.allowPaid = true;
    else if (args[i] === '--confirm-budget') options.confirm = true;
    else { const key = args[i].slice(2); assert(args[i + 1] && !args[i + 1].startsWith('--'), `Missing ${key}`); options[key] = args[++i]; }
  }
  if (command === 'init') { assert(options.out, '--out required'); console.log(JSON.stringify(await initialize(options.out, { budgetUSD: Number(options['budget-usd']), confirm: options.confirm }), null, 2)); return; }
  if (command === 'suite') { assert(options.out, '--out required'); console.log(JSON.stringify(await writeRepresentativeSuite(options.out), null, 2)); return; }
  if (command === 'payload') {
    assert(options['lane-file'] && options.genome, 'payload requires --lane-file and --genome');
    console.log(JSON.stringify(sourcePayload(await load(options['lane-file']), await load(options.genome)), null, 2)); return;
  }
  if (command === 'analyze') {
    assert(options['run-dir'] && options.out, 'analyze requires --run-dir and --out');
    console.log(JSON.stringify(await analyzeRun(options['run-dir'], options.out, options.pricing ? await load(options.pricing) : null), null, 2)); return;
  }
  assert(options.config, '--config required');
  const config = await readConfig(options.config);
  const lanes = options.lane ? config.lanes.filter(l => l.id === options.lane) : config.lanes;
  assert(lanes.length, 'Unknown lane');
  if (['run', 'validate'].includes(command) && config.runner.type !== 'mock') assert(options.allowPaid, 'Real execution requires --allow-paid and explicit configured budget');
  if (command === 'patch') {
    assert(options.out && config.runner.type === 'dsh', 'patch requires DSH runner and --out');
    await save(path.resolve(options.out), runtimePatch(config.runner)); return;
  }
  if (command === 'doctor') { console.log(JSON.stringify(await runDoctor(config), null, 2)); return; }
  if (command === 'preflight') {
    const reports = lanes.map(lane => preflight(config, lane));
    console.log(JSON.stringify({ inferenceRun: false, reports, sharedBudget: preflightSummary(config, reports) }, null, 2));
    return;
  }
  if (['run', 'validate'].includes(command) && config.runner.type !== 'mock') await runDoctor(config);
  if (command === 'export') assert(options.lane && options.out, 'export requires --lane and --out');
  for (const lane of lanes) {
    let result;
    if (command === 'run') result = await runSearch(config, lane);
    if (command === 'validate') result = await validateFinal(config, lane);
    if (command === 'export') result = await exportWinner(config, lane, path.resolve(options.out));
    if (command === 'status') {
      const state = await load(path.join(config.output, lane.id, 'state.json'));
      const ledger = await load(path.join(config.output, 'budget.json'));
      result = { lane: lane.id, generation: state.generation, winner: state.winner, budget: ledger.budget, final: state.final, synthetic: state.synthetic };
    }
    console.log(JSON.stringify(result, null, 2));
  }
}
main().catch(error => { console.error(`ops-ga: ${error.message}`); process.exitCode = 1; });
