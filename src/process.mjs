import { spawn } from 'node:child_process';
import { assert } from './common.mjs';

// No shell interpolation. A timeout kills the owned process tree on Windows.
export function execute(command, args, { cwd, env, input, timeoutMs = 120000, maxBytes = 8 * 1024 * 1024, onStdout, allowNonZero = false } = {}) {
  assert(typeof command === 'string' && Array.isArray(args) && args.every(a => typeof a === 'string'), 'Invalid process invocation');
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', bytes = 0, failure;
    function kill() {
      if (process.platform === 'win32') spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    }
    const timer = setTimeout(() => { failure = new Error('Process timeout; owned tree terminated'); kill(); }, timeoutMs);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    for (const [stream, key] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) stream.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) { failure = new Error('Process output limit exceeded'); kill(); return; }
      if (key === 'stdout') {
        stdout += chunk;
        if (onStdout) { try { onStdout(chunk.toString()); } catch (error) { failure = error; kill(); } }
      } else stderr += chunk;
    });
    child.on('close', code => { clearTimeout(timer); if (failure) reject(failure); else if (code !== 0 && !allowNonZero) reject(new Error(`Process exited ${code}; inspect private run evidence`)); else resolve({ stdout, stderr, code }); });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
