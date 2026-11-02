import path from 'node:path';
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { assert, save, hash } from '../src/common.mjs';
import { execute } from '../src/process.mjs';

// Adapter around the official SWE-bench harness. It does not run inference and does not
// download repositories implicitly: caller supplies prediction patches and a pinned harness.
export async function evaluateSWE(config, { predictions, dataset, split = 'test', instanceIds = [], runId, outDir }) {
  assert(typeof config.python === 'string' && typeof config.harnessCwd === 'string', 'Pin Python and harness cwd');
  assert(typeof config.revision === 'string' && /^[a-f0-9]{40}$/.test(config.revision), 'Pin official harness commit');
  const actualRef = await execute('git', ['-C', config.harnessCwd, 'rev-parse', 'HEAD'], { timeoutMs: 10000 });
  assert(actualRef.stdout.trim() === config.revision, 'Official harness checkout differs from pinned revision');
  const dirty = await execute('git', ['-C', config.harnessCwd, 'diff', '--name-only', 'HEAD'], { timeoutMs: 10000 });
  assert(!dirty.stdout.trim(), 'Official harness tracked files must be unmodified');
  assert(typeof predictions === 'string' && typeof dataset === 'string' && typeof runId === 'string', 'SWE-bench inputs required');
  assert(!/[\\/\.]{2}/.test(runId) && /^[A-Za-z0-9_.-]+$/.test(runId), 'Unsafe run id');
  assert(config.pythonArgs === undefined || (Array.isArray(config.pythonArgs) && config.pythonArgs.every(a => typeof a === 'string')), 'Python launcher prefix must be argv strings');
  const args = [...(config.pythonArgs ?? []), '-m', 'swebench.harness.run_evaluation', '--dataset_name', dataset, '--split', split, '--predictions_path', predictions, '--run_id', runId, '--max_workers', '1'];
  if (instanceIds.length) args.push('--instance_ids', ...instanceIds);
  for (const id of instanceIds) assert(/^[A-Za-z0-9_.-]+__[A-Za-z0-9_.-]+$/.test(id), 'Invalid SWE-bench instance id');
  const report = path.join(config.harnessCwd, 'logs', 'evaluation', runId, 'results.json');
  try { await stat(path.dirname(report)); throw new Error('SWE-bench run_id already exists; refusing stale cached scores'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  await mkdir(outDir, { recursive: true });
  let result;
  try { result = await execute(config.python, args, { cwd: config.harnessCwd, timeoutMs: config.timeoutMs ?? 3600000, maxBytes: 32 * 1024 * 1024 }); }
  catch (error) {
    await writeFile(path.join(outDir, 'stdout.txt'), error.stdout ?? '', { mode: 0o600 });
    await writeFile(path.join(outDir, 'stderr.txt'), error.stderr ?? '', { mode: 0o600 });
    await save(path.join(outDir, 'grading-attempt.json'), { version: 1, status: 'failed', runId, code: error.code ?? null, failureCode: error.failureCode ?? 'grading.unknown' });
    throw error;
  }
  await writeFile(path.join(outDir, 'stdout.txt'), result.stdout, { mode: 0o600 });
  await writeFile(path.join(outDir, 'stderr.txt'), result.stderr, { mode: 0o600 });
  const reportText = await readFile(report, 'utf8');
  JSON.parse(reportText);
  await writeFile(path.join(outDir, 'official-report.json'), reportText);
  return { runId, dataset, split, report: path.join(outDir, 'official-report.json'), stdoutHash: hash(result.stdout), reportHash: hash(reportText), result: JSON.parse(reportText) };
}
