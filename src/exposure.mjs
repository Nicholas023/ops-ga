import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { assert, hash, save } from './common.mjs';

export async function verifyExposure(file, expected, result, payloadDigest) {
  const text = await readFile(file, 'utf8');
  const rows = text.trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  assert(rows.length === result.steps, 'Exposure snapshots must cover every observed model step');
  for (const row of rows) {
    assert(row.sessionId === result.sessionId && row.payloadDigest === payloadDigest, 'Exposure identity/payload mismatch');
    assert(row.provider === expected.provider && row.model === expected.model && row.permission === expected.permission, 'Actual model route or permission differs');
    assert(Array.isArray(row.tools) && row.schemaDigest === hash(JSON.stringify(row.tools)), 'Exposure schema digest mismatch');
    const names = row.tools.map(t => t.name);
    assert(names.every(n => typeof n === 'string') && new Set(names).size === names.length, 'Invalid or duplicate wire tool names');
    for (const n of expected.requiredTools ?? []) assert(names.includes(n), `Required wire tool absent: ${n}`);
    for (const n of expected.forbiddenTools ?? []) assert(!names.includes(n), `Forbidden wire tool present: ${n}`);
    if (expected.exactTools) assert(JSON.stringify([...names].sort()) === JSON.stringify([...expected.exactTools].sort()), 'Unexpected wire tool set');
  }
  const receipt = { version: 1, status: 'verified', boundary: 'llm/stream', snapshots: rows.length, payloadDigest,
    schemaDigests: [...new Set(rows.map(r => r.schemaDigest))], toolSets: rows.map(r => r.tools.map(t => t.name)),
    sourceDigest: hash(text), sandboxEnforcementProven: false };
  await save(path.join(path.dirname(file), 'exposure.receipt.json'), receipt);
  return receipt;
}
