# OPS-GA

Offline, budgeted genetic optimization for the DSH OPS tool-using agent. It searches one isolated optimization lane at a time, evaluates paired baseline/candidate runs, and exports a reviewed artifact. **Nothing in this repository adds an optimizer, judge, or resident router to production DSH.**

> The repository contains implementation and this usage guide only. Research notes, design records, and experiment reports belong in the local sibling `../doc/` and are intentionally ignored by Git.

## 中文快速入口

这是离线遗传优化框架，不是生产在线自优化插件。把本仓库交给你的 DSH 网页会话，明确说：**“先读 README，我的总预算为 X 美元；确认模型、单价、独立 DSH_HOME 和 benchmark 后再启动，预算不足立即停。”** 未提供预算时必须先询问，不允许自动代填。研究文档不入库，GitHub 只保留本使用说明。

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
- The baseline is current OPS without candidate supplemental guidance, not bare DSH. The `interface` and `discovery` lanes currently optimize session guidance, **not** the actual resident schema/registry. Actual schema/source transformations require a separately reviewed trusted adapter and an isolated OPS build; this repository does not pretend a prompt is a source-level rewrite.
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
5. Run the offline configuration check; this invokes only `--version`, `--help`, and `--dump-config`, never an inference:

```powershell
node bin/ops-ga.mjs doctor --config .\ops-ga.local.json
```

6. Run one lane. `--allow-paid` is an explicit operator confirmation in addition to the signed config confirmation:

```powershell
node bin/ops-ga.mjs run --config .\ops-ga.local.json --lane operations --allow-paid
node bin/ops-ga.mjs validate --config .\ops-ga.local.json --lane operations --allow-paid
```

7. Inspect `output/<lane>/state.json`, private receipts, and the paired final result. Export is intentionally separate and requires a real final improvement:

```powershell
node bin/ops-ga.mjs export --config .\ops-ga.local.json --lane operations --out .\local\operations-guidance.json
```

The default suite has only tiny smoke tasks; it **does not establish benchmark quality, safety, or statistically non-inferior success**. `safety` in built-in episode records means the run passed local runtime guards, not formal proof of every OPS contract. Production deployment always requires human review and the actual OPS contract regression suite.

The launcher is passed `--profile headless --patch ... --json -`; the task itself is sent on stdin. There is no invented `dsh session create/send/export` command. For a user starting from the DSH web session, ask DSH to read this README and execute these commands in the project workspace; the run remains a child process with its own `DSH_HOME` and ledger.

## Budget behavior

Real configs require all of the following:

- explicit USD maximum and per-call reservation;
- token, call, episode and timeout caps;
- a conservative pinned input/output price source and check date;
- explicit user confirmation in the config plus `--allow-paid` at launch.

All lanes share `output/budget.json`. Before every model call, including optimizer proposals, the runner reserves the configured tokens and USD. It stops before a call if any cap would be exceeded; actual normalized usage settles the reservation. If the provider reports usage missing or a process ends after a request was accepted, the reservation remains pending and automatic retry is refused. A request already accepted by a provider may continue billing after local termination, so provider-side spending limits are mandatory. The local ledger is an estimate, not an invoice.

## Benchmark and external PRs

A small external contribution must use `external-pr/<submission-id>/` and include:

```text
submission.json
optimization-package.zip   # complete payload: config, lane, winner, rejected history, checks, reproduction
 evidence.json              # paired per-instance baseline/candidate results and complete usage
sessions-redacted.zip       # reviewed, redistributable session evidence + redaction.json
```

The optimization ZIP requires `candidate.json`, `config.redacted.json`, `reproduce.json`, `checks.json`, `history.json`, `budget.json`, a nonempty `payload/`, and official per-arm reports. `budget.json` must record `currency: "USD"`, positive `maxUSD`, settled `spentUSD <= maxUSD`, `confirmedByUser: true`, and `pending: false`. Each evidence row has `instanceId` and `baseline`/`candidate` objects with `resolved`, positive `tokens`, `usageComplete: true`, `session` (entry in session ZIP), and `report` (entry in optimization ZIP). Session entries must preserve headless `step_end.usage` for reconciliation. `redaction.json` requires `reviewed: true` and the redaction `method`.

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

SWE-bench is resource-intensive and Docker-based. Use the official harness in a separately pinned checkout and preserve its `logs/evaluation/<run-id>/results.json` in the optimization package. The adapter refuses an existing run-id because the harness caches by run-id and instance.

Never include raw DSH homes, `.env`, keys, provider headers, private repositories, or unreviewed logs in a session ZIP. The validator checks ZIP paths, CRC, duplicate entries, size bounds, common secret patterns, artifact hashes, paired rows, complete usage, and required evidence. These checks do not prove a contributor's score is truthful; maintainers rerun the official harness and inspect the patch.

## Security boundary

Model instructions are not a security boundary. The framework uses argv-only subprocesses, bounded output, no shell interpolation, isolated workspaces, path/symlink checks, protected contract text and explicit adapter opt-in. Do not grant `danger-full-access` to benchmark runs. Do not let a generated candidate edit the framework, profile, permissions, or benchmark verifier.
