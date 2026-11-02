import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { hash, save } from '../src/common.mjs';
import { sourcePayload, prepareSource, snapshotTree } from '../src/source-snapshot.mjs';
import { execute } from '../src/process.mjs';
import { representativeTasks } from '../benchmarks/representative.mjs';
import { validateProtocol, pairedSchedule, pairedStatistics } from '../src/protocol.mjs';
import { readConfig } from '../src/config.mjs';
import { evaluate as sourceEvaluate } from '../benchmarks/ops-source-adapter.mjs';
import { prepareTask, verify } from '../src/runner.mjs';
import { runSearch, validateFinal } from '../src/search.mjs';
import { verifyExposure } from '../src/exposure.mjs';
import { applyEdits } from '../src/adapter.mjs';
import { apply as observe } from '../src/exposure-observer.mjs';
const tmp = () => mkdtemp(path.join(os.tmpdir(), 'ops-ga-architecture-'));
function lane(text = 'export const description = "Read files safely";\n') {
  return { id: 'schema', kind: 'source', genes: { description: { type: 'text', initial: text, maxChars: 1000, required: ['safely'] } },
    bindings: [{ gene: 'description', path: 'src/schema.ts', oldText: text, sha256: hash(text) }], seeds: [{ description: 'export const description = "Read safely";\n' }] };
}
test('stratified suite is split-disjoint and protocol validates coverage', () => {
  const c = { evaluation: { repetitions: 3, order: 'balanced', requireRepresentativeSuite: true }, tasks: representativeTasks() };
  validateProtocol(c); assert.equal(c.tasks.length, 18); assert.equal(c.taskManifestHash.length, 64);
  assert.throws(() => validateProtocol({ ...c, tasks: c.tasks.slice(1) }), /Missing train family/);
  const dupe = structuredClone(c); dupe.tasks[6] = { ...dupe.tasks[0], id: 'other', split: 'gate' };
  assert.throws(() => validateProtocol(dupe), /Missing gate family|Repeated task identity/);
});
test('source payload approval binds complete lane, exact edits, and protected paths', () => {
  const l = lane(), p = sourcePayload(l, l.seeds[0]); assert.equal(p.digest.length, 64);
  const changed = structuredClone(l); changed.protectedPolicy = 'new contract';
  assert.notEqual(p.digest, sourcePayload(changed, changed.seeds[0]).digest);
  for (const file of ['src/sandbox.ts', 'src/policy.ts', '../src/schema.ts', 'test/verifier.mjs', 'lib/schema.js']) {
    const bad = structuredClone(l); bad.bindings[0].path = file; assert.throws(() => sourcePayload(bad, bad.seeds[0]), /scope|authority/);
  }
  assert.throws(() => sourcePayload(l, { description: 'remove contracts' }), /protected/);
});
test('source replacements preserve every approved dollar substitution literally', async () => {
  const dir = await tmp(); await writeFile(path.join(dir, 'a.ts'), 'prefix OLD suffix');
  const replacement = "$& $$ $` $'";
  await applyEdits(dir, [{ path: 'a.ts', sha256: hash('prefix OLD suffix'), oldText: 'OLD', newText: replacement }], ['a.ts']);
  assert.equal(await readFile(path.join(dir, 'a.ts'), 'utf8'), `prefix ${replacement} suffix`);
});
test('nested tests/generated targets are excluded, ordinary nested files remain fingerprinted', async () => {
  for (const name of ['src/schema.test.ts', 'src/tests/verifier.ts', 'src/lib/generated.ts', 'src/runtime/helper.ts']) {
    const l = lane(); l.bindings[0].path = name; assert.throws(() => sourcePayload(l, l.seeds[0]), /protected/);
  }
  const dir = await tmp(); await mkdir(path.join(dir, 'src/runtime'), { recursive: true }); await writeFile(path.join(dir, 'src/runtime/helper.ts'), 'old');
  const before = hash(await snapshotTree(dir)); await writeFile(path.join(dir, 'src/runtime/helper.ts'), 'new');
  assert.notEqual(hash(await snapshotTree(dir)), before);
});
test('OPS snapshots use committed source only and cannot edit original checkout', async () => {
  const repo = await tmp(); await mkdir(path.join(repo, 'src')); const l = lane();
  await writeFile(path.join(repo, 'src/schema.ts'), l.genes.description.initial);
  await execute('git', ['init', repo]); await execute('git', ['-C', repo, '-c', 'core.autocrlf=false', 'add', '.']);
  await execute('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);
  const revision = (await execute('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
  await writeFile(path.join(repo, 'src/schema.ts'), 'LOCAL_UNCOMMITTED');
  const payload = sourcePayload(l, l.seeds[0]); const options = { repository: repo, revision, approvedPayloads: [] };
  const rejectedDir = await tmp();
  await assert.rejects(() => prepareSource(options, l, l.seeds[0], rejectedDir, false), /human approval/);
  options.approvedPayloads = [payload.digest];
  const built = await prepareSource(options, l, l.seeds[0], await tmp(), false);
  assert.equal(await readFile(path.join(built.root, 'src/schema.ts'), 'utf8'), l.seeds[0].description);
  assert.equal(await readFile(path.join(repo, 'src/schema.ts'), 'utf8'), 'LOCAL_UNCOMMITTED');
  const base = await prepareSource(options, l, Object.fromEntries(Object.entries(l.genes).map(([k, g]) => [k, g.initial])), await tmp(), true);
  assert.equal(await readFile(path.join(base.root, 'src/schema.ts'), 'utf8'), l.genes.description.initial);
});
test('balanced repeated schedule is predeclared and task-cluster statistics do not pretend independence', () => {
  const c = { tasks: [{ id: 'a', split: 'test' }], fingerprint: 'f', seed: 2, evaluation: { repetitions: 4 } };
  const plan = pairedSchedule(c, { id: 'l' }, 'base', 'candidate');
  assert.deepEqual(plan, pairedSchedule(c, { id: 'l' }, 'base', 'candidate'));
  assert.equal(plan.filter(p => p.order[0] === 'candidate').length, 2);
  assert(pairedSchedule(c, { id: 'l' }, 'base', 'base').every(p => p.order.length === 1 && !p.independentArms));
  const stats = pairedStatistics([{ task: 'a', tokenDelta: -20 }, { task: 'a', tokenDelta: -10 }]);
  assert.equal(stats.tasks, 1); assert.equal(stats.tokenDeltaCI95, null); assert.equal(stats.statisticalNonInferiorityProven, false);
});
test('search evaluates repeated isolated trials, resumes without rebilling, and freezes paired holdout order', async () => {
  const c = await readConfig('examples/demo.json'); c.output = await tmp(); c.evaluation = { repetitions: 3, order: 'balanced' };
  c.search = { population: 2, generations: 1, elites: 1 }; c.fingerprint = hash(c);
  await runSearch(c, c.lanes[0]); const file = path.join(c.output, c.lanes[0].id, 'state.json');
  const before = JSON.parse(await readFile(file)); await runSearch(c, c.lanes[0]); assert.equal(JSON.parse(await readFile(file)).budget.calls, before.budget.calls);
  const selected = JSON.parse(await readFile(file));
  selected.winner = selected.history[0].training.find(r => r.id !== selected.history[0].training[0].id).id;
  await save(file, selected);
  const final = await validateFinal(c, c.lanes[0]); assert.equal(final.pairs.length, 3);
  assert.equal(final.tasks, 1); assert.equal(final.pairedObservations, 3);
  assert.equal(final.protocol.schedule.length, 3); assert.equal(final.statistics.tasks, 1);
  assert.equal(new Set(final.pairs.map(p => p.baselineEvaluationId)).size, 3);
  const saved = JSON.parse(await readFile(file));
  const expected = final.protocol.schedule.flatMap(p => p.order.map(arm => `${arm === 'baseline' ? saved.history[0].training[0].id : saved.winner}/test/${p.task}~r${p.repetition}`));
  assert.deepEqual(final.protocol.actualExecution.map(r => r.evaluationId), expected);
});
test('six heldout families with three repeats remain six tasks and eighteen observations', async () => {
  const c = await readConfig('examples/demo.json'); c.output = await tmp(); c.tasks = representativeTasks();
  c.evaluation = { repetitions: 3, order: 'balanced', requireRepresentativeSuite: true }; validateProtocol(c);
  c.search = { population: 2, generations: 1, elites: 1 }; c.fingerprint = hash(c);
  await runSearch(c, c.lanes[0]); const final = await validateFinal(c, c.lanes[0]);
  assert.equal(final.tasks, 6); assert.equal(final.pairedObservations, 18); assert.equal(final.statistics.tasks, 6);
});
test('multi-file verifier rejects incomplete edits', async () => {
  const root = await tmp(); await writeFile(path.join(root, 'a'), 'new'); await writeFile(path.join(root, 'b'), 'old');
  const task = { check: { type: 'files-equal', values: { a: 'new', b: 'new' } } };
  assert.equal(await verify(task, root, ''), false); await writeFile(path.join(root, 'b'), 'new'); assert.equal(await verify(task, root, ''), true);
});
test('controlled adapter runs pinned snapshot, no-skip driver and actual wire probe end to end', async () => {
  const repo = await tmp(), l = lane(); await mkdir(path.join(repo, 'src')); await writeFile(path.join(repo, 'src/schema.ts'), l.genes.description.initial);
  await execute('git', ['init', repo]); await execute('git', ['-C', repo, '-c', 'core.autocrlf=false', 'add', '.']);
  await execute('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);
  const revision = (await execute('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
  const privateRoot = await tmp(), driver = path.join(privateRoot, 'driver.mjs'), fakeDSH = path.join(privateRoot, 'fake-dsh.mjs');
  await writeFile(driver, `import{readFile,mkdir,writeFile}from'node:fs/promises';import path from'node:path';const r=JSON.parse(await readFile(process.argv[2]));await mkdir(path.join(r.source,'lib'));await writeFile(path.join(r.source,'lib/index.mjs'),(await readFile(path.join(r.source,'src/schema.ts'),'utf8'))+'\\nexport function apply(ctx){ctx.tools.register({name:"ops_read",description,parameters:{type:"object"}})}');const home=path.join(r.episodeDirectory,'fresh-home');await mkdir(home);const sourceReceipt=JSON.parse(await readFile(path.join(r.episodeDirectory,'source.receipt.json')));await writeFile(process.argv[3],JSON.stringify({version:1,sourceDigest:sourceReceipt.sourceDigest,buildPassed:true,contractPassed:true,skipped:0,home,profile:'headless',checks:[{id:'fixture-contract',status:'passed'}]}));`);
  const observer = new URL('../src/exposure-observer.mjs', import.meta.url).href;
  await writeFile(fakeDSH, `import{readFile}from'node:fs/promises';import{apply}from${JSON.stringify(observer)};
let s='';for await(const c of process.stdin)s+=c;
const args=process.argv.slice(2), rows=[{id:'dsh-ops',name:'installed-package',disabled:false}];
// Pinned DSH applyEntryPatches semantics: name guards an existing row; only insert adds modules.
for(let i=0;i<args.length;i++)if(args[i]==='--patch')for(const patch of JSON.parse(await readFile(args[++i]))){
 if(patch.insert){if(patch.id)throw Error('fixture has no groups');rows.push(...patch.insert);continue;}
 const row=rows.find(r=>r.id===patch.id);if(!row)continue;if(patch.name&&patch.name!==row.name)continue;
 const {id,name,...overrides}=patch;Object.assign(row,overrides);
}
if(!rows.find(r=>r.id==='dsh-ops').disabled)throw Error('Installed OPS remained active');
let fn;const tools=[],services={sandboxPolicy:{resolve:()=>({mode:'workspace-write'})},sessions:{get:()=>({})}};
const ctx={tools:{register:t=>tools.push(t)},get:k=>services[k],on:(e,f)=>fn=f};
for(const row of rows)if(!row.disabled&&row.name.startsWith('file:')){const plugin=await import(row.name);plugin.apply(ctx,row.config);}
if(!tools.length)throw Error('Candidate module not loaded');
fn({provider:'fixture',model:'fake',sessionId:'isolated',tools},()=>{});
for(const e of [{type:'session',sessionId:'isolated'},{type:'status',phase:'step_start',turn:1,step:1},{type:'status',phase:'step_end',turn:1,step:1,usage:{inputTokens:20,outputTokens:2,cacheReadTokens:10}},{type:'status',phase:'turn_end',reason:{kind:'completed'}},{type:'final',text:'done'}])console.log(JSON.stringify(e));`);
  const dir = await tmp(), task = { id: 'fixture', split: 'test', prompt: 'test', files: {}, check: { type: 'answer-includes', value: 'done' } }, workspace = await prepareTask(dir, task);
  const payload = sourcePayload(l, l.seeds[0]);
  const options = { repository: repo, revision, driver, driverHash: hash(await readFile(driver, 'utf8')), approvedPayloads: [payload.digest],
    components: [{ id: 'dsh-ops', module: 'lib/index.mjs' }], exposure: { requiredTools: ['ops_read'], forbiddenTools: ['bash'] },
    dsh: { command: process.execPath, args: [fakeDSH], home: path.join(privateRoot, 'template'), profile: 'headless', permission: 'workspace-write', acknowledgeIsolation: true, provider: 'fixture', model: 'fake', timeoutMs: 10000 } };
  const result = await sourceEvaluate({ lane: l, genome: l.seeds[0], task, workspace, runnerOptions: options, budget: { reserveTokensPerCall: 100 } });
  assert.equal(result.success, true); assert.equal(result.exposure.status, 'verified'); assert.equal(result.source.payloadDigest, payload.digest);
  const candidateWire = JSON.parse((await readFile(path.join(dir, 'exposure.private.jsonl'), 'utf8')).trim());
  assert.equal(candidateWire.tools[0].description, 'Read safely');
  const baseDir = await tmp(), baseTask = { ...task, baselineWithoutGuidance: true }, baseWorkspace = await prepareTask(baseDir, baseTask);
  await sourceEvaluate({ lane: l, genome: Object.fromEntries(Object.entries(l.genes).map(([k,g])=>[k,g.initial])), task: baseTask, workspace: baseWorkspace, runnerOptions: options, budget: { reserveTokensPerCall: 100 } });
  const baselineWire = JSON.parse((await readFile(path.join(baseDir, 'exposure.private.jsonl'), 'utf8')).trim());
  assert.equal(baselineWire.tools[0].description, 'Read files safely'); assert.notEqual(candidateWire.schemaDigest, baselineWire.schemaDigest);
  assert.equal(await readFile(path.join(repo, 'src/schema.ts'), 'utf8'), l.genes.description.initial);
});
test('preparation scaffold requires independent no-skip checks and isolates its home', async () => {
  const dir = await tmp(), scripts = await tmp(), source = path.join(dir, 'ops-source'); await mkdir(source);
  const build = path.join(scripts, 'build.mjs'), contract = path.join(scripts, 'contract.mjs'), provision = path.join(scripts, 'provision.mjs');
  await writeFile(build, ''); await writeFile(contract, 'console.log(JSON.stringify({passed:2,failed:0,skipped:0}))'); await writeFile(provision, '');
  const step = async script => ({ script, sha256: hash(await readFile(script, 'utf8')), args: [] });
  const config = { build: [await step(build)], contract: [await step(contract)], provision: await step(provision), profile: 'isolated' };
  const input = path.join(dir, 'input.json'), output = path.join(dir, 'response.json');
  await save(path.join(dir, 'source.receipt.json'), { sourceDigest: 'fixed' });
  await save(input, { source, episodeDirectory: dir, driverConfig: config });
  const driver = new URL('../bin/prepare-ops-source.mjs', import.meta.url);
  await execute(process.execPath, [fileURLToPath(driver), input, output]);
  const result = JSON.parse(await readFile(output)); assert.equal(result.contractPassed, true); assert.equal(result.checks[0].passed, 2);
  assert.equal(result.home, path.join(dir, 'dsh-home'));
  const badDir = await tmp(); await mkdir(path.join(badDir, 'ops-source')); await save(path.join(badDir, 'source.receipt.json'), { sourceDigest: 'fixed' });
  await writeFile(contract, 'console.log(JSON.stringify({passed:2,failed:0,skipped:1}))'); config.contract = [await step(contract)];
  await save(path.join(badDir, 'input.json'), { source: path.join(badDir, 'ops-source'), episodeDirectory: badDir, driverConfig: config });
  await assert.rejects(() => execute(process.execPath, [fileURLToPath(driver), path.join(badDir, 'input.json'), path.join(badDir, 'out.json')]), /exited/);
});
test('wire exposure observer sees actual schemas and fails before dispatch on mismatches', async () => {
  const dir = await tmp(), output = path.join(dir, 'wire.jsonl'); let listener, dispatched = 0;
  const services = { sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) }, sessions: { get: () => ({}) } };
  observe({ get: k => services[k], on: (event, fn) => { assert.equal(event, 'llm/stream'); listener = fn; } },
    { output, payloadDigest: 'payload', expected: { provider: 'p', model: 'm', permission: 'workspace-write', requiredTools: ['ops_read'], forbiddenTools: ['bash'] } });
  const request = { provider: 'p', model: 'm', sessionId: 's1', tools: [{ name: 'ops_read', parameters: { type: 'object' } }], messages: ['DO_NOT_CAPTURE'] };
  listener(request, () => dispatched++); assert.equal(dispatched, 1);
  const receipt = await verifyExposure(output, { provider: 'p', model: 'm', permission: 'workspace-write', requiredTools: ['ops_read'] }, { steps: 1, sessionId: 's1' }, 'payload');
  assert.equal(receipt.status, 'verified'); assert(!(await readFile(output, 'utf8')).includes('DO_NOT_CAPTURE'));
  assert.throws(() => listener({ ...request, tools: [{ name: 'bash' }] }, () => dispatched++), /exposure mismatch/);
  assert.equal(dispatched, 1);
  await assert.rejects(() => verifyExposure(output, { provider: 'wrong' }, { steps: 1, sessionId: 's1' }, 'payload'), /differs/);
});
