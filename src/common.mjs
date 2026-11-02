import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

export const stable = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
export const load = async file => JSON.parse(await readFile(file, 'utf8'));
export async function save(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(tmp, file);
}
export function assert(condition, message) { if (!condition) throw new Error(message); }
export function integer(value, min, max, label) { assert(Number.isSafeInteger(value) && value >= min && value <= max, `Invalid ${label}`); }
export function contained(root, file) {
  const rel = path.relative(path.resolve(root), path.resolve(file));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}
export async function safeFile(root, relative) {
  assert(typeof relative === 'string' && relative.length > 0 && !path.isAbsolute(relative) && !relative.includes('\\'), 'Expected relative POSIX file path');
  const resolved = path.resolve(root, relative);
  assert(contained(root, resolved), `Path escapes sandbox: ${relative}`);
  let cursor = root;
  for (const part of path.relative(root, resolved).split(path.sep)) {
    cursor = path.join(cursor, part);
    try { assert(!(await lstat(cursor)).isSymbolicLink(), `Symlink forbidden: ${relative}`); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  assert((await realpath(root)) === path.resolve(root), 'Sandbox root must not be a symlink');
  return resolved;
}
export function random(seed) {
  let s = seed >>> 0;
  return () => { s += 0x6D2B79F5; let t = s; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
