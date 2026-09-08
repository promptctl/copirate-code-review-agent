# Eval baseline — ebccbd4 (2026-09-08)

Frozen distribution of must-find recall for the golden case suite at commit `ebccbd4148c51742248a0669e1aa13de4ffbffcf` — the engine tree that produced these runs.
This is the reference the compare gate (`copirate-eval-harness-2fk.5`) measures a candidate engine change against.

- **Engine (pinned):** `claude-subscription` / `claude-sonnet-5`
- **Matcher:** `llm/claude-haiku-4-5-20251001`
- **Repeats (N):** 5 per case
- **PRIMARY GATE — pooled inventory must-find recall:** 41% (37/90 across all 5×3 runs, against each case's pooled multi-round inventory); gate floor **31%** (~2σ lower bound). A candidate below the floor is degraded.
- **Frozen-round pooled must-find recall:** 40% (26/65) — continuity diagnostic, comparable with pre-inventory baselines; not a gate.
- **Suite mean of per-case inventory recall means:** 45% (informational — the gate is the pooled inventory rate above, not this average)
- **Cost:** $0.0000 total across 0 costed run(s) (+15 run(s) with no cost reported), ≈ n/a per full suite run (all cases once).

## Per-case must-find recall band (diagnostic)

These bands localize *which* case moves a pooled regression; they are not independent gates (per-case means are too noisy at these denominators — see the rule). "inventory" spans every review round of the source PR; "frozen" is the single frozen round.

| case | inventory recall (mean / min / max) | diag. floor | per-run inventory | frozen recall (mean) | per-run frozen | noise (mean) | cost/run (est.) |
|------|-------------------------------------|-------------|-------------------|----------------------|----------------|--------------|-----------------|
| `cc-candybar-150-transcript-perf` | 34% / 20% / 50% | 20% | 2/10 · 2/10 · 4/10 · 4/10 · 5/10 | 31% | 2/7 · 1/7 · 3/7 · 2/7 · 3/7 | 12.0 | n/a |
| `copirate-93-dependency-diff` | 65% / 50% / 75% | 50% | 3/4 · 3/4 · 2/4 · 3/4 · 2/4 | 53% | 2/3 · 2/3 · 1/3 · 2/3 · 1/3 | 9.6 | n/a |
| `links-317-dolt-telemetry` | 35% / 25% / 75% | 25% | 1/4 · 1/4 · 1/4 · 1/4 · 3/4 | 47% | 1/3 · 1/3 · 1/3 · 1/3 · 3/3 | 6.4 | n/a |

## Degradation rule

PRIMARY GATE (pooled): the suite is DEGRADED when a candidate's pooled inventory must-find recall — total inventory must-finds found across all N×cases runs ÷ total inventory must-find opportunities, where a case's inventory pools every distinct must-find from all of its source PR's review rounds that exists in the frozen material — falls below this baseline's pooled gate floor (the baseline pooled rate minus a ~2σ binomial sampling margin). Pooling across runs is used because per-case recall means are too noisy to gate on at these tiny denominators. The frozen-round pooled rate and the per-case bands below are DIAGNOSTICS — they localize which case moved — not independent gates.

Mechanically: `candidate.suite.pooledInventoryMustFind.rate < 31%` (this baseline's `suite.pooledInventoryMustFind.gateFloor`) ⇒ the suite is DEGRADED.

