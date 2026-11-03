# OPS-GA

Offline, budgeted genetic optimization for the DSH OPS tool-using agent. It searches one isolated optimization lane at a time, evaluates paired baseline/candidate runs, and exports a reviewed artifact. **Nothing in this repository adds an optimizer, judge, or resident router to production DSH.**

> The repository contains implementation, this usage guide, and reviewed contributor evidence under `experiments/` and `external-pr/`. Private research notes, design records, and maintainer audit reports belong in the local sibling `../doc/` and are intentionally ignored by Git.

## 用法：

1，克隆本仓库

2，用你的dsh打开本仓库

3，让他阅读这个仓库，然后告诉他你的预算，让他用这个预算跑任务，超预算了立刻停

4，跑完了可以pr

```powershell
git clone https://github.com/Tranquillitatis-Lab/ops-ga.git
cd ops-ga
npm test
# 无 API 的框架演示
node bin/ops-ga.mjs run --config examples/demo.json --lane operations
# 真实运行前按你的明确预算初始化；10 只是示例，并非默认授权
node bin/ops-ga.mjs init --out ops-ga.local.json --budget-usd 10 --confirm-budget
```

真实运行要填写 provider/model/单价来源与日期/DSH 和 OPS 版本，独立准备 headless profile 并安装 OPS，再执行下文 doctor/run/validate。四个方向分别运行、共用总预算。完整 session 仅保存在私有 run 目录；提交外部 PR 前必须脱敏并附完整优化包、公共 benchmark 双臂成绩与 session ZIP。

## What it does

- `operations`, `interface`, `ptc`, and `discovery` are independent lanes with separate state, candidate populations, and acceptance history; one root lock and ledger keep the total budget global.
- Uses deterministic mock evaluation for tests and smoke runs; mock results are never exportable as real evidence.
- Uses DSH headless JSON events for real inference. It records normalized input/output/cache token usage, final turn status, task verification, model/provider/provenance and private receipts.
- Keeps the final `test` split closed until `validate`; no candidate selection can open it.
- Resumes interrupted runs conservatively. A request with unknown billing state leaves a reservation and blocks automatic retry.
- The baseline is current OPS without candidate supplemental guidance, not bare DSH. Legacy `interface`/`discovery` lanes optimize session guidance. Opt-in `kind: "source"` lanes now evaluate reviewed source/schema replacements through the controlled adapter in isolated snapshots, with independent build/contract gates and actual wire-surface checks; they do not mutate the installed OPS.
- Supports trusted local adapters for integrating public benchmark harnesses without giving model output arbitrary shell access.

## Requirements

- Node.js 22 or newer.
- A working DSH installation and an isolated DSH profile/home for real runs.
- A provider-side hard quota/rate limit in addition to this local ledger.
- For SWE-bench evaluation: Python, Docker, a pinned SWE-bench checkout, and enough disk/RAM for the official harness. The repository's adapter never downloads repositories or silently reuses a run id.

## Quick smoke test (no API call)

```powershell
cd reserach/ops-ga/main
npm test
node bin/ops-ga.mjs run --config examples/demo.json --lane operations
node bin/ops-ga.mjs validate --config examples/demo.json --lane operations
node bin/ops-ga.mjs status --config examples/demo.json --lane operations
```

This smoke run is repeatable until `validate` opens its holdout. Afterwards choose a fresh output directory in a copied config to start another search; do not erase old evidence or reuse held-out tasks to tune a real run.

This deliberately uses `runner.type=mock`; its token numbers are synthetic and cannot be submitted as benchmark evidence.

## Start from a DSH Web conversation

Tell DSH: **“Read this project's README and start an offline OPS optimization run. My total maximum budget is USD X. First confirm the price/model/profile and the exact benchmark split; do not exceed the budget or start paid calls before I confirm.”**

DSH must ask for the amount if it was omitted; it must not invent a spending authorization. After the paying user confirms an amount, initialize a private configuration:

```powershell
node bin/ops-ga.mjs init --out ops-ga.local.json --budget-usd 10 --confirm-budget
```

The `10` above is only an example, not an approved default. `init` performs no inference and refuses to overwrite an existing configuration. Replace all provider/model/provenance/pricing placeholders, provision an independent DSH home/profile with OPS installed, then follow `doctor`, `run`, `validate`, `export` below. The Web session orchestrates CLI subprocesses; it must never run the experiment inside its own live/stable DSH home.

## Real DSH run

1. Copy `examples/dsh.json` to a private file outside the repository, for example `ops-ga.local.json`.
2. Replace the provider, model, DSH/OPS provenance, exact launcher, isolated `DSH_HOME`, and conservative pricing source/date.
3. Set `confirmedByUser: true` only after the person paying the provider has reviewed `maxUSD`, `reserveUSDPerCall`, `maxTokens`, `maxCalls`, and `maxEpisodes`. Keep the confirmation text non-sensitive.
4. Use an isolated DSH profile whose bundle is known to compose the `headless` app. Do not point it at a Desktop/Web home or stable profile.
5. Inspect the fresh-run conservative campaign bound before spending. This reads configuration only: it does not create a run, invoke DSH, or expose held-out answers. It includes repeats, both final arms and the maximum paid proposal attempts; when all lanes are selected it also totals their **shared** budget:

```powershell
node bin/ops-ga.mjs preflight --config .\ops-ga.local.json --lane operations
```

`plannedFits: false` is a warning, not a request to raise the paying user's ceiling. Actual sessions can settle below their reservations, so the bound is deliberately pessimistic. Reduce the reviewed population/generations/repeats, choose a smaller predeclared suite, or accept that the ledger may stop early. Reviewed seeds with `search.llmMutation: false` avoid paying for duplicate/invalid proposals. Never remove difficult instances after observing candidate results to manufacture a saving.

6. Run the offline configuration check; this invokes only `--version`, `--help`, and `--dump-config`, never an inference. It checks the nested DSH route for SWE adapters too; `run`/`validate` automatically repeat this check before paid execution. The configuration dump may contain credentials and is never retained or printed:

```powershell
node bin/ops-ga.mjs doctor --config .\ops-ga.local.json
```

7. Run one lane. `--allow-paid` is an explicit operator confirmation in addition to the signed config confirmation:

```powershell
node bin/ops-ga.mjs run --config .\ops-ga.local.json --lane operations --allow-paid
node bin/ops-ga.mjs validate --config .\ops-ga.local.json --lane operations --allow-paid
```

8. Inspect `output/<lane>/state.json`, private receipts, and the paired final result. `status` reads the authoritative shared `output/budget.json` (another lane may have spent since this lane's last save). Export is intentionally separate and requires a real final improvement:

```powershell
node bin/ops-ga.mjs export --config .\ops-ga.local.json --lane operations --out .\local\operations-guidance.json
```

The default suite has only tiny smoke tasks; it **does not establish benchmark quality, safety, or statistically non-inferior success**. `safety` in built-in episode records means the run passed local runtime guards, not formal proof of every OPS contract. Production deployment always requires human review and the actual OPS contract regression suite.

The launcher is passed `--profile headless --patch ... --json`; the task itself is sent on stdin (omitting the positional task requests stdin). Windows `.cmd` carriers explicitly forward UTF-8 stdin through PowerShell; a lone `-` is not passed through PowerShell `-File`. There is no invented `dsh session create/send/export` command. For a user starting from the DSH web session, ask DSH to read this README and execute these commands in the project workspace; the run remains a child process with its own `DSH_HOME` and ledger.

## Budget behavior

Real configs require all of the following:

- explicit currency and maximum/per-call reservation: `currency: "USD"` + `maxUSD`/`reserveUSDPerCall`, or `currency: "CNY"` + `maxCNY`/`reserveCNYPerCall`;
- token, call, episode and timeout caps;
- conservative pinned input/output prices in the same currency (`inputUSDPerMillion`/`outputUSDPerMillion`, or `inputCNYPerMillion`/`outputCNYPerMillion`), source and check date;
- explicit user confirmation in the config plus `--allow-paid` at launch.

All lanes share `output/budget.json`. Before every **session invocation**, including optimizer proposals, the runner reserves the configured tokens and amount in the declared currency. A session may contain several provider model steps: `maxCalls` counts session invocations, while `modelSteps` records observed model steps separately. CNY is never silently treated as USD. It stops before an invocation if any cap would be exceeded. Unknown billing retains its reservation and blocks automatic retry; provider-side hard limits remain mandatory.

Reservations use the highest configured rate, but completed sessions settle using their actual normalized usage breakdown. Pin optional `cacheReadUSDPerMillion` / `cacheWriteUSDPerMillion` (or their `CNY` equivalents) alongside input/output rates. For example, a **historical user-provided** Flash table used input CNY 2/M, cache-read CNY 0.04/M and output CNY 8/M; this is not a current price quote. Missing cache prices fall back to the highest rate, and total-only adapters retain conservative pricing. Reasoning is already included in output and is never charged twice.

`costMicros` is the occupied budget (settled usage estimate plus any pending reservation), in millionths of the declared currency. `estimatedSpentMicros` and `conservativeSpentMicros` show the two completed-invocation views separately; neither is a provider invoice. Cache hits are **observed**, never assumed when reserving a future session. Pin a conservative applicable tariff: do not claim an off-peak discount unless that tariff actually applied. Changing pricing/engine semantics requires a new output directory; historical ledgers are not rewritten.

## Controlled OPS architecture/source/schema optimization

`examples/ops-source.json` is a fail-closed template, not a paid-run authorization. Architecture candidates are actual replacements in a pinned OPS Git snapshot, **not extra task guidance**. Source lanes can target resident-tool descriptions/schema definitions, discovery/loading implementation and result projections within the explicitly reviewed `src/` or `schemas/` allowlist. Permission/sandbox/credential/policy/adapter authority files, tests, package scripts, generated `lib/` and runtime artifacts cannot be candidate edit targets. Never remove argument/path/paging/CAS/permission contracts to save bytes.

A source lane uses the existing bounded string/choice genome plus explicit bindings and reviewed seeds:

```json
{
  "id": "resident-schema", "kind": "source",
  "genes": { "description": { "type": "text", "initial": "EXACT_ORIGINAL_FRAGMENT", "maxChars": 1000, "required": ["REQUIRED_CONTRACT_TEXT"] } },
  "bindings": [{ "gene": "description", "path": "src/schema.ts", "sha256": "FULL_ORIGINAL_FILE_SHA256", "oldText": "EXACT_ORIGINAL_FRAGMENT" }],
  "seeds": [{ "description": "REVIEWED_REPLACEMENT_WITH_REQUIRED_CONTRACT_TEXT" }]
}
```

Initial gene text must equal `oldText`. Use real source/contracts, not these placeholders. Obtain each full payload approval digest with `node bin/ops-ga.mjs payload --lane-file <lane.json> --genome <candidate.json>` and explicitly list reviewed digests in `runner.options.approvedPayloads`. Digests bind the complete lane/bindings and edits. `llmMutation` must be false for source search: it selects among reviewed seeds; arbitrary new source is not automatically executed. To expand the search, review additional seeds and start a fresh fingerprint-bound run.

The adapter exports the pinned Git commit, rejects links/submodules, verifies original file hashes, and applies exact edits only in a new per-episode directory. A pinned **trusted local preparation driver** then receives argv `<request.json> <response.json>`; it must build that snapshot, execute independent no-skip contract tests, and provision a fresh DSH home/profile inside that episode. Driver request fields are `source`, `episodeDirectory`, `payloadDigest`; response requires `version:1`, the `source.receipt.json` input `sourceDigest`, `buildPassed:true`, `contractPassed:true`, `skipped:0`, `home`, `profile`, and a nonempty `checks` array of passing named contract checks. Install dependencies only in the snapshot, using a process-scoped proxy. The driver is privileged reviewed code, not a model-generated script or an OS sandbox. It must never modify stable profiles or weaken verifiers. The included `bin/prepare-ops-source.mjs` is an argv-only driver scaffold: `driverConfig.build`/`contract` arrays and `provision` each reference an absolute, hash-pinned external Node script plus args; `{source}`, `{home}`, `{episode}` are substituted. Contract scripts must print JSON `{ "passed": N, "failed": 0, "skipped": 0 }` with N > 0. These trusted scripts must be outside candidate scope; provisioning must create the isolated profile and point it to the built snapshot. There is no universal version-independent OPS/DSH provisioning recipe; operators must review their pinned scripts and supply `driverConfig.profile`.

`components` explicitly maps actual profile row IDs to compiled modules within the snapshot: the original row is disabled, then a new `ops-ga-source-<id>` row is inserted with the candidate file URL. Optional `groupId`/`isolate` preserve the reviewed placement and scope. DSH patch `name` is a match guard, not a module-replacement field. `disableRows` explicitly disables other installed OPS rows. Never guess row IDs across releases. The adapter hashes source and selected compiled entries, verifies they remain unchanged, and loads only those entries via the episode runtime patch. Contracts and the wire observer remain outside candidate edit scope.

### Actual tool exposure

The read-only observer hooks DSH's `llm/stream` boundary: it records the **actual request** tool schemas, schema bytes/digests, session identity, route and resolved policy before provider dispatch. Required/forbidden/exact tool expectations fail closed before `next()`. After inference, snapshot counts must match model-step counts, and session/route/payload digests must reconcile. Raw snapshots are private and may contain sensitive schema text. A configured row or `--dump-config` is not accepted as proof of wire exposure. The hook is tested against a fake host and end-to-end fake DSH; a real pinned DSH/OPS deployment must verify compatibility before a paid campaign. Policy observation does not prove OS sandbox enforcement or module provenance against malicious trusted code.

### Stratified tasks and repeated pairs

Generate 18 deterministic local fixtures (six families × train/gate/test):

```powershell
node bin/ops-ga.mjs suite --out .local/stratified-tasks.json
```

Families cover discovery, whole-file paging, multi-file edits, aggregation, noisy-log triage and repair. These are **coverage strata, not a public benchmark or demonstrated production-representative corpus**; add independently verified real-world tasks for broader claims. `files-equal` verifies every named changed/unchanged file outside the model. `requireRepresentativeSuite:true` enforces family coverage on every split and duplicate task identities are rejected.

`evaluation: { "repetitions": 3, "order": "balanced", "requireRepresentativeSuite": true }` repeats each candidate/task in isolated workspaces. Final baseline/candidate arms run interleaved in a deterministic seed-derived balanced order, persisted before holdout execution; resume reuses only exact trial IDs. Training/gate repeats remain candidate-grouped for selection. Final evidence preserves repetition IDs, planned/actual order, per-pair deltas, regressions and descriptive task-cluster bootstrap intervals. Replicates are not counted as independent new tasks. Provider sampling/cache remain uncontrolled and `statisticalNonInferiorityProven` stays false. Source searches require at least two repeats and the stratified suite; all invocations still consume the shared approved budget. No experiments are launched by suite/payload generation.

## AI-readable private analysis (no inference)

```powershell
node bin/ops-ga.mjs analyze --run-dir <existing-output-directory> --out <private-index.json>
# Optional: reprice historical traces without changing their state or ledger
node bin/ops-ga.mjs analyze --run-dir <existing-output-directory> --out <private-index.json> --pricing <pricing.json>
```

`pricing.json` contains only `{ "currency": "CNY", "rates": { ... } }` with the same rate fields, source and checked date as above; do not give the analyzer a credential-bearing config. The output must be outside the original run directory. It retains stable evaluation IDs, task/split/candidate relationships, session digests, usage breakdowns, model steps, tool/status counts, pairing/reuse information, and missing-evidence issues. It omits answers, prompts, tool arguments/results and environment configuration. It is still **private and unreviewed**: task IDs, filenames and hashes may be sensitive. Review before sharing; an index is not a public submission or proof of architecture causation.

New final results explicitly distinguish a baseline-selected **identity control** (one evaluation reused in both arms) from two task-paired observations. Neither establishes statistical non-inferiority. Legacy runs without pairing metadata report pairing as unavailable rather than guessing from equal token totals. Failed process attempts now retain bounded private stdout/stderr and a terminal `attempt.json`; unknown billing stays pending. Identified model steps reject duplicates/orphans, while legacy unidentified streams remain explicitly labeled.

Optimizer feedback now includes a bounded train-only slice of per-task token deltas, success/regression facts and tool counts, including expensive baseline successes. Gate/test records are never fed into proposals. This borrows the per-instance evidence principle from [FlashRSI](https://github.com/RUC-NLPIR/FlashRSI), without importing its orchestration, benchmark claims, or changing OPS production. Screening and formal non-inferiority remain future work. Controlled source adaptation and repeated paired evaluation are opt-in as described above. Total-token selection is deliberately unchanged: cache-driven cheaper billing is not evidence of less token usage.

## Benchmark and external PRs

A small external contribution must use `external-pr/<submission-id>/` and include:

```text
submission.json
optimization-package.zip   # complete payload: config, lane, winner, rejected history, checks, reproduction
 evidence.json              # paired per-instance baseline/candidate results and complete usage
sessions-redacted.zip       # reviewed, redistributable session evidence + redaction.json
```

The optimization ZIP requires `candidate.json`, `config.redacted.json`, `reproduce.json`, `checks.json`, `history.json`, `budget.json`, a nonempty `payload/`, and official per-arm reports. `budget.json` must record an explicit `currency` (`USD` or `CNY`), positive `maxUSD`/`maxCNY`, settled `spentUSD <= maxUSD` or `spentCNY <= maxCNY`, `confirmedByUser: true`, and `pending: false`. Each evidence row has `instanceId` and `baseline`/`candidate` objects with `resolved`, positive `tokens`, `usageComplete: true`, `session` (entry in session ZIP), and `report` (entry in optimization ZIP). Session entries must preserve headless `step_end.usage` for reconciliation. `redaction.json` requires `reviewed: true` and the redaction `method`.

Run the gate locally:

```powershell
node bin/validate-submission.mjs external-pr/<submission-id>/submission.json
node bin/pack-sessions.mjs <reviewed-session-dir> <output.zip> redaction.json sessions/baseline.jsonl sessions/candidate.jsonl
```

The first implemented public benchmark adapter is **SWE-bench** (including Lite and Verified datasets compatible with its official harness). Pro/Terminal-Bench metadata can be registered in submissions, but their differing harnesses require separate adapters; support is not implied by the name. **DeepSWE is a coding-agent/training project, not a benchmark name.** Do not report a DeepSWE training score as SWE-bench evidence. Pin dataset revision, official harness commit, split, instance IDs and unique run IDs; optimization and final test instances must be disjoint. The official harness must be rerun by maintainers before accepting a score.

The repository provides `benchmarks/import-swe.mjs` and `benchmarks/swe-adapter.mjs` for a full local-snapshot → DSH session → patch → official grading path. Use `examples/swe-adapter.json`, pin an official dataset export and prepare repositories at their exact base commits. Import explicitly disjoint instance groups; gold/test patches are stripped from the agent task. Python/Docker and environment provisioning are deliberately external, not model-generated installation commands.

```js
import { importSWE } from './benchmarks/import-swe.mjs';
await importSWE('/private/official-rows.json', '.local/swe-tasks.json', {
  dataset: 'SWE-bench/SWE-bench_Lite', revision: '<dataset-commit>',
  repositoryRoot: '/private/prepared-repositories',
  groups: { train: ['<training-instance>'], gate: ['<tuning-instance>'], test: ['<heldout-instance>'] }
});
```

Do not select prompt variants on the final test set. Use a **unique run-id for every prediction patch**. Infrastructure/build failure is not a successful unresolved model episode; inspect the saved official report.

The SWE adapter now requires `runner.options.dsh.exposure` with a nonempty `requiredTools` set containing an actual `ops_*` wire tool and an explicit `forbiddenTools` list. Choose names for the pinned presentation (Native/PTC), not merely the installed package name. Wire availability does not guarantee the model chooses OPS; inspect recorded call counts too. A run using only official `read/grep/pwsh/edit` cannot establish an OPS tool-efficiency result.

Inference accounting and grading are separate: Docker/report failures retain known usage, mark `gradingOutcome: "infrastructure_failed"` and `selectionEligible: false`, and preserve grading diagnostics. Such results cannot win or support a final claim. A grading infrastructure failure stops immediately after that episode is persisted and known usage is settled, whether it is baseline, candidate, or holdout; remaining episodes are not paid for against a broken grader. Resume reuses the failure rather than reinferring. Inspect receipts and regrade without new inference. Unknown usage after a killed/unfinished inference still retains its reservation and blocks automatic resume. Completed state entries remain on disk; changing the configuration/engine still requires a fresh run rather than silently mixing evidence. An unusually heavy instance is not permission to clear pending billing, raise the approved monetary ceiling, or enable unaccounted compaction calls.

SWE-bench is resource-intensive and Docker-based. Use the official harness in a separately pinned checkout and preserve its `logs/evaluation/<run-id>/results.json` in the optimization package. The adapter refuses an existing run-id because the harness caches by run-id and instance.

Never include raw DSH homes, `.env`, keys, provider headers, private repositories, or unreviewed logs in a session ZIP. The validator checks ZIP paths, CRC, duplicate entries, size bounds, common secret patterns, artifact hashes, paired rows, complete usage, and required evidence. It also prints per-session tool counts/OPS calls, per-instance token deltas/regressions and identity-control warnings; a resolved result requires a completed agent session. `.gitattributes` pins text to LF so Windows `core.autocrlf` cannot invalidate byte-hashed JSON evidence; do not repair a checkout-only newline mismatch by changing the contributor's correct manifest. These checks do not prove a contributor's score is truthful; maintainers rerun the official harness and inspect the patch.

### Recorded pilots are not a default optimization

The merged discovery guidance pilot (`external-pr/discovery-guidance-2026-11-03`) reports 21.34% fewer total tokens on only two instances: one improves while the other consumes about twice as many tokens. Its four submitted sessions contain **zero `ops_*` tool calls**, so it cannot demonstrate OPS tool-efficiency benefits or justify installing that guidance by default. Wire availability and actual tool usage are different facts. The accompanying four-lane record used a disclosed, uncommitted abort-and-continue patch; its settled ledger is not proof that an interrupted upstream invocation has complete billing. Do not copy that behavior, reuse its opened holdout for selection, or interpret contributor reports as independent maintainer regrading. The HarmonyOS submissions contain identity controls, not two independent arms.

## Security boundary

Model instructions are not a security boundary. The framework uses argv-only subprocesses, bounded output, no shell interpolation, isolated workspaces, path/symlink checks, protected contract text and explicit adapter opt-in. Do not grant `danger-full-access` to benchmark runs. Do not let a generated candidate edit the framework, profile, permissions, or benchmark verifier.
