# SWE-bench Lite four-lane run — execution record (2026-11-03)

Companion to `2026-11-02-swe-bench-lite-pilot/`. That record covers the aborting baseline runs; this
one covers the four optimization lanes that were actually completed, on the same pinned stack, and the
one lane that produced an exportable improvement.

## Provenance (read this before comparing numbers)

- `operations` ran in its own run directory (`swe-pilot-05`); `interface`, `ptc` and `discovery`
  shared a second one (`swe-pilot-06`). Lanes are independent optimizations, so they are comparable
  per lane, but they do **not** share one ledger across the two directories.
- Both directories were produced with a **local, uncommitted change** that records a per-call
  reservation abort as a failed evaluation instead of aborting the whole run (see the abort section
  below). Upstream policy for that behaviour is still open; the patch is not part of this record's
  claim about the framework.
- Everything else is the pinned stack from the 2026-11-02 record: DSH `0.2.1-rc.5`, OPS
  `0.5.0-alpha3`, official harness `02e7a74`, dataset revision `b0dde10`, `deepseek-flash` with
  `reasoningEffort=max`, `workspace-write`, `reserveTokensPerCall = 1,000,000`.

## Results

| Lane | Winner | train | gate | holdout (test) | Token savings | Export |
| --- | --- | --- | --- | --- | --- | --- |
| `operations` | baseline | 3/6 | 0/2 (1 abort) | **2/2** | 0.00% | refused (no improvement) |
| `interface` | baseline | 3/6 | 0/2 (1 abort) | 1/2 | 0.00% | refused (no improvement) |
| `ptc` | baseline | 2/6 (1 abort) | 0/2 (1 abort) | 1/2 | 0.00% | refused (no improvement) |
| **`discovery`** | **candidate `3495a74c`** | 2/6 (1 abort) | 0/4 (2 aborts) | **4/4** | **−21.34%** | **exported** |

Per-lane split detail: `lanes.csv`. Paired holdout rows: `holdout.csv`. Aborts: `aborts.csv`.

### The one exportable result

`discovery` reached the same holdout outcome as its baseline (2/2 tasks resolved in both arms) while
using **993,726 tokens instead of 1,263,365** — a 21.34% reduction. The exported guidance
(`export/discovery-guidance.json`, 1,037 characters) constrains tool discovery: newly discovered or
loaded tools are available only on the next step, discovery is limited to once per task phase, batches
of independent discovery queries are merged, and previously rejected tools are not reloaded. This
matches the lane's stated scope (session guidance for capability discovery), not a source-level change.

Three of four lanes fell back to the baseline because every mutated candidate cost more tokens on the
training split. That is a real negative result, not a failure to run.

## Aborts

`pytest-dev__pytest-5103` exhausted the 1,000,000-token per-call reservation in **every lane** — nine
aborts in total (see `aborts.csv`). `ptc` additionally exhausted it on `pytest-dev__pytest-5692`,
which the other lanes resolve, so the programmatic-tool-calling lane is markedly more token-hungry per
episode.

With the local change in place each abort is charged at its full reservation, recorded as a failed
evaluation, and the run continues; without it, any single abort ended the run and left the ledger
`pending`, which is what the 2026-11-02 record documents.

### Measured cause of the abort

The aborted episode's partial stream was preserved and yields a complete per-step curve
(`abort-token-curve.csv`):

| Step | Tokens in that step | Cumulative |
| --- | --- | --- |
| 1 | 4,803 | 4,803 |
| 6 | 33,426 | 107,702 |
| 12 | 44,485 | 347,881 |
| 18 | 72,402 | 728,208 |
| 21 | 75,874 | 952,101 |
| 22 (killed) | 79,619 | 1,031,720 |

At the moment of the kill the per-step context was **79,619 tokens — 8% of the model's 1M window**.
The binding constraint is therefore the cumulative per-call reservation, not the context window: the
run stopped on 22 steps of ~47k average, and the window would not have bound for hundreds more steps.

## Cost

Provider list prices have an idle tier and a peak tier; the operator confirmed that only the
2026-11-02 smoke run fell in the peak tier and everything else was billed at idle rates.

| Run | Window (Asia/Shanghai) | Tier | Real cost (CNY) |
| --- | --- | --- | --- |
| `real-20261102-01` (smoke lanes) | 17:18 – 17:34 | peak | 0.4775 |
| `swe-pilot-05` (operations) | 22:44 – 23:17 | idle | 0.7616 |
| `swe-pilot-06` (interface, ptc, discovery) | 23:26 – 01:20 | idle | 2.6656 |
| **Total** | | | **3.90** |

Cache-hit share stayed at 92–93% of all tokens, which is why the real bill is roughly 28× smaller than
the local ledger (the ledger prices every token at the output rate). These figures are computed from
recorded usage and the published price table; the provider invoice remains the only authority.
