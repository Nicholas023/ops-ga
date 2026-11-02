import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { assert, integer, load, safeFile, stable } from './common.mjs';
import { readZip, makeZip } from './zip.mjs';
import { parseHeadless } from './runner.mjs';
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function scanSecrets(text) {
  return [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\b(?:sk-|ghp_|github_pat_)[a-zA-Z0-9_-]{16,}/, /(?:authorization|api[_-]?key|access[_-]?token)\s*[=:]\s*["']?(?!REDACTED|<redacted>)[a-zA-Z0-9_-]{16,}/i].some(re => re.test(text));
}
const knownBenchmarks = new Set(['swe-bench', 'swe-bench-lite', 'swe-bench-verified', 'swe-bench-pro', 'terminal-bench', 'repo-bench', 'custom']);

export async function checkSubmission(file) {
  const manifest = await load(file), root = path.dirname(path.resolve(file));
  assert(manifest.version === 1, 'Submission version required');
  assert(manifest.redaction?.reviewedByContributor === true && manifest.redaction?.containsCredentials === false && manifest.redaction?.redistributionAllowed === true, 'Explicit redaction and redistribution review required');
  assert(knownBenchmarks.has(manifest.benchmark?.name), 'Unknown benchmark; register it or use custom with justification');
  for (const key of ['dataset', 'revision', 'harnessRepository', 'harnessRevision', 'split', 'selectionProtocol']) assert(typeof manifest.benchmark[key] === 'string' && manifest.benchmark[key], `Benchmark missing ${key}`);
  if (manifest.benchmark.name === 'custom') assert(manifest.benchmark.justification, 'Custom benchmark requires justification, no public benchmark claim');
  assert(manifest.benchmark.optimizationAndTestDisjoint === true, 'Held-out test must be disjoint from optimization tasks');
  for (const key of ['dsh', 'opsBaseline', 'opsCandidate', 'provider', 'model', 'reasoningEffort', 'permission', 'toolMode']) assert(typeof manifest.environment?.[key] === 'string' && manifest.environment[key], `Environment missing ${key}`);
  const blobs = {};
  for (const key of ['optimization', 'evidence', 'sessions']) {
    const artifact = manifest.artifacts?.[key];
    assert(artifact && typeof artifact.path === 'string' && /^[a-f0-9]{64}$/.test(artifact.sha256), `Missing ${key} artifact + sha256`);
    const bytes = await readFile(await safeFile(root, artifact.path));
    assert(digest(bytes) === artifact.sha256, `${key} SHA256 mismatch`);
    blobs[key] = key === 'evidence' ? JSON.parse(bytes.toString('utf8')) : readZip(bytes);
  }
  const opt = blobs.optimization;
  for (const entry of ['candidate.json', 'config.redacted.json', 'reproduce.json', 'checks.json', 'history.json', 'budget.json']) assert(opt.has(entry), `Optimization ZIP missing ${entry}`);
  assert([...opt.keys()].some(k => k.startsWith('payload/') && !k.endsWith('/')), 'Full optimization payload required');
  const checks = JSON.parse(opt.get('checks.json'));
  assert(checks.staticPassed === true && checks.contractPassed === true, 'Static and contract checks must pass');
  const evidence = blobs.evidence;
  assert(evidence.synthetic === false && Array.isArray(evidence.rows) && evidence.rows.length > 0, 'Non-synthetic paired benchmark rows required');
  const sessionEntries = blobs.sessions;
  assert(sessionEntries.has('redaction.json'), 'Session ZIP needs redaction.json');
  const redaction = JSON.parse(sessionEntries.get('redaction.json'));
  assert(redaction.reviewed === true && typeof redaction.method === 'string', 'Session redaction review/method required');
  let baseTokens = 0, candidateTokens = 0, baseSuccess = 0, candidateSuccess = 0;
  const ids = new Set();
  for (const row of evidence.rows) {
    assert(typeof row.instanceId === 'string' && !ids.has(row.instanceId), 'Duplicate/missing benchmark instance'); ids.add(row.instanceId);
    for (const arm of ['baseline', 'candidate']) {
      const r = row[arm];
      assert(r && typeof r.resolved === 'boolean' && r.usageComplete === true, 'Result and complete usage required for both arms');
      integer(r.tokens, 1, Number.MAX_SAFE_INTEGER, 'benchmark tokens');
      assert(typeof r.session === 'string' && sessionEntries.has(r.session), 'Every benchmark arm needs its session in ZIP');
      assert(typeof r.report === 'string' && opt.has(r.report), 'Every arm needs official harness report inside optimization ZIP');
      const session = parseHeadless(sessionEntries.get(r.session).toString('utf8'));
      assert(session.tokens === r.tokens, 'Session usage disagrees with evidence row');
      const report = JSON.parse(opt.get(r.report));
      const resolved = Array.isArray(report.resolved_ids) ? report.resolved_ids.includes(row.instanceId) : report[row.instanceId]?.resolved;
      assert(typeof resolved === 'boolean' && resolved === r.resolved, 'Official report disagrees with evidence row');
    }
    baseTokens += row.baseline.tokens; candidateTokens += row.candidate.tokens;
    baseSuccess += Number(row.baseline.resolved); candidateSuccess += Number(row.candidate.resolved);
  }
  for (const entries of [opt, sessionEntries]) for (const [name, bytes] of entries) {
    assert(!/(^|\/)(\.env(?:\..*)?|credentials[^/]*|[^/]*\.(?:pem|key|p12|pfx))$/i.test(name), 'Forbidden secret filename');
    assert(!scanSecrets(bytes.toString('utf8')), `Potential secret in ${name}; redact before submission`);
  }
  assert(!scanSecrets(JSON.stringify(manifest)) && !scanSecrets(JSON.stringify(evidence)), 'Potential secret in metadata');
  return { valid: true, instances: ids.size, baselineResolved: baseSuccess, candidateResolved: candidateSuccess, baselineTokens: baseTokens, candidateTokens, tokenSavings: 1 - candidateTokens / baseTokens, note: 'Package integrity only, not proof of truthful scores. Maintainer must rerun official harness; do not merge automatically.' };
}
export async function packSessions(directory, files) {
  // Caller provides exact relative allowlist; no sweeping DSH_HOME or hidden credentials.
  const payload = {};
  for (const name of files) {
    assert(/\.(json|jsonl|txt)$/.test(name), 'Sessions allow JSON/JSONL/text only');
    const bytes = await readFile(await safeFile(directory, name));
    assert(!scanSecrets(bytes.toString('utf8')), `Potential secret in ${name}`); payload[name] = bytes;
  }
  assert(payload['redaction.json'], 'Include reviewed redaction.json');
  return makeZip(payload);
}
