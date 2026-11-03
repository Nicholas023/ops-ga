# SWE-bench Lite pilot — execution record (2026-11-02)

This directory is a **benchmark execution record**, not an optimization submission: it contains no
candidate arm and makes no performance claim. It documents a real DSH + OPS run against the official
SWE-bench harness, including one blocking failure that prevented the run from completing.

## Configuration (pinned)

| Item | Value |
| --- | --- |
| DSH | `0.2.1-rc.5`, packaged desktop runtime, dedicated `DSH_HOME` |
| OPS | `dsh-ops 0.5.0-alpha3` (isolated copy of the released build) |
| profile | `headless` (`dsh-base` + `dsh-headless` + `dsh-ops`) |
| provider / model | `deepseek-official` / `deepseek-flash` (DeepSeek-V4.1-Flash-1017) |
| reasoning effort | `max` |
| permission | `workspace-write` |
| harness | official SWE-bench, commit `02e7a74ffd0b707aab73d203fe87bdc7c76afc8e` |
| dataset | `SWE-bench/SWE-bench_Lite`, revision `b0dde1093fe417d83b7184254edf8199c1f0dff5` |
| runtime patch | ops-ga `runtimePatch()`: pinned model, `workspace-write`, compaction/subagent/workflow disabled |
| ledger | CNY, `reserveTokensPerCall = 1,000,000`, `reserveCNYPerCall = 8` |

The harness ran in WSL (Ubuntu 24.04) with Docker 29.1.3 and `swebench 5.0.2` installed from the
pinned checkout. Images were pulled on the Windows side and loaded offline into that daemon, so the
WSL side never needed egress.

## Method

Instance groups were drawn from `SWE-bench_Lite` with a fixed seed (20261102) over repositories of
small footprint, then split into disjoint `train` / `gate` / `test` groups of two. The `test` split
was never opened. Selection order is reproducible from the seed; instance IDs are recorded in
`evaluations-swe.csv`.

Search settings: `population 3`, `generations 1`, `elites 1`, LLM mutation enabled.

## Results

Baseline evaluations completed for three instances (the fourth aborts — see below). Nine evaluations
across three independent attempts:

| Instance | attempt 1 | attempt 2 | attempt 3 |
| --- | --- | --- | --- |
| `pytest-dev__pytest-5692` | resolved (25 steps / 767,474 tok) | resolved (32 / 777,026) | resolved (22 / 695,216) |
| `psf__requests-863` | unresolved (16 / 250,235) | unresolved (18 / 357,524) | unresolved (21 / 396,403) |
| `psf__requests-2317` | not graded | unresolved (16 / 526,861) | unresolved (11 / 143,137) |

The same instance resolves every time and the same two fail every time: the outcome is reproducible
rather than sampled noise. Note that the resolving instance consumed 70–78% of the 1M per-call
reservation, i.e. the reservation is already marginal for it.

## Blocking failure

`pytest-dev__pytest-5103` (gate baseline) reached the `reserveTokensPerCall` ceiling of 1,000,000
cumulative tokens twice, in two independent runs. `usageGuard` terminated the owned process both
times, and because `evaluateWorkspace` throws, the run ended with the ledger left `pending: true`.
Each abort discarded the three evaluations that had already completed and required the run to be
restarted under a new configuration fingerprint.

Relevant shape of the task: it requires rewriting pytest's assertion rewriter
(`src/_pytest/assertion/rewrite.py`, 1,221 lines) against a 2,455-line test module. With compaction
disabled by the runtime patch, the episode context only grows, so a long-horizon instance is pushed
into the per-call ceiling. The supporting measurements are in `evaluations-swe.csv`; the abort
records and the residual ledger state are in `aborts.csv` and `ledgers/`.

Two consequences worth separating:

1. **A single heavy instance blocks the whole benchmark run** (fail-fast in `score()` plus the
   `pending` ledger lock). This is the blocking problem: a benchmark run should be able to record an
   instance it could not complete and continue.
2. **The recorded run cannot be resumed**: any configuration change alters the fingerprint, and the
   fingerprint binds cached evaluations, so the completed work cannot be carried forward.

## Cost

> Correction: these figures were first computed at peak-tier prices. The operator later confirmed
> that only the earlier smoke run was billed at the peak tier, and that these runs fell in the idle
> tier, which halves the real cost. See `experiments/2026-11-03-four-lane-run/README.md` for the
> tiered accounting; the table below is kept as the peak-tier upper bound.

| Measure | Value |
| --- | --- |
| Real provider cost (peak-tier upper bound) | **CNY 0.3574** for the three completed evaluations |
| Ledger (all tokens at the output rate) | CNY 9.88 |
| Plus the retained abort reservation | CNY 8.00 (charged, not refunded) |
| Cache-hit share | 93% (1,149,056 / 1,234,756 tokens) |

The ledger is intentionally conservative (`src/budget.mjs` prices every token at the higher rate), so
the ledger overstates the real bill by roughly 27× here.

## Reproduction

```text
node bin/ops-ga.mjs doctor --config <config>          # zero inference
node bin/ops-ga.mjs run    --config <config> --lane operations --allow-paid
node bin/ops-ga.mjs status --config <config> --lane operations
```

`configs/` holds the two configurations used (paths rewritten to placeholders). The harness requires
the official SWE-bench images to be present locally; grading is executed as
`python -m swebench.harness.run_evaluation` against the pinned checkout.

## Evidence layout

```text
evaluations-swe.csv         one row per completed SWE-bench evaluation
evaluations-smoke-lanes.csv one row per evaluation on the built-in smoke tasks (earlier phase)
aborts.csv                  reservation aborts and residual ledger state
ledgers/                    budget ledger snapshot per run
configs/                    redacted configurations
evidence/<run>/<instance>/  receipt, official harness report, predictions, private session stream
```

Session streams are included verbatim except that local absolute paths were replaced with
`<LOCAL_ROOT>` / `<HOME>` / `<DSH_INSTALL>`. All files were scanned with the repository's own
`scanSecrets()` before being committed; no credentials, keys or provider headers are present.

## Known gaps

- No candidate arm exists: the search never left generation 0, so `history` is empty and no
  optimization package can be exported.
- The `test` split was never opened; there is no held-out result.
- Two instances (`pylint-dev__pylint-7993`, `mwaskom__seaborn-2848`) were never evaluated.
- The abort left no per-step token curve: the child process was terminated before its stdout was
  persisted, and the DSH native session directory for headless runs contains only a session header.
  The abort is evidenced at ledger level only.
