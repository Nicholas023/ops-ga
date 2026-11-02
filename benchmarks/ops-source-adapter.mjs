import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile, realpath } from 'node:fs/promises';
import { assert, hash, load, save, safeFile } from '../src/common.mjs';
import { execute } from '../src/process.mjs';
import { prepareSource, snapshotTree } from '../src/source-snapshot.mjs';
import { evaluateWorkspace, propose as proposeDSH } from '../src/runner.mjs';

// Privileged, reviewed local driver owns builds and independent contract tests.
// Candidate strings NEVER select a command, profile, module path or verifier.
export async function evaluate(request) {
  const options = request.runnerOptions, dir = path.dirname(request.workspace);
  assert(options.dsh?.permission === 'workspace-write' && options.dsh.acknowledgeIsolation === true, 'Explicit isolated workspace-write DSH route required');
  assert(options.exposure && Array.isArray(options.components) && options.components.length > 0, 'Explicit wire exposure and OPS component mapping required');
  assert(path.isAbsolute(options.driver) && /^[a-f0-9]{64}$/.test(options.driverHash), 'Pin trusted build/contract driver');
  assert(hash(await readFile(options.driver, 'utf8')) === options.driverHash, 'Trusted driver changed');
  const snapshot = await prepareSource(options, request.lane, request.genome, dir, request.task.baselineWithoutGuidance === true);
  const driverInput = path.join(dir, 'driver-request.private.json'), driverOutput = path.join(dir, 'driver-response.private.json');
  await save(driverInput, { version: 1, source: snapshot.root, episodeDirectory: dir, payloadDigest: snapshot.receipt.payloadDigest, driverConfig: options.driverConfig ?? null });
  await execute(process.execPath, [options.driver, driverInput, driverOutput], { cwd: dir, timeoutMs: options.prepareTimeoutMs ?? 600000 });
  const built = await load(driverOutput);
  assert(built.version === 1 && built.sourceDigest === snapshot.receipt.sourceDigest, 'Driver must attest input source digest');
  assert(built.buildPassed === true && built.contractPassed === true && built.skipped === 0, 'Source candidate must pass independent no-skip build/contract gates');
  assert(Array.isArray(built.checks) && built.checks.length > 0 && built.checks.every(c => typeof c.id === 'string' && c.status === 'passed'), 'Driver must enumerate passing independent contract checks');
  assert(hash(await snapshotTree(snapshot.root)) === snapshot.receipt.sourceDigest, 'Build/gates changed protected candidate source');
  assert(path.isAbsolute(built.home) && built.profile && built.home !== options.dsh.home, 'Driver must provision fresh per-episode home/profile');
  const home = await realpath(built.home), episodeRoot = await realpath(dir);
  assert(home.startsWith(episodeRoot + path.sep), 'Driver DSH_HOME must be inside this episode directory');
  const patch = [], modules = [], insertedIds = new Set();
  for (const component of options.components) {
    assert(/^[a-zA-Z0-9_-]+$/.test(component.id) && component.module.startsWith('lib/'), 'Pin OPS row and compiled module');
    const module = await safeFile(snapshot.root, component.module);
    modules.push({ path: component.module, sha256: hash((await readFile(module)).toString('base64')) });
    const candidateId = `ops-ga-source-${component.id}`;
    assert(!insertedIds.has(candidateId), 'Duplicate source component'); insertedIds.add(candidateId);
    patch.push({ id: component.id, disabled: true });
    patch.push({ ...(component.groupId ? { id: component.groupId } : {}), insert: [{ id: candidateId, name: pathToFileURL(module).href, disabled: false, config: component.config ?? {}, ...(component.isolate ? { isolate: component.isolate } : {}) }] });
  }
  for (const id of options.disableRows ?? []) patch.push({ id, disabled: true });
  snapshot.receipt.compiledModules = modules;
  snapshot.receipt.driverHash = options.driverHash;
  snapshot.receipt.contractChecks = built.checks ?? [];
  await save(path.join(dir, 'source.receipt.json'), snapshot.receipt);
  const sourcePatch = path.join(dir, 'source.patch.json'); await save(sourcePatch, patch);
  const runner = { ...options.dsh, type: 'dsh', home, profile: built.profile, sourcePatch,
    payloadDigest: snapshot.receipt.payloadDigest, exposure: options.exposure };
  assert(!runner.exposure.forbiddenTools?.some(n => runner.exposure.requiredTools?.includes(n)), 'Contradictory exposure expectations');
  const config = { runner, budget: request.budget };
  const result = await evaluateWorkspace(config, request.lane, request.genome, { ...request.task, baselineWithoutGuidance: true }, dir, request.workspace);
  assert(hash(await snapshotTree(snapshot.root)) === snapshot.receipt.sourceDigest, 'Evaluated agent changed candidate source');
  for (const module of modules) assert(hash((await readFile(await safeFile(snapshot.root, module.path))).toString('base64')) === module.sha256, 'Compiled OPS component changed during evaluation');
  return { ...result, source: snapshot.receipt, contractChecks: built.checks ?? [], synthetic: false };
}
export async function propose(request) {
  // Source edits remain genome data and still require approval of their complete
  // payload digest. Automatic execution of newly proposed source is impossible.
  return proposeDSH({ runner: { ...request.runnerOptions.dsh, type: 'dsh' }, budget: request.budget }, request.lane, request.parents, request.feedback, process.cwd());
}
