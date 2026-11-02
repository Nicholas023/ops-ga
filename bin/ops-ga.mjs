#!/usr/bin/env node
import path from 'node:path';
import { readFile, mkdir } from 'node:fs/promises';
import { readConfig } from '../src/config.mjs';
import { assert, save, load } from '../src/common.mjs';
import { runSearch, validateFinal, exportWinner } from '../src/search.mjs';
import { dshLaunch, runtimePatch } from '../src/runner.mjs';
import { initialize } from '../src/init.mjs';
import { execute } from '../src/process.mjs';

const help = `ops-ga: offline genetic optimization, no production model overhead
Usage: node bin/ops-ga.mjs <command> --config <file> [options]
  init      Create private config: --out <file> --budget-usd <amount> --confirm-budget
  run       Search train + tuning gate (mock by default)
  validate  Evaluate the frozen winner once on held-out test tasks
  export    Export reviewed guidance: --lane <id> --out <file>
  status    Print private-run aggregate state without opening holdout tasks
  doctor    Check configuration, CLI version/help and composed safety patch; no inference
  patch     Write pinned runtime overlay: --out <file>
Options:
  --lane <id>         Run one isolated optimization direction
  --allow-paid       Explicit consent required for real/adapter run or validation
  --config <file>     Local config (never commit credentials or private tasks)
  --out <file>        Required for export/patch
  --help             Show this usage
Budget caps reserve before every call; provider overshoot can exceed a reservation.
Model sessions are not an OS security boundary. Use a dedicated DSH_HOME and profile.
`;
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help' || args.includes('--help')) { console.log(help); return; }
  assert(['init', 'run', 'validate', 'export', 'status', 'doctor', 'patch'].includes(command), 'Unknown command');
  const options = {};
  for (let i = 0; i < args.length; i++) {
    assert(['--config', '--lane', '--out', '--allow-paid', '--budget-usd', '--confirm-budget'].includes(args[i]), `Unknown option ${args[i]}`);
    if (args[i] === '--allow-paid') options.allowPaid = true;
    else if (args[i] === '--confirm-budget') options.confirm = true;
    else { const key = args[i].slice(2); assert(args[i + 1] && !args[i + 1].startsWith('--'), `Missing ${key}`); options[key] = args[++i]; }
  }
  if (command === 'init') { assert(options.out, '--out required'); console.log(JSON.stringify(await initialize(options.out, { budgetUSD: Number(options['budget-usd']), confirm: options.confirm }), null, 2)); return; }
  assert(options.config, '--config required');
  const config = await readConfig(options.config);
  const lanes = options.lane ? config.lanes.filter(l => l.id === options.lane) : config.lanes;
  assert(lanes.length, 'Unknown lane');
  if (['run', 'validate'].includes(command) && config.runner.type !== 'mock') assert(options.allowPaid, 'Real execution requires --allow-paid and explicit configured budget');
  if (command === 'patch') {
    assert(options.out && config.runner.type === 'dsh', 'patch requires DSH runner and --out');
    await save(path.resolve(options.out), runtimePatch(config.runner)); return;
  }
  if (command === 'doctor') {
    if (config.runner.type === 'dsh') {
      await mkdir(config.runner.home, { recursive: true });
      const overlay = path.join(config.output, 'doctor.patch.json');
      await save(overlay, runtimePatch(config.runner));
      const env = { DSH_HOME: config.runner.home, DSH_PERMISSION_MODE: config.runner.permission };
      const launcher = dshLaunch(config.runner);
      const version = await execute(launcher.command, [...launcher.args, '--version'], { env, timeoutMs: 30000 });
      const helpResult = await execute(launcher.command, [...launcher.args, '--profile', config.runner.profile, '--help'], { env, timeoutMs: 60000 });
      assert(helpResult.stdout.includes('--json'), 'Profile is not headless-compatible');
      const dump = await execute(launcher.command, [...launcher.args, '--profile', config.runner.profile, '--patch', overlay, '--dump-config'], { env, timeoutMs: 60000 });
      // Dump may contain API keys: do not print/store it. Verify required fragments only.
      const entries = new Map();
      for (const block of dump.stdout.split(/(?=^- id: )/m)) { const match = block.match(/^- id: ([^\r\n]+)/m); if (match) entries.set(match[1].trim(), block); }
      for (const row of runtimePatch(config.runner)) {
        const block = entries.get(row.id); assert(block, `Runtime overlay missing ${row.id}`);
        if (row.disabled) assert(/^  disabled: true\s*$/m.test(block), `Runtime did not disable ${row.id}`);
        for (const [key, value] of Object.entries(row.config ?? {})) assert(block.includes(`${key}: ${value}`) || block.includes(`${key}: '${value}'`) || block.includes(`${key}: \"${value}\"`), `Runtime config mismatch ${row.id}.${key}`);
      }
      console.log(JSON.stringify({ version: version.stdout.trim(), config: config.fingerprint, inferenceRun: false, note: 'Review actual profile provenance and disabled plugins before paid runs; configuration match is not a sandbox proof.' }, null, 2));
    } else console.log(JSON.stringify({ runner: config.runner.type, config: config.fingerprint, inferenceRun: false }));
    return;
  }
  if (command === 'export') assert(options.lane && options.out, 'export requires --lane and --out');
  for (const lane of lanes) {
    let result;
    if (command === 'run') result = await runSearch(config, lane);
    if (command === 'validate') result = await validateFinal(config, lane);
    if (command === 'export') result = await exportWinner(config, lane, path.resolve(options.out));
    if (command === 'status') {
      const state = await load(path.join(config.output, lane.id, 'state.json'));
      result = { lane: lane.id, generation: state.generation, winner: state.winner, budget: state.budget, final: state.final, synthetic: state.synthetic };
    }
    console.log(JSON.stringify(result, null, 2));
  }
}
main().catch(error => { console.error(`ops-ga: ${error.message}`); process.exitCode = 1; });
