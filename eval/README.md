# Review-quality eval harness — golden cases

> ## ⛔ MORATORIUM — THE GATE MUST NOT BE RUN
>
> **Nobody — agent or human — dispatches `eval.yml` until `zai-eval-harness-5ux`
> closes.** Owner, 2026-09-08: an eval that takes five hours is not useful. The
> workflow's first step now refuses and the PR label trigger is deleted, so this is
> enforced at the point of spend rather than asserted here.
>
> **The bar is wall clock under 45 minutes.** There is no dollar target, deliberately:
> the pinned engine is a subscription, `baseline.json` records `costPerFullRunUsd: null`,
> and the ~$360 figure quoted around this repo is the *notional* list-price equivalent of
> the quota burned — not money billed. The scarce resources are **wall clock** and
> **subscription quota** (about a day of one account per suite, across a pool that PR
> reviews draw from too). Optimise those; report the notional figure, never target it.
>
> **Why more parallelism is not the answer.** Wall clock is
> `ceil(replays / lanes) × per-replay`. The suite is 20 replays at 13–27 min; the
> keychain pool holds four accounts. Under 45 minutes requires depth 1, so
> `replays ≤ lanes` — at most four replays. **The full N=5 suite cannot fit the budget on
> these accounts at any lane count.** Only running fewer replays in the common case gets
> there. The levers, with their measured numbers, are on the ticket.
>
> Everything below describes the harness **as it stands**, which is the thing under ban.

This directory is the **ground truth** for the review-quality eval harness
(`copirate-eval-harness-2fk`): a frozen set of real, high-finding reviews the agent
produced against real PRs, so a future engine change can be replayed against them and
scored for whether it still finds the known good findings. The goal is to make *"did
this prompt/spawn/effort change degrade finding quality?"* a **measured verdict**, not
a guess.

Everything under `eval/` is dev-only tooling (like `scripts/`) — it is **not** part of
the shipped action surface (`src/`, `action.yml`, `review-agent/`, `dist/`), so
changes here **do not bump the version**.

## What a "case" is

One case = **one frozen review round plus its PR's pooled finding inventory**. The
*replay material* is a single reviewed commit: the exact diff the agent saw at that
commit and the repo tree at that commit, frozen so the case replays identically forever.
The *ground truth* is wider than that one round: the `expected.json` findings array
pools **every distinct finding from all of the source PR's review rounds that exists in
the frozen material** — because in practice a PR's full finding set dribbled out across
up to five push-triggered rounds (typically 1–2 findings per round on largely unchanged
code), and the recall epic (`zai-recall-upr`) asks whether **one** round can surface
what five rounds found together. That question is unmeasurable if each case's ground
truth is only its own round's findings.

The design mirrors the one production and `scripts/local-review.js` already use: a case
is *frozen inputs* (repo tree + saved diff + a pinned engine), and the only variance
left at replay time is the model's own stochasticity — handled downstream by N repeats
and a variance band (`copirate-eval-harness-2fk.4`).

### Why the tree is frozen, not referenced

The reviewed commits are **intermediate PR commits** (not the merged head), and PR refs
get garbage-collected after branch deletion. CI's `GITHUB_TOKEN` also cannot read the
sibling `promptctl/*` repos these cases come from. So each case carries its repo tree as
a **self-contained `repo.tar.gz`** — immune to GC, repo moves, and cross-repo auth. It
is a tarball (not a git bundle) because the runner explores the tree read-only
(`Read`/`Grep`/`Glob`) and takes the diff from `change.diff`; it needs the *files*, not
git history, and a depth-1 git bundle is not clonable.

## Directory layout

```
eval/cases/<case-name>/
  case.json      — the manifest: source identity + engine pin (single source of truth)
  change.diff    — the exact unified diff the agent reviewed (base...head, three-dot)
  repo.tar.gz    — the repo tree at the reviewed head SHA, self-contained
  expected.json  — the annotated finding inventory (the ground truth to score against)
```

### `case.json`

| field             | meaning                                                                    |
|-------------------|----------------------------------------------------------------------------|
| `name`            | case dir name                                                              |
| `source.repo`     | `owner/repo` the review ran against                                        |
| `source.pr`       | PR number                                                                  |
| `source.reviewId` | the marker-bearing review whose findings are frozen                        |
| `source.headSha`  | the commit the review anchored to (the tree in `repo.tar.gz`)             |
| `source.baseSha`  | the PR base tip; `change.diff` is `baseSha...headSha` (three-dot)          |
| `diff`            | `"change.diff"`                                                            |
| `tree`            | `"repo.tar.gz"`                                                            |
| `expected`        | `"expected.json"`                                                          |
| `engine`          | pinned `{ provider, model, reasoning }` the replay must use                |
| `excludePatterns` | the source workflow's `EXCLUDE_PATTERNS` (so the replay matches conditions)|
| `producedBy`      | provenance: the config that originally produced the golden review          |

The engine is pinned explicitly (currently `claude-subscription` / `claude-sonnet-5`,
what `PROVIDER=auto` resolves to and therefore the engine production runs) so a later
change to the default cannot silently move the baseline. `[LAW:no-silent-failure]`
`freeze-case.sh` derives the pin it writes from `src/provider.js` rather than carrying a
copy — a hardcoded pair is what left every case pinned to `deepseek` after 1.42.0
retargeted `auto`, which is how the harness came to be unable to replay on the provider
it was measuring.

`producedBy` is a *different* fact from `engine`, and they are not kept in step: it
records the config that produced the historical golden review this case was curated
from, which for every case here is `auto→deepseek / claude-code / deepseek-v4-pro`. The
`engine` pin is what a replay runs on **today**. They coincided once; conflating them
again would falsify the provenance.

### `expected.json`

```
{ "reviewId": <n>, "headSha": "<sha>", "findings": [ <finding>, ... ] }
```

Each finding:

| field          | meaning                                                                   |
|----------------|---------------------------------------------------------------------------|
| `commentId`    | the GitHub review-comment id (provenance back to the source PR)           |
| `reviewId`     | *(inventory findings only)* the source round that reported it; absent = the frozen round (the top-level `reviewId`) |
| `path`         | file the finding anchors to                                               |
| `line`         | new-file line **in the frozen material** (re-anchored by hand for inventory findings) |
| `side`         | diff side, always `RIGHT`                                                  |
| `annotation`   | `must-find` \| `nice-to-find` \| `noise` (see below)                       |
| `justification`| written rationale for the annotation (for inventory findings: also the eligibility evidence and the original anchor) |
| `diffHunk`     | *(frozen-round findings only)* the exact hunk GitHub anchored the comment to |
| `body`         | the verbatim finding text the agent posted                                |

Every frozen-round finding's `diffHunk` body is a **verbatim substring of
`change.diff`** — the freezer asserts this for each finding and aborts if any hunk is
missing, so the anchors and the frozen diff cannot be committed inconsistent. Inventory
findings carry no `diffHunk`: their GitHub hunk belongs to a *different* commit, so
committing it here would misdescribe the frozen material; their anchor is instead
verified at curation time (see below).

### The pooled inventory, and its eligibility rule

A finding from a non-frozen round may be added to `expected.json` only when **the
defect it describes exists in the frozen material**, and its `path`/`line` must be
**re-anchored to the frozen head's coordinates** on an anchorable line of
`change.diff`. That rule is what keeps the map true (`[FRAMING:representation]`):

- A finding **fixed before the frozen head** is not a recall opportunity there —
  including it would inflate the denominator with permanently-unrecallable entries.
- A finding about **code a post-frozen fix introduced** (a missed spot *of a fix*, a
  refinement of a fix's new code) does not exist in the frozen material — same
  exclusion.
- A finding that **duplicates** a frozen or inventory entry (later rounds re-tell
  earlier stories) is deduplicated into the one entry; the justification names the
  duplicate.
- A finding the PR author **refuted with proof** (pushback accepted, no change) enters
  as `noise` — a known plausible false positive, so an engine that repeats it is not
  charged with *novel* noise, and it never counts toward recall.

Each inventory entry's `justification` records the verdict evidence (confirmed + fix
commit, or refuted), the original anchor (`:line@commit`), and — where relevant — the
frozen-tree verification. Curation is a hand-judgment step, exactly like annotation:
mine the non-frozen marker rounds with `gh api`, read each finding against the frozen
tree (`repo.tar.gz`) and the author's reply threads, and verify every new anchor lands
on an anchorable `change.diff` line (`patchLines` in `src/diff.js` is the authority).

## The annotation vocabulary

The scorer (`copirate-eval-harness-2fk.3`) computes **must-find recall** as the primary
metric, with noise count and cost secondary. The annotation defines which bucket a
finding is:

- **`must-find`** — a real bug or subtle architectural catch whose loss would mean
  degradation. This is deliberately the set of **hard, high-value** findings most at
  risk when tokens/effort are cut (a resource leak, a silent-failure classification, an
  aliasing heisenbug, a subtle concurrency coupling), *not* just the obvious ones.
  Recall over this set is what the harness protects.
- **`nice-to-find`** — a legitimate quality/test/doc/perf finding that adds value but
  whose loss is not degradation. Overlapping nice-to-finds are kept (secondary metric,
  tolerant of clustering).
- **`noise`** — a finding we do **not** want to reward: a false positive, a
  self-neutralizing observation ("...but actually it's safe"), or a **duplicate of a
  must-find** that would inflate recall if scored twice. The `justification` says which.

Genuinely ambiguous calls carry an **`AMBIGUOUS —`** prefix in the `justification` and
are surfaced to the maintainer rather than guessed (see `copirate-eval-harness-2fk.1`
epic notes).

## The current golden set

Every source PR took **five** review rounds; each case freezes its richest round as the
replay material and pools the other rounds' eligible findings as inventory.

| case                              | repo (lang)               | PR   | change kind          | inventory (must/nice/noise) | of which frozen round |
|-----------------------------------|---------------------------|------|----------------------|-----------------------------|-----------------------|
| `cc-candybar-150-transcript-perf` | cc-candybar (TS)          | #150 | perf refactor        | 32 (10 / 15 / 7)            | 17 (7 / 8 / 2)        |
| `links-317-dolt-telemetry`        | links-issue-tracker (Go)  | #317 | supply-chain removal | 14 (4 / 9 / 1)              | 7 (3 / 3 / 1)         |
| `copirate-93-dependency-diff`     | copirate-code-review (JS) | #93  | feature              | 9 (4 / 5 / 0)               | 7 (3 / 4 / 0)         |
| `laws-4-eval-tasks`               | laws (Markdown/shell)     | #4   | eval task specs      | 15 (2 / 12 / 1)             | 6 (2 / 3 / 1)         |

**70 findings total — 20 inventory must-finds (15 of them in the frozen rounds).**
Diverse across language (TS/Go/JS/Markdown) and change kind (perf, supply-chain,
feature, spec/CI). `laws-4`'s dribble was entirely low-stakes maintainability notes, so its inventory
adds nice-to-finds but no must-finds — an honest reflection of that PR, not a curation gap.

## Replaying a case

`eval/run-case.js` (`npm run review:case`) re-runs a frozen case through the **real**
review engine — the same prompts, the same partition→workers `runMultiScope` pass,
and the same MCP collector production uses — with **no GitHub**. It reuses the action's
own seams (`synthesizeProviderConfig`, `parseUnifiedDiff`, `buildPrMaterial`,
`runMultiScope`), exactly as `scripts/local-review.js` does, so it is an **instrument,
not a second review implementation**: a measured difference between two engine versions
is attributable to the code change under test, never to a replay that drifted.

```bash
CLAUDE_CODE_OAUTH_TOKEN=… node eval/run-case.js eval/cases/<case-name> -n 3
# options: -n/--repeats <N> (default 1), --out <dir> (default eval/out),
#          --memory-budget <bytes> (default: the whole host; freeze-suite passes each lane its share),
#          --sweep-cap <N> (default: the engine's own DEFAULT_SWEEP_CAP),
#          --plan <plan.json> (default: the partition is computed from the changed paths),
#          --read-set <assigned|changed> (default: the engine's own DEFAULT_READ_SET)
```

It extracts `repo.tar.gz` to a temp dir (that becomes `REVIEWED_REPO_ROOT`), feeds
`change.diff` through the real diff seam, and drives the engine on the case's **pinned**
provider/model. The credential is read from the same env var the action uses
(`CLAUDE_CODE_OAUTH_TOKEN` / `DEEPSEEK_API_KEY` / `ZAI_API_KEY` / `OPENAI_API_KEY`,
selected by `case.json`'s provider) — and that mapping is `src/provider.js`'s own, read
through `resolveProviderConfig`, not a list this harness keeps. The engine cannot be
overridden on the command line — a replay on a different
model than the pin is **refused loudly**, since it would corrupt any baseline comparison.
It also refuses loudly on a missing credential or a missing/corrupt `repo.tar.gz`.

Each replay is **append-only**: one invocation stamps a timestamp and writes one
directory per repeat, so a re-run never clobbers a prior batch's artifacts.

```
eval/out/<case-name>/<timestamp>-run<i>/
  findings.json   — the raw merged findings from runMultiScope, PRE anchor-partition:
                    an array of { path, line, body, severity } — severity is an integer
                    1-5 priority label from 1.41.0 on (older frozen runs carry the legacy
                    'blocking'/'advisory' strings; the scorer reads both). This is what the scorer
                    (copirate-eval-harness-2fk.3) matches against expected.json.
  summary.txt     — the aggregated multi-scope review summary.
  usage.json      — { tokens, span, cost }. tokens is the disjoint token record
                    { inputCacheMiss, inputCacheHit, output }; span is { from, to } ISO
                    timestamps bounding the pass; cost is the basis-discriminated value
                    ({ basis:'dollars', usd } | { basis:'subscription', notionalUsd: number|null } |
                    { basis:'unpriced', reason }). A run captured before the token split
                    carries a collapsed inputTokens/outputTokens pair instead, and reads
                    back as tokens: null — absent, never zero.
  schedule.json   — the replay's WALL CLOCK, as the engine's own host-stamped record (src/schedule.js's
                    scheduleRecord — the same value run.js posts in the PR footer, so a replay and a
                    production review read one timing fact, not two):
                    { laneCount, sweepCap, scopeCount, spawns: [...] }, where each spawn is
                    { phase, outcome, usage } with the span at usage.span — a 'worker' spawn also
                    names its scope and pass; a 'scout' spawn carries neither and exists only on a
                    repo-mode run, where the plan is still bought from one (a PR run has none). A
                    per-replay duration is the envelope of those spans, derivable from the artifact with
                    no CI log to scrape.
  plan.json       — the replay's STRUCTURE, as the engine's own record (src/plan.js's planRecord):
                    { planSchema, provenance, context, scopes, scoutUsage }, where scopes is the
                    partition the workers actually ran (each { name, focus, files }; every changed path
                    lands in exactly one scope) and context is the planning text prefixed onto every
                    worker's focus. provenance names which producer RAN — 'partition' (a PR run: the
                    scopes are a pure function of the changed paths, no spawn, scoutUsage null), 'scout'
                    (a repo-mode run, which has no diff to compute from and buys its plan from a scout
                    spawn; scoutUsage is what deciding it cost) or 'pinned' (a --plan replay, scoutUsage
                    null). This file is a valid --plan input: see below.
  meta.json       — provenance: case, timestamp, run index, the resolved engine config, findingCount,
                    effort ({roundCap, sweepCap, reasoningTier, readSet}: the arm the run ACTUALLY ran at; null
                    on runs from before it was recorded, which matches only other nulls), and candidate
                    ({sha, dirty}: the tree that produced the run; null on runs from before it was
                    recorded).
  transcripts/    — the full per-spawn session transcripts: one per scope, plus the scout's on a
                    repo-mode run.
```

`eval/out/` is git-ignored — run artifacts are never committed. Like everything under
`eval/`, `run-case.js` is dev-only tooling and does **not** bump the version.

## Varying a lever: A/B arms

The engine is **pinned by the case** and cannot be overridden — a replay on a different
model would corrupt every comparison. Review *effort* is the opposite: it is the thing an
A/B is for. Both `run-case.js` and `freeze-suite.js` take one flag per effort axis, and each
flag's default is read from `src/effort.js`, which owns the value — nothing here copies it:

| Flag | Axis | Arms |
| --- | --- | --- |
| `--sweep-cap <N>` | convergence sweeps allowed per scope after its first pass | `0` is the pre-convergence single-pass behavior; unset is `DEFAULT_SWEEP_CAP` |
| `--read-set <arm>` | which changed files each scope worker opens **in full** | `assigned` (shipped: the read is split across the plan) or `changed` (pre-split: every worker reads the whole changed set); unset is `DEFAULT_READ_SET` |

An axis is only ever varied **one at a time**: two arms that differ on two axes produce a delta
attributable to neither.

Give each arm its own `--out` root:

```bash
# arm A — sweeps on, the shipped behavior
CLAUDE_CODE_OAUTH_TOKEN=… node eval/freeze-suite.js -n 5 --out eval/out/ab-sweep2 --sweep-cap 2
# arm B — sweeps off, the faster review being priced
CLAUDE_CODE_OAUTH_TOKEN=… node eval/freeze-suite.js -n 5 --out eval/out/ab-sweep0 --sweep-cap 0
# score each arm as usual, then read the recall / noise / cost bands off the two summaries
for c in eval/out/ab-sweep2/*/ eval/out/ab-sweep0/*/; do ANTHROPIC_API_KEY=… node eval/score.js "$c"; done
```

The read-set arms run the same way — the flag is the only thing that changes:

```bash
# arm A — split reads, the shipped cost cut
CLAUDE_CODE_OAUTH_TOKEN=… node eval/freeze-suite.js -n 5 --out eval/out/ab-read-assigned --read-set assigned
# arm B — every worker reads the whole changed set, the behavior the cut replaced
CLAUDE_CODE_OAUTH_TOKEN=… node eval/freeze-suite.js -n 5 --out eval/out/ab-read-changed --read-set changed
```

Every run records the effort profile it actually ran under in its `meta.json`, and both ends
**refuse** a mix: `freeze-suite.js` reads the arm of every run already under `--out` and aborts
before resolving a credential, and `score.js` refuses a case-out dir whose runs disagree. Both name
both arms. That is what makes the resume story safe: re-running a suite into an existing `--out`
under a different `--sweep-cap` or `--read-set` — forgetting the flag while topping up an arm is the easy slip —
would otherwise look exactly like a completed suite, queue only the deficit at the new arm, and
produce a band that blends two arms and describes neither. A run replayed before the arm was recorded counts
as its own value — `unrecorded` matches only `unrecorded`, because nothing proves what it
ran at. The arm also rides on each `scorecard.json` and `scorecard-summary.json`, so a
number lifted out of an artifact carries the setting that produced it.

`baseline.js` applies the same rule one level up: it records the arm in `baseline.json`
and refuses to freeze a suite whose cases disagree on it, exactly as it refuses a suite
whose cases pin different engines. An A/B arm is a measurement of a lever, not the
suite's reference distribution — freezing one as the baseline would gate every future
candidate against a floor it never ran under.

`compare.js` closes the last layer, and it is the one a live PR meets: it holds a candidate to the
baseline's arm the way it already holds it to the pinned engine. A tree whose default effort profile
(`src/effort.js`: `DEFAULT_SWEEP_CAP`, `DEFAULT_READ_SET`, …) differs from the baseline's **on any axis**
is **refused before any spend**, as are prior runs left under a resumed `--out` at another arm (which
carry the candidate's own tree identity, so nothing else would catch them until scoring, after the suite
had replayed). It compares whole profiles instead of named axes and carries no arm flag of its own, so an
axis added to `src/effort.js` is gated the day it lands with no edit here. It refuses rather than replaying
the candidate at the baseline's arm on purpose: for a PR that moves one of those defaults the arm change
*is* the change under test, and pinning it away would report a confident OK on a PR whose recall
effect the gate had just neutralized. Re-freeze the baseline, or price the lever with an A/B.

### Holding the structure still: `--plan` and `--plans`

The **scope plan** is the review's structure: how many scopes the change splits into, which files each
scope claims, and the shared context every worker is shown. In PR mode it is now a **pure function of
the changed file paths** (`partitionByDirectory` in `src/partition.js`): a test file joins the changed
source file with the same stem, every file keys on its directory, a directory group smaller than
`MIN_SCOPE_FILES` (currently 2) merges into its parent, and the repository root never merges. Same diff,
same structure, every run. Only repo mode still buys its plan from a scout spawn, because there is no
diff to compute one from.

It was not always so. The plan used to be re-decided by an LLM scout on every single invocation and
recorded nowhere durable, and on the frozen case `links-317` identical input gave 1 to 5 scopes, 4 to 28
findings, 0.5M to 3.8M cache-miss tokens, and must-find recall from 1/3 to 3/3 across replays — scope
count drove every downstream column. Pooled across the cells where the scope count varied, the
fewest-scope runs found **9 of 36** must-finds (25 %) and the most-scope runs **38 of 74** (51 %): a
26-point recall spread on a variable nobody chose, larger than the 16-point sweeps effect the first row
of the table above was built to price (`copirate-determinism-5od`). Worse, in 3 of 40 replays the scout
emitted scopes with no files at all, so every worker fell back to reading the whole diff at about 3× the
cost while the run scored as a valid sample — and two of those runs scored best on recall, poisoning the
A/B. The partition removed that variance at the source: 5 replays of one case now share one structure by
construction, and `MIN_SCOPE_FILES` is the one width lever the rule exposes, the thing to measure with
this harness later.

So on a frozen PR case every un-pinned replay already runs the same structure. `--plan` remains the way
to hold a review to a structure *other* than the computed one — a partition produced under a different
`MIN_SCOPE_FILES`, or a hand-authored one — and the way to replay a repo-mode plan.

**It is deliberately not a row in that table.** An effort arm is a dial you *turn* to see what changes; a
pinned plan is the structure you *hold constant* while turning one. It is not on the effort profile
(`src/multiscope.js` threads it as its own value), because it is not one of the things being compared —
it removes the comparison's dominant noise term, which is what turns an unpaired A/B into a paired one.

```bash
CLAUDE_CODE_OAUTH_TOKEN=… node eval/run-case.js eval/cases/<case-name> --plan <plan.json>
```

Any run's `plan.json` is a valid input — the artifact every replay already writes, so pinning a structure
costs nothing to obtain. Relative to a repo-mode run, a pinned replay also **skips the scout spawn**: on
one observed run (`eval/out/ab-sweep2/laws-4-eval-tasks/2026-09-09T09-25-37-753Z-run1/schedule.json`)
that spawn took 58 seconds and ~122k tokens. Relative to a PR-mode run it costs the same, since neither
spawns anything to decide the plan.

A plan that does not partition **this** case's changed files *exactly* is refused before any engine spawn,
at zero spend. A partition is a cover with no overlap, and all three ways to miss it are refused: a
changed file no scope claims, a file the plan names that the diff lacks, and a file claimed by more than
one scope. Nothing downstream repairs coverage — every changed
path lands in exactly one scope because the producer puts it there, not because a later sweep catches
what it missed — so a changed file no scope claims would simply go unreviewed while its `plan.json`
claimed a partition of the whole change: a different review wearing the plan's name, which is the one
thing a pin exists to prevent. A file the plan names that the diff does not contain is the same error read from
the other side: the plan belongs to some *other* change (a re-frozen case, a different
`EXCLUDE_PATTERNS`), and the paths it names would reach a worker's "read these files in full" line
pointing at nothing. A file in two scopes is read and reviewed twice, by two workers, at double the
cost, while the run scores as a valid sample — the case a hand-authored plan is likeliest to hit.

`freeze-suite.js` takes `--plans <dir>`. It is **plural, and a directory rather than a file**, because a
plan partitions *one* case's changed files — a single file forwarded to every case would be refused by all
but one. The dir holds one **subdirectory per case**, each holding one `.json` plan per replicate:

```
<plans-dir>/
  cc-candybar-150-transcript-perf/   1.json  2.json  3.json  4.json  5.json
  copirate-93-dependency-diff/       1.json  2.json  3.json  4.json  5.json
  …
```

**Replicate *r* replays plan *r*, in filename order.** So `-n 5` *can* replay five distinct structures per
case rather than one structure five times — if the five files differ. That matters because a paired A/B
gets its resolution from holding the plan fixed across arms — and with a single plan per case, "held
fixed" and "held at exactly one value" are the same thing, so the comparison would say nothing about
whether the effect survives a different partition. Given the 26-point spread that scope count once produced,
the structure a case is pinned at is not a neutral choice. N distinct plans buy **generality and pairing at
the same replicate count and the same spend** (`copirate-determinism-5od.2sd`) — but distinct plans have to
be minted deliberately now, since an un-pinned PR arm no longer rolls them.

Pairing survives it because both arms resolve the same dir the same way, so arm A's replicate *r* and arm
B's replicate *r* share a structure. It also survives a **resume**: level *r* names plan *r* no matter
which invocation queued it, so an arm run in one pass and an arm that crashed and resumed replay the same
multiset. `eval/paired.js` needs no knowledge of any of this — it keys on plan *content*.

```bash
# every case replays its own five frozen structures; the arm is the only thing that differs
CLAUDE_CODE_OAUTH_TOKEN=… node eval/freeze-suite.js -n 5 --out eval/out/ab-sweep2 --sweep-cap 2 --plans <plans-dir>
CLAUDE_CODE_OAUTH_TOKEN=… node eval/freeze-suite.js -n 5 --out eval/out/ab-sweep0 --sweep-cap 0 --plans <plans-dir>
```

If a selected case has no directory there, has **fewer plans than `-n`**, or holds a plan that does not
parse, the **whole suite is refused before a single credential resolves**. Two failures are worth refusing
for the same reason: a partially-pinned suite (some cases replay a frozen structure while the rest run
whatever they compute) and a shallow one (levels past the last plan fall back to the computed partition),
because each silently mixes structures the pin was meant to choose, with nothing in the report saying
which replicates carried which. *More* plans than `-n` is fine and deliberate — the extras are the depth
a later `-n` resume grows into, against this same dir. What the suite runner checks is only existence, count and shape — the
plan's fit to a case's *diff* needs that case's material, so it is proven per replay, inside the engine
pass.

**Where the plans come from.** Every run writes `plan.json`, so a plan set is harvested rather than
authored — but only runs from `copirate-determinism-5od.ea7` onward carry one, and the runs stored under
`eval/out/` predate it. The way to mint a set at no extra cost is to run the **first arm un-pinned** and
harvest its `plan.json` files into `<plans-dir>/<case>/`, then run the second arm pinned to them. The
multisets then match by construction. Be clear about what such a harvest holds: on a PR case an un-pinned
arm computes the same partition on every replicate, so its N `plan.json` files are N copies of one
structure, and pinning the second arm to them holds the comparison at exactly that one value. A set of
genuinely distinct plans comes from runs under different `MIN_SCOPE_FILES` values or from hand-authored
files, not from replaying. Only a repo-mode arm still rolls distinct plans by itself, and its scout spawns
are the ones a fresh arm pays anyway.

Unlike an effort arm, a mix of pinned and computed runs under one `--out` is **not** refused: the arm
check (`misarmedRuns`) was left alone on purpose, since a plan is not an arm. What distinguishes them
after the fact is each run's own `plan.json`: a pinned replay records `provenance: "pinned"` and
`scoutUsage: null`. Provenance records which producer **ran**, not which one wrote the bytes — replaying
a file that says `"partition"` or `"scout"` still records `"pinned"`, and any price field it carries is
dropped, because no scout spawn happened to bill for.

### Reading it as a paired A/B: `eval/paired.js`

Pinning the plan is only half the win — the other half is *spending* it in the statistic. `eval/paired.js`
(`npm run review:paired`) takes the two arm roots and reduces them as a **paired** comparison instead of a
difference of two pooled rates:

```bash
node eval/paired.js eval/out/ab-sweep2 eval/out/ab-sweep0 [--out <dir>]
```

It is an **instrument, not a third scorer**: it never runs the engine, never re-matches findings, and needs
no credential. It reads the per-run `scorecard.json` `score.js` already wrote (the inventory must-find
bucket — the gate metric, and only that one: a paired report over four buckets would be four experiments
wearing one p-value) and the per-run `plan.json` the pass already recorded, and reduces them to

* **discordant pairs** — how many findings arm A found and arm B missed (`b`), and the reverse (`c`),
* an **exact McNemar p-value** — the two-sided binomial sign test on `b` and `c`, exact rather than the
  chi-square approximation because the discordant counts here are a handful out of a hundred,
* the **two pooled rates over the same paired set**, their difference, and the paired SE, and
* the comparison's own **approximate 95 % resolution** (`1.96 × SE`), printed whether the result is null or
  not — "no significant difference" is uninterpretable without the size of the difference the instrument
  could have seen. It is a design figure and it is optimistic below about ten discordant pairs; the exact
  p above it is the ruling.

The pairing unit is **(case, plan, finding)**, and a pair whose two halves ran different structures is
**refused, never formed**: for every case, the multiset of plans in arm A must equal the multiset in arm B —
same plans, same number of replicates each. A plan's identity is its `scopes` and `context`, *not* its
`provenance`: two runs can both say `"pinned"` and carry different partitions, and that is exactly the
mistake the refusal exists to catch. Because of that, no separate pinned-vs-computed check is needed:
a computed PR arm's keys match a pinned arm's exactly when the pinned plans are the computed ones, and
whenever they are anything else — a different `MIN_SCOPE_FILES`, a hand-authored partition, a repo-mode
arm that re-rolled — the keys differ and the comparison refuses on its own. The other refusals, each
naming the offending dir: a run with no `plan.json` (it predates the
plan record, so what structure it ran is unknown), an unscored run, an arm root that blended two effort
arms, a run whose `meta.json` names a different case than the dir it sits under (the same misplaced-run
rule `compare.js` applies at the same kind of boundary), a scorecard whose must-find ids collide so an
outcome is unrecoverable, a case present in only one arm, and a case whose must-find inventory moved
between the two replays — that last one naming the ids that differ, since a same-size swap is invisible
in a count. Plans are named in refusals and in the report by a short digest of their key, because scope
count alone does not identify a partition.

Within one `(case, plan)` block each arm may hold several replicates — a `--plans` dir that repeats a
structure, or one harvested from a computed PR arm, which repeats its structure on every replicate — and
the k-th run of arm A is matched with the k-th run of arm B in sorted run-dir order. That alignment is **arbitrary but deterministic**, and it is sound: given the plan, an arm's
replicates are exchangeable, so under the null P(A hit, B miss) = P(A miss, B hit) for *any* one-to-one
alignment, and the exact test stays exact. What run k shares with run k is the block and nothing else; the
pairing claims no more than that.

**What pairing buys, in points.** Unpaired at N=5 over the four cases, the SE of the arm difference is
~6.7 points — a ~13-point minimum detectable effect at 95 %. Paired, the SE is `√(π_d/n)` over
`n = 20 × N` opportunities (20 = the suite's must-finds per replicate), where `π_d` is the discordance
rate with the plan held fixed. Estimated from the runs already on disk, `π_d` brackets between 0.196
(runs of one case that happened to agree on scope count — the closest proxy for a fixed plan) and 0.255
(all cross-run pairs, plan roll included), giving:

| N | paired opportunities | MDE at 95 % confidence | MDE at 80 % power |
| --- | --- | --- | --- |
| 3 | 60 | 11.2 – 12.8 pts | 16.0 – 18.3 pts |
| 5 | 100 | 8.7 – 9.9 pts | 12.4 – 14.1 pts |

Both are upper bounds — a same-scope-count pair is not a same-*plan* pair — so the real figures are at or
below these. The practical reading: **a paired N=3 resolves about what an unpaired N=5 did**, on 60 % of the
replays. `paired.js` reports the realised
resolution from the discordance it actually observed, so a design's claim is checked against the run that
tested it.

Exit codes are a **dichotomy**, deliberately narrower than `compare.js`'s: `0` = ran, `2` = refused.
Nothing exits `1`, because a paired p-value is evidence for a decision and not the decision — the gate
lives in `compare.js`. Artifacts land at `<out>/paired.{md,json}`, defaulting to
`eval/out/paired-<armA>-vs-<armB>-<digest>` — the arm names for a reader, and a digest of the two resolved
roots so two comparisons whose names happen to flatten alike cannot overwrite each other's report.

## Scoring a replay

`eval/score.js` (`npm run review:score`) reduces a case's replay artifacts to the
number the harness exists to protect: **inventory must-find recall** (found / total
must-find across the whole pooled inventory — the gate metric), reported alongside the
frozen-round must-find recall (the pre-inventory view, comparable with older runs),
plus nice-to-find recall, noise count, and cost — the secondary metrics. Matching runs
round-agnostically over the whole inventory; the frozen-round and inventory views are
derived per-bucket filters of one matched set, so a produced finding that matches a
*later-round* defect counts as an early find, never as noise. It is an
**instrument, not a second review implementation**: it never re-runs the engine and
never re-derives the expected set; it only *matches* the frozen `expected.json` against
a run's `findings.json` and reduces the match to metrics.

```bash
ANTHROPIC_API_KEY=… node eval/score.js eval/out/<case-name> [options]
# options: --matcher llm|lexical (default llm), --cases-dir <dir> (default eval/cases),
#          --cache <file> (default eval/out/.judge-cache.json)
```

The match is **two stages, cheap first**:

1. **Candidate pairing** (pure, deterministic) — a produced finding can match an
   expected one only when the **path is identical** and the new-file line is within a
   ±10 window (findings legitimately anchor a few lines off; `partitionFindings`'
   `MAX_ANCHOR_SNAP_DISTANCE` is the precedent).
2. **Semantic identity** — does the produced body describe the **same defect** as the
   expected body? This is the one judgment that isn't lexical, so it is the one
   **effect**: an LLM judge (a cheap pinned model snapshot, `claude-haiku-4-5-20251001`,
   over its own `ANTHROPIC_API_KEY`) rules match / no-match on each candidate pair. The
   judge's credential is deliberately **not** the engine's: it is the ruler, and a ruler
   that moved with the thing it measures would measure nothing. The scoring core
   never knows which judge it holds — the offline `--matcher lexical` (deterministic
   word-overlap) is the same `judge(pairs) → decisions` shape and needs no credential.

**Determinism** (scoring the same `findings.json` twice yields the identical scorecard)
is a *structural* property of a **content-keyed cache**, not a hope about LLM
temperature: the first scoring populates `eval/out/.judge-cache.json`; every later
scoring reads it, so the judge is never re-consulted for a pair it already ruled on.
The cache key includes a `JUDGE_VERSION` token, so changing the judge prompt or model
can never silently reuse a stale ruling.

```
eval/out/<case-name>/
  <ts>-run<i>/scorecard.json   — per run: must-find/nice-to-find recall (found, total, foundIds,
                                 missedIds), noise items, cost, the run's effort (the arm, copied from
                                 meta.json), and the per-pair match detail.
  scorecard-summary.json       — across the case's runs: mean/min/max recall band and the one effort
                                 every run in the dir shares, the shape 2fk.4 (baseline/variance)
                                 reduces.
```

The judge is a **measurement instrument** and is validated once: hand-match the
flagship case, run the judge, and require ≥90% agreement before trusting it (recorded on
`copirate-eval-harness-2fk.3`). If agreement ever fails, `--matcher lexical` is the
declared fallback. Like the rest of `eval/`, `score.js` is dev-only and does **not** bump
the version.

## Freezing a baseline

`eval/baseline.js` (`npm run review:baseline`) reduces the whole scored suite into one
**frozen baseline** — the reference distribution the compare gate
(`copirate-eval-harness-2fk.5`) measures a candidate engine change against. It is an
instrument, not a third scorer: it never re-runs the engine and never re-scores. It only
*collects* the per-case `scorecard-summary.json` bands `score.js` already wrote, tags them
with the exact commit whose engine tree produced them + the pinned engine, derives the suite's pooled gate
floor + each case's diagnostic floor and the suite cost, and writes the result under
`eval/baseline/<date>-<short-sha>/`.

Full-suite workflow (run → score → freeze):

```bash
# 1. Replay every golden case N times (N=5 for the current baseline; rationale below).
#    Per-replay logs land in the SIBLING eval/out/freeze-<sha>-logs/, so every child of the out
#    root below is a case run dir and the glob in step 2 needs no exclusions.
CLAUDE_CODE_OAUTH_TOKEN=… node eval/freeze-suite.js -n 5 --out eval/out/freeze-<sha>
#    (a baseline is frozen at the DEFAULT effort profile; --sweep-cap and --read-set belong to
#     A/B roots, not to this one)
# 2. Score each case (writes scorecard-summary.json per case).
for c in eval/out/freeze-<sha>/*/; do ANTHROPIC_API_KEY=… node eval/score.js "$c"; done
# 3. Freeze the scored suite into a committed baseline (baseline.json + baseline.md).
node eval/baseline.js --out-dir eval/out/freeze-<sha>
```

Step 1 is `eval/freeze-suite.js` and not a shell loop over `run-case.js` because a suite is
~20 replays over several hours against a subscription that walls for hours at a time, and the
loop had no way to survive that. The suite runner adds exactly four things and reimplements
nothing — every job is still `run-case.js -n 1` in its own process:

- **A census, so it resumes.** A completed run is a dir carrying `findings.json` (the
  scorer's own definition, exported from `score.js` so the two cannot disagree). The runner
  counts what is already there and plans only the deficit, so re-running the command after a
  wall picks up where it stopped — there is no resume flag because there is no resume mode.
  Timing follows the same shape: each invocation writes its own `suite-timing-<startedAt>.json`
  under the out root — `{ startedAt, elapsedMs, replays: [...] }` — so a suite finished across
  several legs keeps every leg's clock, and a status-check re-run (which plans nothing) cannot
  erase what an earlier one measured. `elapsedMs` is wall clock, never the sum of
  `replays[].durationMs`: the lanes overlap, and wall clock is the figure the gate's
  45-minute bar is stated in. `readSuiteTiming()` folds the legs into one answer, but it is a
  library primitive with **no reader today** — no CLI prints the folded total; it exists for the
  gate (zai-eval-harness-5ux) to size itself against. Read a suite's real cost by folding the
  legs yourself, or read a single leg's file directly.
- **Level-filling order.** A job exists for case *c* at level *r* iff *c* has fewer than *r*
  completed runs, so every case is deepened before any one of them is. An interruption leaves
  an even suite (a valid smaller N — `baseline.js` demands one common N) instead of 5/5/5/0,
  which freezes nothing. The closing report names the deepest freezable N.
- **A deadline per replay** (`--job-timeout`, default 120 minutes). A throttled credential does not
  reliably *fail* — the engine CLI can sit in silent retry — and one lane waiting on it holds the
  queue forever. On expiry the replay's whole process group is killed (the engine's workers are
  grandchildren; signalling only the direct child would orphan them still burning quota) and the job
  is reported as `TIMED OUT`, never as an ordinary non-zero exit.
- **One lane per credential.** `--credentials VAR1,VAR2,…` names environment variables
  holding one credential each and replays on all of them concurrently; each lane is
  sequential. A lane takes the first queued job it has not already attempted, and a failure
  requeues that job to the back rather than ending the lane — so a walled credential crosses
  the whole queue in seconds, putting every job back for a healthy lane, while one bad job
  costs a single attempt instead of abandoning the rest of the suite. A lane returns only when
  every job left in the queue is one it has already tried. Which env var the credential travels
  under is derived from `src/provider.js`, not written here.
  Lanes share one host, so each replay is handed `--memory-budget` = host memory ÷ lane count
  (`laneMemoryShare`): a lone `run-case.js` plans its engine lanes against the whole machine,
  and L of them each doing so would multiply the per-lane memory guardrail by L.
  An interrupt (Ctrl-C) is forwarded to every replay still running before the runner exits;
  replays run in their own process groups for the deadline's sake, which also puts them out of
  reach of the terminal's own signal.

The runner exits non-zero whenever any case is still short of the target, and prints every
attempt with its exit code, wall clock, and log path — the crashed 2026-08-30 freeze left two
empty run dirs that nobody noticed for five days, which is the failure this makes impossible.

`baseline.js` refuses to freeze an inconsistent suite loudly: every case must have been
scored over the same N, with the same matcher, on the same pinned engine, and every frozen
golden case must have a scored summary — a golden case with no summary aborts, so a partial
baseline never masquerades as complete. (The golden set is `cases-dir`, so a scored dir under
`eval/out/` with no matching golden case — an experimental or stale run — is simply not part
of the suite and is ignored, not an error.) Unlike the run/score artifacts
under `eval/out/` (git-ignored), the baseline directory is **committed**: it is the
ground-truth reference, versioned alongside the code it characterizes. `baseline.js` is
still dev-only tooling and does **not** bump the version.

```
eval/baseline/<date>-<short-sha>/
  baseline.json   — the frozen distribution (schema v2): the suite's pooled INVENTORY must-find gate floor
                    (the one gate number), the frozen-round pooled rate (continuity diagnostic), each case's
                    inventory + frozen-round recall bands (mean/min/max) + diagnostic floor, the suite cost,
                    the pinned engine, the effort the suite was frozen at (null on a pre-arm freeze, which
                    the gate reads as "cannot prove its arm"), and the degradation rule. parseBaseline (exported) is the loader the
                    compare gate (2fk.5) reuses, and evaluateGate is the one predicate that applies the rule.
  baseline.md     — the same, human-readable: the per-case band table, suite cost, and the rule.
```

### The degradation rule

A candidate (an engine/prompt/effort change under test) is scored by replaying the **same**
suite at the **same** N, **pooling** every run's inventory must-find finds into one rate, and
comparing it to the frozen baseline:

> **The suite is DEGRADED when the candidate's *pooled inventory* must-find recall — total
> inventory must-finds found across all N×cases runs ÷ total inventory must-find
> opportunities, where a case's inventory pools every distinct must-find from all of its
> source PR's review rounds that exists in the frozen material — falls below this baseline's
> pooled gate floor (the pooled rate minus a ~2σ binomial sampling margin).**

`evaluateGate` in `eval/baseline.js` is the single enforcer of this rule
(`[LAW:single-enforcer]`): the compare CLI (2fk.5) wraps it, and its behavior — the gate
fails a candidate whose pooled inventory recall drops below the frozen floor — is pinned by
`test/eval-baseline.test.js`. For a case with no inventory rounds the inventory equals the
frozen round, so this gate is a strict generalization of the earlier frozen-round gate; the
frozen-round pooled rate stays in the baseline as a continuity diagnostic comparable with
the pre-inventory (v1) baseline.

The gate is **pooled across runs, not per-case**, and that choice is forced by the data.
Must-find denominators are small, so per-case recall is **quantized and jittery**: for a
3-finding case it can only be 0, ⅓, ⅔, or 1, a single finding flipping swings it 33 points,
and — as the first baseline showed — the run-to-run spread exceeds the mean for three of the
four cases, with three per-case floors sitting at 0 % (a "mean below the floor" rule can
never fire there). A per-case gate is false precision. Pooling all the must-find
opportunities into one binomial rate restores a sample large enough to carry a real sampling
margin, so the floor is a meaningful line rather than noise. The per-case bands are kept only
as **diagnostics** — they localize *which* case moved a pooled regression; they do not gate
on their own.

### The current baseline (live engine, inventory-gated)

The gate reference is
[`eval/baseline/2026-09-06-ebccbd4/`](baseline/2026-09-06-ebccbd4/baseline.md) — the engine
tree at `ebccbd4`, `claude-subscription` / `claude-sonnet-5`, N=5, schema v2. Headline:
**pooled inventory must-find recall 37 % (37 of 100 opportunities), gate floor 28 %.** The
frozen-round pooled rate measured 35 % (26/75).

**Read the jump from 22 % to 37 % as an ENGINE change, not a recall win.** No prompt moved
between the two freezes. `PROVIDER: auto` was retargeted from `deepseek-v4-pro` to
`claude-sonnet-5` in 1.42.0, and this is the first measurement of the engine production
actually runs. The recall epic (`zai-recall-upr`) has still shipped no lever — its work is
simply now measured against 37 % instead of 22 %.

**Provenance: the SHA is deliberately not a `main` commit.** `ebccbd4` is a branch commit.
This repo squash-merges, so the tree that produced these runs never lands on `main` under its
own SHA — naming a `main` commit would name a tree that produced none of these numbers. The
freeze names the engine tree instead. Only the `mainSha` field name still carries the old
assumption; `compare.js` ranks baselines by which commit last touched `baseline.json`, never
by reachability, so nothing mechanical depends on it.

**Cost basis: subscription quota, not dollars.** No run reports a cost, so `baseline.js`
records `costPerFullRunUsd: null` with `uncostedRuns: 20` rather than passing a partial sum
off as a total. The CLI's own meter is notional here — one *failed* `links-317` replay
reported $4.01 that was never billed. The real currency is wall clock and quota: ~13–27 min
per replay, ~4.5 h for the suite across three subscription lanes, and the daily wall
(midnight America/Denver) reached on all three accounts before the last replay landed.

### Superseded: the deepseek baselines

[`eval/baseline/2026-08-10-787df41/`](baseline/2026-08-10-787df41/baseline.md) — `main` at
`787df41`, `deepseek-v4-pro`, N=5, schema v2. **Pooled inventory must-find recall 22 % (22 of
100), gate floor 14 %**; frozen-round pooled 21 % (16/75). A full suite run cost ≈ $0.68; the
whole N=5 baseline $3.41. Kept as history only: the provider was retired (account at 402) and
`PROVIDER: auto` no longer resolves to it, so it can gate nothing.

### The first baseline, and the variance that shaped the rule

The first frozen baseline is
[`eval/baseline/2026-08-01-dc87ee0/`](baseline/2026-08-01-dc87ee0/baseline.md) — `main` at
`dc87ee0`, engine `deepseek-v4-pro`, N=5, **schema v1** (pre-inventory: its ground truth was
each case's frozen round only, and its gate metric the frozen-round pooled rate — kept as
history; later baselines supersede it as the gate reference). Headline: **pooled
must-find recall 19 % (14 of 75 opportunities), gate floor 10 %.** A full suite run (all four
cases once) costs ≈ $0.70; the whole N=5 baseline cost **$3.48**.

The per-case variance behind the pooled rule (above) is stark — every case's run-to-run
spread is large relative to its mean, and for three of the four the spread *exceeds* the mean:

| case | must-find | mean | min–max | per-run finds |
|------|-----------|------|---------|---------------|
| `cc-candybar-150-transcript-perf` | /7 | 14 % | 0–43 % | 1·3·0·0·1 |
| `copirate-93-dependency-diff`     | /3 | 13 % | 0–33 % | 0·1·1·0·0 |
| `laws-4-eval-tasks`               | /2 | 10 % | 0–50 % | 0·0·1·0·0 |
| `links-317-dolt-telemetry`        | /3 | 40 % | 33–67 % | 1·1·1·2·1 |

The three 0 % floors are why a per-case gate would police only `links-317`; the pooled rate
folds all 75 opportunities into one number instead.

### Is N stable enough to gate on?

**For the pooled rate, yes at N=5; for per-case recall, no at any practical N.** The pooled
rate aggregates 75 Bernoulli trials, so its ~2σ sampling margin is about ±9 points (a 10 %
floor under a 19 % mean) — tight enough that a candidate dipping below the floor is real
degradation, not jitter. Per-case recall is the opposite: with denominators of 2–7 findings
a single finding flipping swings recall 33–50 points, the run-to-run spread exceeds the mean
for three of four cases, and shrinking a per-case mean's standard error enough to gate would
take ~30+ repeats per case (~$20 and hours) — not worth it. So the harness gates on the
pooled suite rate, uses the per-case bands only to localize a regression, and **N=5 is the
standing baseline depth.**

The deeper result is the epic's headline, and it is not a defect in the harness: pooled
inventory must-find recall is **37 %** on the live engine — the engine reproduces roughly one
in three of the golden set's hardest findings in a single round (it was ~19–22 % on the
retired deepseek engine). The instrument is faithful (the LLM judge agreed with hand-matching
11/11 during `copirate-eval-harness-2fk.3`); the low number is the truth it was built to
measure. It is the floor the efficiency epic (`copirate-efficiency-235`) must not push
lower, and the bar the quality work must raise.

## Comparing a candidate — the quality gate

`eval/compare.js` (`npm run review:compare`) is the command the whole epic exists for: **"did my
change degrade finding quality?"** answered as a measured verdict, not a guess. It gates the
**current working tree** (the candidate — the replay runner drives `src/` directly, so the candidate
is simply the code as checked out; no build or publish) against a frozen baseline.

```bash
# The engine credential is the pinned provider's own input var (CLAUDE_CODE_OAUTH_TOKEN for the
# current pins), or one env var per --credentials lane as .github/workflows/eval.yml runs it.
ANTHROPIC_API_KEY=… <engine credential(s)> node eval/compare.js
# options: --baseline <dir|baseline.json> (default: newest under eval/baseline/ by COMMIT-GRAPH order,
#            not directory-name order — an uncommitted baseline.json always outranks a committed one;
#            refused if the newest can't be determined unambiguously, e.g. a shallow git clone with
#            more than one candidate),
#          --matcher llm|lexical (default llm; MUST match the baseline's matcher; IGNORED under
#            --reuse-candidate, where the reused summaries' own recorded matcher is checked instead),
#          --out <dir> (default eval/out/candidate-<ts>, git-ignored; mutually exclusive with
#            --reuse-candidate; an existing root resumes — runs under it recorded on this same clean
#            commit count toward N — and any run that is not provably this candidate's, or a case holding
#            more runs than the baseline's N, is refused by name),
#          --credentials <A,B,…> (env var names, one replay lane each, forwarded to freeze-suite.js;
#            default: one lane on the pinned provider's own input), --cases-dir <dir>, --cache <file>,
#          --reuse-candidate <dir> (gate an already-produced candidate root; no replay, no spend; the
#            verdict names the tree the reused runs record, not the checked-out tree; mutually
#            exclusive with --out)
```

ANTHROPIC_API_KEY is required **unconditionally** for the default `--matcher llm` (the judge's own
credential), regardless of which provider the baseline's pinned engine itself uses — pass
`--matcher lexical` to avoid it. It is a *second* credential alongside the engine's
(`CLAUDE_CODE_OAUTH_TOKEN` for the current pins), on purpose: a subscription OAuth token authenticates
the review CLI, not the raw Messages call the judge makes, and a judge sharing the engine's credential
would be a ruler that moves with what it measures.

**A candidate is just another suite.** `compare.js` reimplements no pooling, no scoring, and no
gate predicate — it:

1. replays every baseline case **N times** — N comes *from the baseline* and is imposed on the
   replay; the engine and the effort arm are the checked-out tree's own and are *asserted against*
   the baseline's, a mismatch refusing rather than adapting (see [Varying a lever](#varying-a-lever-ab-arms)
   for why forcing the arm would be worse) — by spawning
   `freeze-suite.js` over the baseline's case set — the freeze's own scheduler, driving
   `run-case.js` once per replay across the `--credentials` lanes — then scores each case with
   `score.js`, into an isolated candidate root;
2. reduces the candidate's scored summaries into a suite with the **same `buildBaseline`** the
   frozen baseline was built with — so the producer and the comparator can never drift
   (`[LAW:one-source-of-truth]`); and
3. applies the frozen [degradation rule](#the-degradation-rule) via `baseline.js`'s `evaluateGate`
   (`[LAW:single-enforcer]`): **candidate pooled inventory must-find recall < the baseline's pooled
   gate floor ⇒ DEGRADED.**

It prints the **estimated cost up front** (the baseline's recorded `$/full-run` × the full-suite
passes still owed — N on a fresh root, the deficit on a resumed one), then a
per-case verdict table and a final `DEGRADED` / `OK` / `IMPROVED` line — Markdown, so it pastes
straight into a PR body. The per-case bands are diagnostics that localize *which* case moved a
pooled regression (a `moved?` ⚠️ marks a case whose candidate mean fell below its baseline
diagnostic floor); they never gate on their own. Artifacts land at `<out>/verdict.{md,json}`, and
the per-replay lane logs `freeze-suite.js` writes land in the sibling `<out>-logs/` (a sibling, not a
child, so every child of `<out>` stays a case run dir the scorer can pool).

**Exit codes are a trichotomy** so a CI gate (`copirate-eval-harness-2fk.6`) can tell the three
outcomes apart: `0` = ran and OK/IMPROVED, `1` = ran and **DEGRADED** (the gate tripped), `2` =
could not run (bad args, missing baseline, a matcher/N/engine/effort-arm that isn't comparable —
refused *before* any spend where possible).

### When to run it

Any PR that changes **prompts** (`src/prompt.js`, `review-agent/instructions.md`), **spawn
structure** (`src/multiscope.js`), or **effort/reasoning behavior** (`src/effort.js`) can silently
move finding quality. Run `eval/compare.js` and paste the verdict table into the PR body. The
efficiency epic's quality-sensitive tickets (`copirate-efficiency-235.2`–`.5`) name this as their
acceptance instrument.

### Running it in CI

`.github/workflows/eval.yml` runs the same command in GitHub Actions and puts the verdict where
reviewers look: the verdict table lands in the run's **Step Summary**, `DEGRADED` reds the check
(exit `1`), and the candidate root (per-run findings, scorecards, transcripts, `verdict.{md,json}`)
is uploaded as the `eval-candidate` artifact even on a red or aborted run.

**Under the moratorium there is one trigger and it refuses.** `eval.yml` keeps
`workflow_dispatch` only so the refusal is reachable and legible; its first step exits 1 before
checkout, so a dispatch buys a fast explanation instead of a suite. The `pull_request` label
trigger described below is **deleted** from the workflow — while the suite cannot finish inside 45
minutes, a path that spends it by attaching a label is a path that spends it by accident. The rest
of this section documents the shape to **restore** with the moratorium, not the shape in force.

Two triggers, both deliberate spends. `compare.js` prints the authoritative cost estimate (the
baseline's recorded $/full-run × the full-suite passes still owed) before spending. For the current N=5 × 4-case baseline that
estimate is **no dollar figure at all** — the pinned engine bills against subscription quota, so the
baseline records `costPerFullRunUsd: null`. The spend is quota and wall clock: 20 replays at 13–27 min
each, which `compare.js` hands to `freeze-suite.js` to spread across credential lanes. The workflow
names **three lanes** (`--credentials`, one subscription account each, secrets named after the
keychain items they came from), so a lane carries at most 7 replays and a full gate run is about
**1.5–3.5 hours** — where the single-lane serial shape it replaced needed 4–9 and did not fit a
hosted job's 6-hour ceiling. The job's `timeout-minutes` is derived from that lane math (see its
comment); a timed-out gate is still possible and must be read as *not measured*, never as *not
degraded*. The same 20 replays cost roughly a day of one account's quota, so the lanes also share the
spend — and a run competes with PR reviews on those same accounts while it lasts.

- **On demand**: `gh workflow run eval.yml` (optionally `--ref <branch>`) — pressing the button is
  the spend approval. The candidate is that ref's checkout.
- **Per PR, label-gated**: attach the **`eval`** label to a PR. There is *no* unconditional per-PR
  trigger, and unrelated label changes on an already-labeled PR do not re-run the suite; a push to
  a labeled PR does. The candidate is the PR merge ref — the code as it would land. Fork PRs never
  run the gate: GitHub withholds secrets from fork `pull_request` events, so the job skips them up
  front rather than failing mid-run on empty credentials.

**A walled or timed-out run is not lost.** The workflow carries the candidate root across runs in
the Actions cache, keyed by the commit under gate. On the next dispatch of the *same* commit,
`compare.js` finds the earlier replays under `--out`, checks that each carries this commit's identity
(every run's `meta.json` records the tree that produced it — commit plus dirty flag, from
`run-case.js`'s `workingTree`, the one function both sides read — and only a clean tree has an identity
that can match), and `freeze-suite.js`'s census replays only the deficit. A run
that carries a different identity — another commit, a dirty tree, or none recorded — is refused by
name, never blended: `score.js` pools every run dir under a case into one summary, so a foreign run
would corrupt the candidate silently. A different commit (a push to the PR, a merge to `main`)
matches nothing and starts fresh, as a different candidate should. So when the daily quota walls a
run, re-dispatching on the same commit once the accounts reset finishes the suite instead of
re-spending it; the 2026-09-06 acceptance run walled at 11/20 replays, which is the case this
exists for. Two more refusals guard the same population: a case already holding more runs than the
baseline's N is refused before any spend (a suite scored over unequal N is not comparable), and after
the replay every run under `--out` is checked once more against the tree snapshotted before it — a
working tree that moved mid-invocation is refused by name and no verdict is written, since the
verdict would name a tree that produced none of those runs.

The workflow checks out with `fetch-depth: 0` because the no-`--baseline` newest-pick ranks
committed baselines by commit-graph order, which a shallow clone collapses to a refused tie. It
forwards the three lane secrets (`CLAUDE_CODE_OAUTH_TOKEN_SSSSSMOKEY`, `_SIGNUP`, `_BRANDROID`); each
lane's value is placed in the slot the pinned provider reads, so re-freezing the baseline onto a
metered provider means re-pointing that roster at the new provider's keys, one per lane — and
`ANTHROPIC_API_KEY` stays required regardless of the pins: the default
`llm` matcher's judge reads it unconditionally (`score.js`), and the current baseline's matcher is
`llm/claude-haiku-4-5-20251001`. Runs share one concurrency group — a second trigger
queues rather than interleaving spend.

### The gate's own validation (the sabotage test)

The gate is only trustworthy if it *fires* on a genuinely worse engine, so it is validated by
**deliberately degrading the worker prompt** and confirming `DEGRADED`: strip the "read the files
in full / follow the change to its call sites before judging" directive from `buildReviewInput`
(`src/prompt.js`) — the guidance most responsible for the subtle must-finds — and the pooled recall
collapses below the floor. That run is recorded on `copirate-eval-harness-2fk.5`. Self-consistency
(the baseline's own runs replayed through `compare.js --reuse-candidate` reproduce the baseline rate
⇒ `OK`) is the other half.

Like the rest of `eval/`, `compare.js` is dev-only tooling and does **not** bump the version.

## Adding a new case

1. **Freeze the mechanical inputs** with the freezer, which resolves the reviewed head
   SHA, saves the three-dot diff, captures the head tree as a tarball, extracts the
   review's inline findings into a draft `expected.json` (annotations set to
   `UNREVIEWED`), and writes `case.json` — validating every step and aborting loudly on
   any miss (`[LAW:no-silent-failure]`):

   ```bash
   eval/freeze-case.sh <case-name> <owner/repo> <pr> <review-id> [exclude-patterns] [produced-by]
   # e.g.
   eval/freeze-case.sh cc-candybar-150-transcript-perf promptctl/cc-candybar 150 4669719961
   ```

   The `engine` pin it writes is derived from `src/provider.js` (whatever `PROVIDER=auto`
   currently resolves to), so a retarget can never leave a new case pinned to a retired
   provider. `[produced-by]` defaults to that same engine — correct for a review run
   today; pass it explicitly when freezing an **older** review that a different engine
   produced, since `producedBy` records that history and not the replay pin.

   Find the marker-bearing review id with:
   ```bash
   gh api --paginate repos/<owner>/<repo>/pulls/<pr>/reviews \
     --jq '.[] | select(.body|test("copirate-code-review-agent")) | {id, commit_id, state}'
   ```
   Pass `[exclude-patterns]` only if the source repo's `code-review.yml` overrides
   `EXCLUDE_PATTERNS`; otherwise the freezer uses `action.yml`'s default.

2. **Annotate `expected.json` by hand.** Replace every `UNREVIEWED` with `must-find` /
   `nice-to-find` / `noise` and a written `justification`, reading each finding against
   the actual code — do not trust the agent's own severity label. Prefix
   genuinely ambiguous calls with `AMBIGUOUS —` and raise them with the maintainer. A
   left-over `UNREVIEWED` is intentionally loud so an un-annotated case is never
   silently scored.

3. **Curate the pooled inventory by hand** (the freezer only extracts the frozen
   round). Mine the PR's other marker-bearing rounds, apply the eligibility rule above
   (defect exists in the frozen material; re-anchor to frozen coordinates; dedupe;
   refuted findings become `noise`), and append each eligible finding with its source
   `reviewId`. A case may ship without inventory rounds — it then scores identically on
   both views — but the recall epic's metric only bites on cases that carry one.

4. **Commit** the whole case dir (`case.json`, `change.diff`, `repo.tar.gz`,
   `expected.json`). No version bump — `eval/` is dev-only tooling.
