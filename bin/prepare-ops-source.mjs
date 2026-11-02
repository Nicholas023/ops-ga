#!/usr/bin/env node
// Reviewed local build/provision driver. Config is operator-owned and fingerprinted,
// never a gene. No shell interpolation, dependency install or stable-home copying.
import path from 'node:path';
import { readFile, mkdir } from 'node:fs/promises';
import { assert, load, save, hash, safeFile } from '../src/common.mjs';
import { execute } from '../src/process.mjs';
const [input, output] = process.argv.slice(2);
try {
  const r = await load(input), c = r.driverConfig;
  assert(c && Array.isArray(c.build) && c.build.length && Array.isArray(c.contract) && c.contract.length, 'Explicit build and independent contract argv steps required');
  const home = path.join(r.episodeDirectory, 'dsh-home'); await mkdir(home, { recursive: false });
  const receipt = await load(path.join(r.episodeDirectory, 'source.receipt.json'));
  const checks = [];
  for (const [stage, steps] of [['build', c.build], ['contract', c.contract], ['provision', [c.provision]]]) {
    for (const [i, step] of steps.entries()) {
      assert(step && path.isAbsolute(step.script) && hash(await readFile(step.script, 'utf8')) === step.sha256, 'Pin each trusted build/contract/provision script outside candidate scope');
      assert(!step.script.startsWith(r.source + path.sep) && Array.isArray(step.args) && step.args.every(a => typeof a === 'string'), 'Driver scripts cannot be candidate source');
      const substitute = s => s.replaceAll('{source}', r.source).replaceAll('{home}', home).replaceAll('{episode}', r.episodeDirectory);
      const result = await execute(process.execPath, [step.script, ...step.args.map(substitute)], { cwd: r.source, env: { DSH_HOME: home }, timeoutMs: step.timeoutMs ?? 600000 });
      if (stage === 'contract') {
        const report = JSON.parse(result.stdout);
        assert(report.passed > 0 && report.failed === 0 && report.skipped === 0, 'Independent contract gate must emit passed/failed/skipped JSON with no skips');
        checks.push({ id: `contract-${i}`, status: 'passed', passed: report.passed, scriptHash: step.sha256 });
      }
    }
  }
  assert(typeof c.profile === 'string' && c.profile, 'Provisioned profile name required');
  await save(output, { version: 1, sourceDigest: receipt.sourceDigest, buildPassed: true, contractPassed: true, skipped: 0, home, profile: c.profile, checks });
} catch (error) { console.error(`OPS prepare: ${error.message}`); process.exitCode = 1; }
