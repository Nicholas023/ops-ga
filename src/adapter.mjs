import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assert, load, safeFile, save } from './common.mjs';
import { execute } from './process.mjs';

export async function adapterCall(config, method, request, dir) {
  const input = path.join(dir, 'adapter-request.json');
  const output = path.join(dir, 'adapter-response.json');
  await mkdir(dir, { recursive: true });
  await save(input, { version: 1, method, ...request, runnerOptions: config.runner.options ?? {}, budget: config.budget });
  await execute(process.execPath, [fileURLToPath(new URL('./adapter-host.mjs', import.meta.url)), config.runner.module, input, output], { cwd: dir, timeoutMs: config.runner.timeoutMs });
  return load(output);
}

// Utility for trusted adapters: apply only explicit, hash-pinned text replacements in an isolated copy.
// It intentionally does not clone/build/install/deploy or evaluate arbitrary model-supplied commands.
export async function applyEdits(root, edits, allowlist) {
  assert(Array.isArray(edits) && edits.length > 0 && edits.length <= 3, 'Expected 1-3 bounded edits');
  const { hash } = await import('./common.mjs');
  const changes = [];
  for (const edit of edits) {
    assert(allowlist.includes(edit.path), 'Edit outside lane allowlist');
    assert(!changes.some(c => c.file === edit.path), 'One edit per file per proposal');
    const file = await safeFile(root, edit.path);
    const text = await readFile(file, 'utf8');
    assert(hash(text) === edit.sha256, 'Source hash changed');
    assert(edit.oldText && text.split(edit.oldText).length === 2, 'Edit does not match exactly once');
    assert(typeof edit.newText === 'string' && edit.newText.length <= 16000, 'Replacement too large');
    changes.push({ file: edit.path, resolved: file, text: text.replace(edit.oldText, edit.newText) });
  }
  for (const change of changes) await writeFile(change.resolved, change.text);
}
