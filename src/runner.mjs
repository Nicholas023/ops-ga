import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { assert, integer, safeFile, save, hash } from './common.mjs';
import { fileURLToPath } from 'node:url';
import { execute } from './process.mjs';
import { render } from './genome.mjs';
import { adapterCall } from './adapter.mjs';

export function dshLaunch(runner) {
  if (process.platform === 'win32' && /\.cmd$/i.test(runner.command)) return { command: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('../bin/launch-dsh.ps1', import.meta.url)), '-DshBin', runner.command, ...runner.args] };
  return { command: runner.command, args: runner.args };
}
export function usageGuard(config) {
  let pending = '', tokens = 0;
  return chunk => {
    pending += chunk;
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.type !== 'status' || event.phase !== 'step_end') continue;
      assert(event.usage, 'Usage missing during paid run; terminating owned process');
      const u = event.usage;
      const value = u.inputTokens + u.outputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
      assert(Number.isSafeInteger(value) && value >= 0, 'Invalid live usage');
      tokens += value;
      assert(tokens < config.budget.reserveTokensPerCall, 'Call token reservation reached; stopping owned process. Reservation remains charged.');
    }
  };
}
export function parseHeadless(text) {
  const events = text.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  assert(events[0]?.type === 'session', 'Missing DSH session event');
  assert(events.at(-1)?.type === 'final' && typeof events.at(-1).text === 'string', 'Missing DSH final event');
  const steps = events.filter(e => e.type === 'status' && e.phase === 'step_end');
  assert(steps.length > 0, 'No model steps');
  let tokens = 0;
  for (const step of steps) {
    assert(step.usage && !step.truncated, 'Missing exact usage; cannot score or claim savings');
    const u = step.usage;
    for (const key of ['inputTokens', 'outputTokens']) integer(u[key], 0, Number.MAX_SAFE_INTEGER, key);
    for (const key of ['cacheReadTokens', 'cacheWriteTokens', 'totalTokens', 'reasoningTokens']) if (u[key] !== undefined) integer(u[key], 0, Number.MAX_SAFE_INTEGER, key);
    // DSH normalized counters: inputTokens excludes cached input; reasoning is within output.
    const sum = u.inputTokens + u.outputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
    assert(u.totalTokens === undefined || u.totalTokens === sum, 'Inconsistent DSH totalTokens');
    tokens += sum;
  }
  const started = events.filter(e => e.type === 'status' && e.phase === 'step_start');
  const ended = new Set(steps.map(e => `${e.turn}/${e.step}`));
  assert(started.every(e => ended.has(`${e.turn}/${e.step}`)), 'Unclosed model step: usage may be incomplete');
  const ends = events.filter(e => e.type === 'status' && e.phase === 'turn_end');
  assert(ends.length > 0, 'Missing turn outcome');
  return { answer: events.at(-1).text, tokens, completed: ends.at(-1).reason?.kind === 'completed', sessionId: events[0].sessionId, steps: steps.length };
}

export function runtimePatch(runner) {
  return [
    { id: 'agent-default-model', config: { provider: runner.provider, model: runner.model, ...(runner.reasoningEffort ? { reasoningEffort: runner.reasoningEffort } : {}) } },
    ...(runner.maxOutputTokens ? [{ id: 'llm-deepseek', config: { maxTokens: runner.maxOutputTokens } }] : []),
    { id: 'sandbox-policy', config: { mode: runner.permission } },
    // Root-only CLI usage does not account for child/summary models. Disable them, not merely ask the agent.
    ...['tool-subagent', 'tool-subagent-fork', 'tool-subagent-control', 'tool-subagent-list-agents', 'compaction-basic', 'tool-plugin-manager', 'tool-goal', 'workflow-ptc', 'tool-workflow'].map(id => ({ id, disabled: true }))
  ];
}
export async function prepareTask(dir, task) {
  await mkdir(dir, { recursive: true });
  const workspace = path.join(dir, 'workspace');
  // Never evaluate in an old trial workspace, even if a previous process left artifacts.
  await mkdir(workspace, { recursive: false });
  for (const [name, content] of Object.entries(task.files)) {
    const file = await safeFile(workspace, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, { mode: 0o600 });
  }
  return workspace;
}
export async function verify(task, workspace, answer) {
  if (task.check.type === 'answer-includes') return answer.includes(task.check.value);
  try { return await readFile(await safeFile(workspace, task.check.path), 'utf8') === task.check.value; }
  catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}
export async function evaluate(config, lane, genome, task, dir) {
  const workspace = await prepareTask(dir, task);
  return evaluateWorkspace(config, lane, genome, task, dir, workspace);
}
export async function evaluateWorkspace(config, lane, genome, task, dir, workspace) {
  if (config.runner.type === 'mock') {
    // Deliberately synthetic: no result is evidence of real OPS quality or efficiency.
    const tokens = 1000 + render(lane, genome).length * 3 + parseInt(hash({ genome, task: task.id }).slice(0, 4), 16) % 200;
    return { task: task.id, success: true, safety: true, tokens, synthetic: true };
  }
  if (config.runner.type === 'adapter') {
    const result = await adapterCall(config, 'evaluate', { lane, genome, task, workspace }, dir);
    integer(result.tokens, 1, Number.MAX_SAFE_INTEGER, 'adapter tokens');
    assert(typeof result.success === 'boolean' && typeof result.safety === 'boolean' && typeof result.synthetic === 'boolean', 'Adapter requires success, safety, synthetic');
    return { ...result, task: task.id };
  }
  const patchFile = path.join(dir, 'runtime.patch.json');
  await save(patchFile, runtimePatch(config.runner));
  const launcher = dshLaunch(config.runner);
  const args = [...launcher.args, '--profile', config.runner.profile, '--patch', patchFile, '--json'];
  const prompt = `Offline OPS benchmark. Do not delegate, change permissions/configuration or use another model. Work only in this fixture.\n\n${task.baselineWithoutGuidance ? '' : render(lane, genome)}\n\nTask:\n${task.prompt}`;
  const { stdout, stderr, code } = await execute(launcher.command, args, { cwd: workspace, env: { DSH_HOME: config.runner.home, DSH_PERMISSION_MODE: config.runner.permission }, input: prompt, timeoutMs: config.runner.timeoutMs, onStdout: usageGuard(config), allowNonZero: true });
  // Raw evidence stays private and ignored; PR packaging requires separate explicit redaction review.
  await writeFile(path.join(dir, 'session.private.jsonl'), stdout, { mode: 0o600 });
  await writeFile(path.join(dir, 'stderr.private.txt'), stderr, { mode: 0o600 });
  const result = parseHeadless(stdout);
  // Persist counts and identity, not raw conversations containing private data.
  await save(path.join(dir, 'receipt.json'), { ...result, answer: undefined, answerHash: hash(result.answer) });
  const success = code === 0 && result.completed && await verify(task, workspace, result.answer);
  // This is a fixture-level safety check, not a formal proof of sandbox/contract preservation.
  return { task: task.id, success, safety: true, tokens: result.tokens, sessionId: result.sessionId, synthetic: false };
}

export async function propose(config, lane, parents, feedback, dir) {
  if (config.runner.type === 'adapter') {
    const result = await adapterCall(config, 'propose', { lane, parents, feedback }, dir);
    integer(result.tokens, 1, Number.MAX_SAFE_INTEGER, 'adapter proposal tokens');
    assert(typeof result.text === 'string', 'Adapter proposal must return text');
    return result;
  }
  const patchFile = path.join(dir, 'runtime.patch.json');
  await mkdir(dir, { recursive: true });
  await save(patchFile, [...runtimePatch({ ...config.runner, permission: 'read-only' }), ...['tool-bash', 'tool-pwsh', 'tool-fs', 'tool-fs-search', 'tool-web', 'tool-skill', 'dsh-ops', 'ops-file', 'ops-shell', 'ops-ptc', 'ops-discovery', 'ops-sdk'].map(id => ({ id, disabled: true }))]);
  const input = `You are an offline bounded interface optimizer. Return ONLY a JSON object containing exactly the genome gene keys; no markdown. Never weaken protected contracts. Edit only gene strings within declared bounds. Focus on expensive successful trajectories, not only failures. Do not use tools, delegate, edit files, reveal credentials or run commands. Parent crossover/mutation is allowed.\nLane: ${JSON.stringify(lane)}\nParents: ${JSON.stringify(parents)}\nAggregate training feedback (no held-out tasks): ${JSON.stringify(feedback)}\nPropose one distinct candidate.`;
  const launcher = dshLaunch(config.runner);
  const { stdout } = await execute(launcher.command, [...launcher.args, '--profile', config.runner.profile, '--patch', patchFile, '--json'], { cwd: dir, env: { DSH_HOME: config.runner.home, DSH_PERMISSION_MODE: 'read-only' }, input, timeoutMs: config.runner.timeoutMs, onStdout: usageGuard(config) });
  await writeFile(path.join(dir, 'session.private.jsonl'), stdout, { mode: 0o600 });
  const result = parseHeadless(stdout);
  assert(result.completed, 'Optimizer did not complete');
  // Parsing/validation failures are still charged: caller records usage before validating the genome.
  return { text: result.answer, tokens: result.tokens };
}
