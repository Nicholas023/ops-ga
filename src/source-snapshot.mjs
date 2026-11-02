import path from 'node:path';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { execute } from './process.mjs';
import { applyEdits } from './adapter.mjs';
import { assert, hash, safeFile, save } from './common.mjs';
import { validateGenome } from './genome.mjs';

export function sourcePayload(lane, genome) {
  validateGenome(lane, genome);
  assert(lane.kind === 'source' && Array.isArray(lane.bindings) && lane.bindings.length > 0 && lane.bindings.length <= 3, 'Source lane requires 1-3 explicit bindings');
  const seen = new Set();
  const edits = lane.bindings.map(b => {
    assert(Object.hasOwn(lane.genes, b.gene) && !seen.has(b.path), 'Unknown/duplicate source binding'); seen.add(b.path);
    assert(/^(src|schemas)\/[a-zA-Z0-9_./-]+\.(ts|tsx|js|mjs|json)$/.test(b.path) && !b.path.split('/').includes('..'), 'Source path outside implementation/schema scope');
    assert(!b.path.split('/').some(p => ['test', 'tests', '__tests__', '__snapshots__', 'lib', 'runtime', 'dist', 'target', 'generated', 'node_modules'].includes(p)) && !/\.(test|spec)\./.test(b.path), 'Test/generated/runtime source targets are protected');
    assert(!/(?:permission|sandbox|credential|authorization|security|policy|\/adapter\/)/i.test(b.path), 'Protected authority source cannot evolve');
    assert(/^[a-f0-9]{64}$/.test(b.sha256) && typeof b.oldText === 'string' && b.oldText.length > 0, 'Source binding requires pinned hash and exact original fragment');
    assert(lane.genes[b.gene].initial === b.oldText, 'Source baseline gene must equal original fragment');
    assert(typeof genome[b.gene] === 'string' && genome[b.gene].length <= 16000, 'Bounded replacement required');
    return { path: b.path, sha256: b.sha256, oldText: b.oldText, newText: genome[b.gene] };
  });
  return { edits, digest: hash({ lane, edits }) };
}
export async function snapshotTree(root) {
  const rows = [];
  async function visit(relative) {
    for (const e of (await readdir(relative ? await safeFile(root, relative) : root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (relative === '' && ['.git', 'node_modules', 'lib', 'runtime', 'target', 'dist'].includes(e.name)) continue;
      const name = relative ? `${relative}/${e.name}` : e.name;
      assert(!e.isSymbolicLink(), 'Candidate snapshot contains a link');
      if (e.isDirectory()) await visit(name);
      else if (e.isFile()) rows.push([name, hash((await readFile(await safeFile(root, name))).toString('base64'))]);
    }
  }
  await visit('');
  return rows;
}
export async function prepareSource(options, lane, genome, directory, baseline) {
  assert(path.isAbsolute(options.repository) && /^[a-f0-9]{40}$/.test(options.revision), 'Pin absolute OPS repository and exact commit');
  const payload = sourcePayload(lane, genome);
  if (!baseline) assert(options.approvedPayloads?.includes(payload.digest), `Source payload needs human approval before execution: ${payload.digest}`);
  const root = path.join(directory, 'ops-source');
  await mkdir(root, { recursive: false });
  const archive = path.join(directory, 'ops-source.tar');
  const tree = await execute('git', ['-C', options.repository, 'ls-tree', '-rz', options.revision]);
  for (const entry of tree.stdout.split('\0').filter(Boolean)) {
    const [metadata, name] = entry.split('\t');
    assert(/^(100644|100755) blob /.test(metadata) && name && !name.split('/').some(p => p === '..' || p === '.git') && !name.includes('\\') && !path.isAbsolute(name), 'Source snapshot rejects links, submodules and unsafe paths');
  }
  await execute('git', ['-c', 'core.autocrlf=false', '-C', options.repository, 'archive', '--format=tar', '-o', archive, options.revision]);
  await execute('tar', ['-xf', path.basename(archive), '-C', root], { cwd: directory });
  // Verify original binding bytes even for baseline; never trust machine-local edits.
  for (const edit of payload.edits) assert(hash(await readFile(await safeFile(root, edit.path), 'utf8')) === edit.sha256, 'Pinned OPS source binding hash mismatch');
  if (!baseline) await applyEdits(root, payload.edits, payload.edits.map(e => e.path));
  const manifest = await snapshotTree(root);
  const receipt = { version: 1, repositoryRevision: options.revision, payloadDigest: baseline ? hash({ revision: options.revision, baseline: true }) : payload.digest,
    sourceManifest: manifest, sourceDigest: hash(manifest), baseline, reviewRequired: !baseline, approved: baseline || options.approvedPayloads.includes(payload.digest) };
  await save(path.join(directory, 'source.receipt.json'), receipt);
  return { root, receipt };
}
