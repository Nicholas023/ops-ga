import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { assert, save } from './common.mjs';
import { execute } from './process.mjs';
import { dshLaunch, runtimePatch } from './runner.mjs';

// Offline composition checks only. Never send a task or retain a credential-bearing dump.
export async function doctor(config) {
  const sourceAdapter = config.runner.type === 'adapter' && config.runner.module?.endsWith('ops-source-adapter.mjs');
  const runner = config.runner.type === 'dsh' ? config.runner
    : config.runner.type === 'adapter' && !sourceAdapter ? config.runner.options?.dsh : null;
  if (!runner) return { runner: config.runner.type, config: config.fingerprint, inferenceRun: false, runtimeChecked: false,
    ...(sourceAdapter ? { note: 'Source runtime composition is checked against the freshly prepared per-episode profile, not the template home.' } : {}) };
  await mkdir(runner.home, { recursive: true });
  const overlay = path.join(config.output, 'doctor.patch.json');
  await save(overlay, runtimePatch(runner));
  const env = { DSH_HOME: runner.home, DSH_PERMISSION_MODE: runner.permission };
  const launcher = dshLaunch(runner);
  const version = await execute(launcher.command, [...launcher.args, '--version'], { env, timeoutMs: 30000 });
  const help = await execute(launcher.command, [...launcher.args, '--profile', runner.profile, '--help'], { env, timeoutMs: 60000 });
  assert(help.stdout.includes('--json'), 'Profile is not headless-compatible');
  const dump = await execute(launcher.command, [...launcher.args, '--profile', runner.profile, '--patch', overlay, '--dump-config'], { env, timeoutMs: 60000 });
  const entries = new Map();
  for (const block of dump.stdout.split(/(?=^- id: )/m)) {
    const match = block.match(/^- id: ([^\r\n]+)/m);
    if (match) entries.set(match[1].trim(), block);
  }
  for (const row of runtimePatch(runner)) {
    const block = entries.get(row.id);
    assert(block, `Runtime overlay missing ${row.id}`);
    if (row.disabled) assert(/^  disabled: true\s*$/m.test(block), `Runtime did not disable ${row.id}`);
    for (const [key, value] of Object.entries(row.config ?? {})) assert(block.includes(`${key}: ${value}`) || block.includes(`${key}: '${value}'`) || block.includes(`${key}: "${value}"`), `Runtime config mismatch ${row.id}.${key}`);
  }
  return { version: version.stdout.trim(), config: config.fingerprint, inferenceRun: false, runtimeChecked: true, wireExposureVerified: false,
    note: 'Composed configuration only, not actual tool exposure or sandbox proof. Source adapters must additionally check the prepared episode profile.' };
}
