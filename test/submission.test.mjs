import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { makeZip, readZip } from '../src/zip.mjs';
import { checkSubmission, digest, scanSecrets } from '../src/submission.mjs';
import { Budget, runSearch } from '../src/search.mjs';
import { validateBudget, costMicros } from '../src/budget.mjs';
import { readConfig } from '../src/config.mjs';
import { hash } from '../src/common.mjs';

test('ZIP round-trip, CRC corruption and traversal rejected', () => {
  const zip = makeZip({ 'trace.jsonl': '{"ok":true}\n', 'redaction.json': '{"reviewed":true}' });
  assert.equal(readZip(zip).get('trace.jsonl').toString(), '{"ok":true}\n');
  const bad = Buffer.from(zip); bad[30 + bad.readUInt16LE(26)] ^= 1;
  assert.throws(() => readZip(bad), /CRC/);
  assert.throws(() => makeZip({ '../outside.json': '{}' }), /Unsafe/);
  assert.throws(() => readZip(Buffer.alloc(22)), /directory/);
});
test('secret patterns catch API tokens and private keys', () => {
  assert.equal(scanSecrets('api_key=abcdefghijklmnopqrstuvwxyz'), true);
  assert.equal(scanSecrets('api_key=REDACTED'), false);
  assert.equal(scanSecrets('-----BEGIN RSA PRIVATE KEY-----'), true);
});
function paidConfig() {
  return { runner: { type: 'dsh' }, budget: { currency: 'USD', maxUSD: 1, reserveUSDPerCall: 0.6, reserveTokensPerCall: 100, maxTokens: 1000, maxEpisodes: 10, maxCalls: 10, confirmedByUser: true, confirmation: 'user approved $1', rates: { inputUSDPerMillion: 1, outputUSDPerMillion: 2, source: 'official URL', checkedAt: '2026-11-02' } } };
}
test('real runs require explicit positive USD budget and user confirmation', () => {
  const c = paidConfig(); validateBudget(c);
  assert.throws(() => validateBudget({ ...c, budget: { ...c.budget, confirmedByUser: false } }), /confirm/);
  assert.throws(() => validateBudget({ ...c, budget: { ...c.budget, maxUSD: 0 } }), /positive/);
  assert.throws(() => validateBudget({ ...c, budget: { ...c.budget, reserveUSDPerCall: 0.00001 } }), /cover/);
  assert.equal(costMicros({ tokens: 100 }, c), 200);
});
test('USD ledger refuses next reservation and pending reservation remains charged', async () => {
  const state = { budget: { tokens: 0, calls: 0, episodes: 0 } };
  const b = new Budget(paidConfig(), state, async () => {});
  await b.reserve(false);
  assert.equal(state.budget.costMicros, 600000);
  await assert.rejects(() => b.reserve(true), /pending usage/);
});
test('budget is shared across lanes, not multiplied per direction', async () => {
  const c = await readConfig('examples/demo.json');
  c.output = await mkdtemp(path.join(os.tmpdir(), 'ops-ga-shared-'));
  c.search.generations = 1; c.search.population = 2; c.search.elites = 1;
  c.fingerprint = hash(c);
  await runSearch(c, c.lanes[0]);
  const first = JSON.parse(await readFile(path.join(c.output, 'budget.json'))).budget.calls;
  await runSearch(c, c.lanes[1]);
  const second = JSON.parse(await readFile(path.join(c.output, 'budget.json'))).budget.calls;
  assert(second > first);
});
test('external PR requires full optimization package, paired reports and sessions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ops-ga-submission-'));
  const optimization = makeZip({ 'candidate.json': '{}', 'config.redacted.json': '{}', 'reproduce.json': '{}', 'checks.json': JSON.stringify({ staticPassed: true, contractPassed: true }), 'payload/lane.json': '{}', 'history.json': '[]', 'budget.json': '{"currency":"USD","maxUSD":10,"spentUSD":1,"confirmedByUser":true,"pending":false}', 'reports/base.json': '{"resolved_ids":["repo__issue-1"]}', 'reports/candidate.json': '{"resolved_ids":["repo__issue-1"]}'});
  const makeSession = tokens => [{ type: 'session', sessionId: `s${tokens}` }, { type: 'status', phase: 'step_end', usage: { inputTokens: tokens - 1, outputTokens: 1 } }, { type: 'status', phase: 'turn_end', reason: { kind: 'completed' } }, { type: 'final', text: 'done' }].map(JSON.stringify).join('\n');
  const sessions = makeZip({ 'redaction.json': JSON.stringify({ reviewed: true, method: 'manual and pattern scan' }), 'sessions/base.jsonl': makeSession(100), 'sessions/candidate.jsonl': makeSession(70) });
  const evidence = Buffer.from(JSON.stringify({ synthetic: false, rows: [{ instanceId: 'repo__issue-1', baseline: { resolved: true, usageComplete: true, tokens: 100, session: 'sessions/base.jsonl', report: 'reports/base.json' }, candidate: { resolved: true, usageComplete: true, tokens: 70, session: 'sessions/candidate.jsonl', report: 'reports/candidate.json' } }] }));
  const artifacts = {};
  for (const [key, name, bytes] of [['optimization', 'opt.zip', optimization], ['evidence', 'evidence.json', evidence], ['sessions', 'sessions.zip', sessions]]) { await writeFile(path.join(root, name), bytes); artifacts[key] = { path: name, sha256: digest(bytes) }; }
  const manifest = { version: 1, benchmark: { name: 'swe-bench-lite', dataset: 'SWE-bench/SWE-bench_Lite', revision: 'rev', harnessRepository: 'https://github.com/SWE-bench/SWE-bench', harnessRevision: 'ref', split: 'test', selectionProtocol: 'fixed', optimizationAndTestDisjoint: true }, environment: Object.fromEntries(['dsh', 'opsBaseline', 'opsCandidate', 'provider', 'model', 'reasoningEffort', 'permission', 'toolMode'].map(k => [k, 'pinned'])), artifacts, redaction: { reviewedByContributor: true, containsCredentials: false, redistributionAllowed: true } };
  const file = path.join(root, 'submission.json'); await writeFile(file, JSON.stringify(manifest));
  const result = await checkSubmission(file); assert.equal(result.valid, true); assert.equal(result.candidateTokens, 70);
  const aborted = makeZip({ 'redaction.json': JSON.stringify({ reviewed: true, method: 'manual' }), 'sessions/base.jsonl': makeSession(100),
    'sessions/candidate.jsonl': makeSession(70).replace('completed', 'aborted') });
  await writeFile(path.join(root, 'sessions.zip'), aborted); manifest.artifacts.sessions.sha256 = digest(aborted); await writeFile(file, JSON.stringify(manifest));
  await assert.rejects(() => checkSubmission(file), /completed agent session/);
  manifest.artifacts.sessions.sha256 = '0'.repeat(64); await writeFile(file, JSON.stringify(manifest));
  await assert.rejects(() => checkSubmission(file), /SHA256/);
});
