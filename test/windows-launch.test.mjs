import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { execute } from '../src/process.mjs';
import { dshLaunch } from '../src/runner.mjs';
import { Budget } from '../src/search.mjs';
import { validateBudget } from '../src/budget.mjs';

test('Windows cmd carrier forwards UTF-8 stdin with headless --json, no lone dash', { skip: process.platform !== 'win32' }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ops-ga-stdin-'));
  const carrier = path.join(dir, 'probe.cmd');
  const script = path.join(dir, 'read.mjs');
  await writeFile(script, "let s='';process.stdin.setEncoding('utf8');for await(const c of process.stdin)s+=c;console.log(JSON.stringify({input:s}));");
  await writeFile(carrier, `@echo off\r\n"${process.execPath}" "${script}"\r\n`);
  const launcher = dshLaunch({ command: carrier, args: [] });
  const result = await execute(launcher.command, [...launcher.args, '--json'], { input: 'hello 中文', timeoutMs: 10000 });
  assert.equal(JSON.parse(result.stdout).input.trimEnd(), 'hello 中文');
});
test('CNY budget uses CNY pricing without conversion or granting USD', async () => {
  const c = { runner: { type: 'dsh' }, budget: { currency: 'CNY', maxCNY: 5, reserveCNYPerCall: 0.4, reserveTokensPerCall: 50000, maxTokens: 600000, maxCalls: 24, maxEpisodes: 18, confirmedByUser: true, confirmation: 'User approved CNY 5', rates: { inputCNYPerMillion: 2, outputCNYPerMillion: 8, source: 'User official price table', checkedAt: '2026-11-02' } } };
  validateBudget(c);
  const state = { budget: { tokens: 0, calls: 0, episodes: 0 } };
  const budget = new Budget(c, state, async () => {});
  await budget.reserve(true); await budget.settle(10000);
  assert.equal(state.budget.currency, 'CNY'); assert.equal(state.budget.costMicros, 80000);
});
