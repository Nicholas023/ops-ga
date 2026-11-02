import { readFile, writeFile } from 'node:fs/promises';
import { assert, save, hash } from '../src/common.mjs';

// Run manually once, then inspect/review the generated task split before any search.
// Input is a local dataset export; no automatic HF download, test patch, gold patch or
// reference solution enters the agent fixture.
export async function importSWE(input, output, options) {
  const sourceText = await readFile(input, 'utf8');
  const source = JSON.parse(sourceText);
  assert(Array.isArray(source), 'Expected JSON array of official dataset rows');
  assert(options.dataset && options.revision && options.repositoryRoot, 'Pin dataset, revision, pre-provisioned repository root');
  const groups = options.groups;
  assert(groups && ['train', 'gate', 'test'].every(k => Array.isArray(groups[k]) && groups[k].length), 'Explicit disjoint instance groups required');
  const all = Object.values(groups).flat();
  assert(new Set(all).size === all.length, 'Overlapping benchmark splits');
  const knownIds = new Set(source.map(r => r.instance_id));
  assert(knownIds.size === source.length, 'Duplicate dataset instance ids');
  const tasks = [];
  for (const split of ['train', 'gate', 'test']) for (const id of groups[split]) {
    const row = source.find(r => r.instance_id === id);
    assert(row && typeof row.problem_statement === 'string', `Missing instance ${id}`);
    assert(/^[a-f0-9]{40}$/.test(row.base_commit), 'Invalid dataset base commit');
    const repoName = row.repo.replaceAll('/', '__');
    assert(/^[a-zA-Z0-9_.-]+$/.test(repoName), 'Unsafe repository name');
    tasks.push({ id, split, prompt: row.problem_statement, files: {}, check: { type: 'answer-includes', value: '' }, benchmark: { type: 'swe-bench', instanceId: id, dataset: options.dataset, datasetFile: (await import('node:path')).resolve(input), datasetHash: hash(sourceText), revision: options.revision, split: 'test', baseCommit: row.base_commit, repository: `${options.repositoryRoot}/${repoName}` } });
  }
  await save(output, tasks);
  return { tasks: tasks.length, omittedFields: ['patch', 'test_patch', 'hints_text', 'FAIL_TO_PASS', 'PASS_TO_PASS'] };
}
