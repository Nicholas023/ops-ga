import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { assert } from './common.mjs';

// No shell interpolation. Failures retain bounded decoded output for private capture.
export function execute(command, args, { cwd, env, input, timeoutMs = 120000, maxBytes = 8 * 1024 * 1024, onStdout, allowNonZero = false } = {}) {
  assert(typeof command === 'string' && Array.isArray(args) && args.every(a => typeof a === 'string'), 'Invalid process invocation');
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', bytes = 0, capturedBytes = 0, failure;
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    function kill() {
      if (!child.pid) return;
      if (process.platform === 'win32') spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    }
    function fail(message, code) {
      if (!failure) { failure = new Error(message); failure.failureCode = code; }
      kill();
    }
    const timer = setTimeout(() => fail('Process timeout; owned tree terminated', 'runtime.timeout'), timeoutMs);
    child.on('error', error => { failure ??= Object.assign(error, { failureCode: 'process.spawn_failed' }); });
    for (const [stream, key] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) stream.on('data', chunk => {
      bytes += chunk.length;
      const kept = chunk.subarray(0, Math.max(0, maxBytes - capturedBytes));
      capturedBytes += kept.length;
      const text = decoders[key].write(kept);
      if (key === 'stdout') {
        stdout += text;
        if (onStdout && !failure) { try { onStdout(text); } catch (error) { failure = error; failure.failureCode ??= 'runtime.usage_guard'; kill(); } }
      } else stderr += text;
      if (bytes > maxBytes) fail('Process output limit exceeded', 'runtime.output_limit');
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      stdout += decoders.stdout.end(); stderr += decoders.stderr.end();
      const result = { stdout, stderr, code, signal, elapsedMs: Math.round(performance.now() - started), observedBytes: bytes, capturedBytes, captureComplete: bytes <= maxBytes };
      if (!failure && code !== 0 && !allowNonZero) failure = Object.assign(new Error(`Process exited ${code}; inspect private run evidence`), { failureCode: 'process.nonzero' });
      if (failure) { Object.assign(failure, result); reject(failure); } else resolve(result);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
