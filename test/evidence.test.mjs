import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, writeFile, mkdir, symlink } from 'node:fs/promises';
import { priceUsage, validateBudget } from '../src/budget.mjs';
import { Budget, runSearch, validateFinal } from '../src/search.mjs';
import { parseHeadless, captureExecution } from '../src/runner.mjs';
import { execute } from '../src/process.mjs';
import { trainingFeedback, analyzeRun } from '../src/evidence.mjs';
import { readConfig } from '../src/config.mjs';
import { hash } from '../src/common.mjs';
import { scanSecrets, packSessions } from '../src/submission.mjs';

const tmp = () => mkdtemp(path.join(os.tmpdir(), 'ops-ga-evidence-'));
function paid() { return { runner: { type: 'dsh' }, budget: { currency: 'CNY', maxCNY: 5, reserveCNYPerCall: 2, reserveTokensPerCall: 200000, maxTokens: 1000000, maxCalls: 10, maxEpisodes: 10, confirmedByUser: true, confirmation: 'user approved', rates: { inputCNYPerMillion: 2, outputCNYPerMillion: 8, cacheReadCNYPerMillion: 0.04, source: 'pinned user price table', checkedAt: '2026-11-02' } } }; }
function stream() {
  return [{ type: 'session', sessionId: 's1' }, { type: 'status', phase: 'step_start', turn: 1, step: 1 },
    { type: 'tool_call', tool: 'ops_grep', callId: 't1', input: { secret: 'not copied' } }, { type: 'tool_result', callId: 't1', status: 'ok' },
    { type: 'status', phase: 'step_end', turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 20, totalTokens: 34 } },
    { type: 'status', phase: 'turn_end', reason: { kind: 'completed' } }, { type: 'final', text: 'private answer' }];
}
const encoded = es => es.map(JSON.stringify).join('\n');
test('DeepSeek cache pricing settles observed usage, not all tokens at output price', async () => {
  const c = paid(); validateBudget(c);
  const result = { tokens: 191600, steps: 20, usage: { inputTokens: 29467, outputTokens: 3925, cacheReadTokens: 158208, cacheWriteTokens: 0, reasoningTokens: 0 } };
  const priced = priceUsage(result, c);
  assert.equal(priced.estimatedMicros, 96663); // round up once per session
  assert.equal(priced.conservativeMicros, 1532800);
  assert.equal(priced.invoiceVerified, false);
  const state = { budget: { tokens: 0, calls: 0, episodes: 0 } }, budget = new Budget(c, state, async () => {});
  await budget.reserve(true); assert.equal(state.budget.costMicros, 2000000);
  await budget.settle(result);
  assert.equal(state.budget.costMicros, 96663); assert.equal(state.budget.estimatedSpentMicros, 96663);
  assert.equal(state.budget.conservativeSpentMicros, 1532800); assert.equal(state.budget.modelSteps, 20);
  assert.equal(state.budget.calls, 1); assert.equal(state.budget.pending, false);
  await assert.rejects(() => budget.settle(result), /No pending/);
});
test('unknown cache price and total-only adapters never assume DeepSeek discount', () => {
  const c = paid(); delete c.budget.rates.cacheReadCNYPerMillion;
  const p = priceUsage({ tokens: 100, usage: { inputTokens: 10, outputTokens: 0, cacheReadTokens: 90, cacheWriteTokens: 0 } }, c);
  assert.equal(p.estimatedMicros, 740); assert.equal(p.cachePricesComplete, false);
  assert.equal(priceUsage({ tokens: 100 }, c).estimatedMicros, 800);
  assert.throws(() => priceUsage({ tokens: 100, usage: { inputTokens: 0, outputTokens: 1, cacheReadTokens: 90, cacheWriteTokens: 0 } }, c), /disagrees/);
  c.budget.rates.cacheWriteCNYPerMillion = 20;
  assert.throws(() => validateBudget(c), /cover/);
});
test('invalid settlement keeps reservation pending and unchanged', async () => {
  const c = paid(), state = { budget: { calls: 0, episodes: 0, tokens: 0 } }, b = new Budget(c, state, async () => {});
  await b.reserve(true); const before = structuredClone(state.budget);
  await assert.rejects(() => b.settle({ tokens: -1 }), /Invalid/); assert.deepEqual(state.budget, before);
});
test('identified sessions reject duplicate/orphan/unclosed steps and preserve usage/tool facts', () => {
  const es = stream(), parsed = parseHeadless(encoded(es));
  assert.equal(parsed.usage.cacheReadTokens, 20); assert.equal(parsed.structure, 'identified-steps');
  assert.deepEqual(parsed.toolCounts, { ops_grep: 1 }); assert(!JSON.stringify(parsed).includes('not copied'));
  assert.throws(() => parseHeadless(encoded([...es.slice(0, 5), es[4], ...es.slice(5)])), /Duplicate\/orphan/);
  assert.throws(() => parseHeadless(encoded(es.filter((_, i) => i !== 1))), /orphan/);
  assert.throws(() => parseHeadless(encoded(es.filter((_, i) => i !== 4))), /No model steps/);
  assert.throws(() => parseHeadless(encoded([{ type: 'session' }, ...es.slice(1)])), /identity/);
});
test('process capture preserves failures and UTF-8 across byte boundaries', async () => {
  const text = '中文🧪', source = `const b=Buffer.from(${JSON.stringify(text)});for(let i=0;i<b.length;i++){process.stdout.write(b.subarray(i,i+1));await new Promise(r=>setTimeout(r,2));}`;
  assert.equal((await execute(process.execPath, ['--input-type=module', '-e', source])).stdout, text);
  const dir = await tmp();
  await assert.rejects(() => captureExecution(dir, process.execPath, ['-e', 'process.stdout.write("partial");process.stderr.write("diagnostic");process.exit(2)']), /exited/);
  assert.equal(await readFile(path.join(dir, 'session.private.jsonl'), 'utf8'), 'partial');
  const attempt = JSON.parse(await readFile(path.join(dir, 'attempt.json')));
  assert.equal(attempt.failureCode, 'process.nonzero'); assert.equal(attempt.billing, 'reserved_unknown');
  const cap = await tmp();
  await assert.rejects(() => captureExecution(cap, process.execPath, ['-e', 'console.log("x".repeat(10000))'], { maxBytes: 100 }), /output limit/);
  assert.equal((JSON.parse(await readFile(path.join(cap, 'attempt.json')))).captureComplete, false);
  assert((await readFile(path.join(cap, 'session.private.jsonl'))).length <= 100);
});
test('timeout, spawn and usage-guard failures all leave private attempt receipts', async () => {
  for (const scenario of ['timeout', 'spawn', 'guard']) {
    const dir = await tmp();
    const command = scenario === 'spawn' ? path.join(dir, 'missing-executable') : process.execPath;
    const args = scenario === 'timeout' ? ['-e', 'setTimeout(()=>{},10000)'] : ['-e', 'console.log("evidence");setTimeout(()=>{},10000)'];
    const options = scenario === 'timeout' ? { timeoutMs: 30 } : scenario === 'guard' ? { onStdout() { throw new Error('usage guard'); } } : {};
    await assert.rejects(() => captureExecution(dir, command, args, options));
    const attempt = JSON.parse(await readFile(path.join(dir, 'attempt.json')));
    assert.equal(attempt.failureCode, { timeout: 'runtime.timeout', spawn: 'process.spawn_failed', guard: 'runtime.usage_guard' }[scenario]);
    assert.equal(attempt.billing, 'reserved_unknown');
    if (scenario === 'guard') assert((await readFile(path.join(dir, 'session.private.jsonl'), 'utf8')).includes('evidence'));
  }
});
test('train feedback never leaks gate/test observations or tool payloads', () => {
  const state = { evaluations: { 'base/train/a': { tokens: 100, success: true }, 'c/train/a': { tokens: 140, success: true, toolCounts: { ops_grep: 2 } }, 'c/gate/SECRET_GATE': { tokens: 99 }, 'c/test/SECRET_TEST': { tokens: 88 } }, history: [{ generation: 1, training: [{ id: 'c' }], gate: 'SECRET_GATE' }] };
  const feedback = JSON.stringify(trainingFeedback(state, 'base'));
  assert(!feedback.includes('SECRET')); assert(feedback.includes('tokenDelta')); assert(feedback.includes('ops_grep'));
});
test('JSON credentials and unreviewed session packs are rejected', async () => {
  assert.equal(scanSecrets('{"api_key":"abcdefghijklmnopqrstuvwxyz"}'), true);
  assert.equal(scanSecrets('{"api_key":"REDACTED"}'), false);
  const dir = await tmp(); await writeFile(path.join(dir, 'redaction.json'), '{"reviewed":false,"method":"manual"}');
  await assert.rejects(() => packSessions(dir, ['redaction.json']), /redaction/);
  await writeFile(path.join(dir, 'redaction.json'), '{"reviewed":true,"method":" "}');
  await assert.rejects(() => packSessions(dir, ['redaction.json']), /method/);
});
test('invalid historical session produces incomplete record instead of crashing', async () => {
  const root = await tmp(), outside = await tmp();
  const episode = path.join(root, 'operations/episodes/c/train/t'); await mkdir(episode, { recursive: true });
  const text = 'not JSON\n'; await writeFile(path.join(episode, 'session.private.jsonl'), text);
  await writeFile(path.join(root, 'operations/state.json'), JSON.stringify({ evaluations: { 'c/train/t': { tokens: 9, synthetic: false, success: false } }, synthetic: false }));
  const output = path.join(outside, 'index.json'); await analyzeRun(root, output);
  const index = JSON.parse(await readFile(output));
  assert(index.issues.some(e => e.code === 'session.invalid'));
  assert.equal(index.episodes[0].source.sha256, hash(text)); assert.equal(index.episodes[0].source.structure, null);
  assert.equal(index.episodes[0].evidenceStatus, 'incomplete');
});
test('linked output cannot overwrite historical state', async () => {
  const root = await tmp(), outside = await tmp(); await mkdir(path.join(root, 'operations'));
  const state = '{"evaluations":{},"synthetic":true}'; const file = path.join(root, 'operations/state.json'); await writeFile(file, state);
  const link = path.join(outside, 'linked');
  try { await symlink(path.join(root, 'operations'), link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (e) { if (e.code === 'EPERM') return; throw e; }
  await assert.rejects(() => analyzeRun(root, path.join(link, 'state.json')), /linked|physically/);
  assert.equal(await readFile(file, 'utf8'), state);
});
test('unscored failed attempts and pending billing remain visible with unknown tokens', async () => {
  const root = await tmp(), outside = await tmp(), episode = path.join(root, 'operations/episodes/c/train/t');
  await mkdir(episode, { recursive: true });
  await writeFile(path.join(root, 'operations/state.json'), '{"evaluations":{},"synthetic":false}');
  await writeFile(path.join(episode, 'attempt.json'), '{"status":"failed","failureCode":"runtime.timeout","billing":"reserved_unknown"}');
  await writeFile(path.join(root, 'budget.json'), '{"budget":{"calls":1,"tokens":100,"pending":true}}');
  const output = path.join(outside, 'index.json'); await analyzeRun(root, output); const index = JSON.parse(await readFile(output));
  assert(index.issues.some(e => e.code === 'billing.pending_reservation'));
  assert(index.issues.some(e => e.code === 'accounting.invocation_count_mismatch'));
  assert(index.issues.some(e => e.code === 'evaluation.unscored_attempt'));
  assert.equal(index.attempts[0].tokens, null); assert.equal(index.attempts[0].failureCode, 'runtime.timeout');
});
test('identity controls are explicit; private analysis is deterministic and never alters source state', async () => {
  const c = await readConfig('examples/demo.json'); c.output = await tmp(); c.search.generations = 1; c.search.population = 2; c.search.elites = 1; c.fingerprint = hash(c);
  await runSearch(c, c.lanes[0]);
  // Force a baseline winner to exercise the identity-control path independently of synthetic noise.
  const file = path.join(c.output, c.lanes[0].id, 'state.json');
  const state = JSON.parse(await readFile(file)); state.winner = state.history[0].training[0].id;
  await writeFile(file, JSON.stringify(state));
  const final = await validateFinal(c, c.lanes[0]);
  assert.equal(final.comparisonKind, 'identity-control'); assert.equal(final.independentArms, false);
  assert(final.pairs.every(p => p.reusedEvaluation && p.tokenDelta === 0));
  const before = await readFile(file, 'utf8'), root = await tmp(), out = path.join(root, 'index.json');
  await analyzeRun(c.output, out); const first = await readFile(out, 'utf8'); await analyzeRun(c.output, out);
  assert.equal(first, await readFile(out, 'utf8')); assert.equal(before, await readFile(file, 'utf8'));
  const index = JSON.parse(first); assert.equal(index.visibility, 'private-unreviewed'); assert(index.episodes.every(e => e.evidenceStatus === 'synthetic'));
  await assert.rejects(() => analyzeRun(c.output, file), /outside/);
});
