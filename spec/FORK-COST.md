# Fork cost: constant-time forks and depth-independent reads

**Status**: Proposed, 2026-11-05 (job forkdesign). Design study; nothing here is built. Delta from master `d8f84993` (ARCHITECTURE §3.8 "Per-fork selection", FORK-INDEPENDENCE-DELTA §2.2 "Lineage with bounds") and from the forkcost measurements (`test/forkCostScale.test.ts`, report `work-folder/2026-11-02/forkcost.md`). reference-harness has no counterpart: its `forkSession` (`src/agent/fork.ts`) archives the discarded span as a branch row (a copy of those messages) and has no per-branch choices over shared history, so there is nothing in it to reuse here. **[D]** = the owner's decision, cited; **[P]** = proposed here.

The owner asked (2026-11-05): "whether or not forks are O(1). Does forking a particularly large and complex chat structure cost more now? For example, with many turns, swipes and forks."

## 1. Answer

No, not today, in two places:

1. **Making a fork** costs a few milliseconds (one `forks` row plus bookkeeping), except when the new fork's lineage would grow past 64 entries (`LINEAGE_CAP`). Then it copies every effective override, the visible fork events and the history reductions of its parent: **5.0–6.7 s, 6,010 rows** at 5,000 messages / 600 forks (measured here with `insertFork` alone; forkcost measured 4.5 s through `CreateFork`). That cost grows with the parent's history and swipe choices.
2. **Reading in a fork** costs one index probe per lineage entry for every per-fork lookup (selection, replacement, deletion, hide, star, picker flag, image exclusion, event suppression, summary choice), and the first reply makes about **39 such lookups per message of the path**. A fork near the cap has 64 entries, so the first reply's reads (`PlanSummaries` and `AssembleContext`) take **7×** those of a shallow fork: 16.3 s against 2.2 s at 5,000 messages / 600 forks, 3.1 s against 0.5 s at 1,000 / 200.

Neither depends on messages being copied: forks never copy messages or swipes. Swipes count only through the overrides that select them.

The proposal (§4): give every fork a **label** in a nested-interval order of the fork tree, and index each override by `(kind, target, label)` as a step function. Making a fork becomes two row writes, always (1.6–2.6 ms, no copy, no cap); every lookup is one index probe whatever the depth or the number of forks; and the first reply's reads in a 63-deep fork cost what they cost in a shallow one (1.5 s and 2.4 s; the same work, the difference is noise), as measured on the prototype (§5).

## 2. Where the cost goes today

### 2.1 The lookup

`effectiveOverrideSql(kind, fork, target)` (`db/forkState.ts`) expands to a subquery over `json_each(forks.lineage_json)` with one `fork_overrides_point` probe per entry, then a sort. Every helper that answers "what does this fork show for this slot" (`shownIn`, `selectedIn`, `slotDeletedIn`, `versionDeletedIn`, `imageExcludedIn`, `attachedApplies`, `shownJoin`, the summary choice reads in `lcmFork.ts`) inlines it, so its cost is paid per row of every statement that uses it. `hide` adds a second lineage walk for published LCM hide ranges. Event visibility (`eventVisibleSql`) is another lineage walk per event, and history reductions (`historyChanges.ts`) one per reduction row.

### 2.2 The profile

Method: every statement each storage operation ran was timed in-process (`db/sqlProfile.ts`, a prototype hook on `DatabaseSync.prototype.prepare`) against copies of the forkcost seeds (synthetic `writeStBranchFamily` data, no owner data), with a fork made at the main tip (lineage 2) and a chain of 63 forks below it (lineage 64), as `insertFork` makes them. The operations are the reads a first reply waits on (`PlanSummaries` with reason `reply`, `AssembleContext`) plus the LCM tab's `GetLcmState`, `GetSummary` and a 100-message `ReadPath`. Second run of each, warm. Shared host at load average 60–90, so single figures vary by about ±30%.

Lookups per message of the path, counted from the statements' texts and the rows they returned (the same in both forks; each costs one probe per lineage entry):

| Operation | Lookups per message | Shallow (lineage 2) | 63-deep (lineage 64) |
|---|---:|---:|---:|
| `PlanSummaries` (reply) | 32.3 | 1,719 ms | 12,313 ms |
| `AssembleContext` | 7.1 | 500 ms | 3,999 ms |
| `GetLcmState` | 7.0 | 285 ms | 2,327 ms |
| `ReadPath` (100) | 0.4 | 18 ms | 145 ms |

5,000 messages / 600 forks, 256 MB reader cache (§2.3). Which of these a first token waits for depends on the Summarizer: in the server runs (§5.1) the plan was already settled, and the token waited on `AssembleContext` and the live-rewrite read `RewriteLive`, which reads the same (7 lookups per message each, in parallel readers). At 1,000 messages / 200 forks (32 MB cache): `PlanSummaries` 398 → 2,405 ms, `AssembleContext` 131 → 738 ms, `GetLcmState` 104 → 465 ms, `ReadPath` 50 → 138 ms.

Three statements carry most of it (63-deep fork, 5,000 / 600, one `PlanSummaries`):

| Statement | Runs × rows | Lookups per row | Time |
|---|---:|---:|---:|
| Summary input validity (`lcmLayer.ts` lineage validator: each input's replacement, deletion, hide and range hide) | 297 × 50 | 7 | 5,597 ms |
| Events on the path (`pathEvents`: visibility, suppression, attached-version selection and replacement) | 2 | 4 + 1 per event | 3,685 ms |
| The planner's path read with selections, deletions, hides, image exclusions | 3 × 1,690 | 11 | 2,357 ms |

So the first reply costs about (32 + 7) × messages × lineage probes: 12.6 million probes at 5,000 messages and lineage 64, against 0.4 million at lineage 2. The validator runs three times per plan (297 runs for 99 summaries) and again in `AssembleContext` and `GetLcmState`; that is a separate history-length cost (§6).

### 2.3 Cache size

At the readers' current `cache_size` of 32 MB, the reads at 5,000 / 600 are bound by page reads for either design: master's shallow `PlanSummaries` took 8.1 s at 32 MB and 1.7 s at 256 MB on the same database, and its 63-deep one 19.4 s and 12.3 s. The working set (slot, version and override pages of a 5,000-message path in a 5.6 GB database) doesn't fit in 32 MB. The proposal's step index clusters by key across all forks rather than by fork (§4.6), which makes this worse at 32 MB (shallow 10.8 s) and better at 256 MB (§5). The tables above use 256 MB.

### 2.4 Creating a fork

`insertFork` itself is one `forks` insert (1.6–13 ms measured, first call warming the cache). `CreateFork` adds `hiddenAtFork` (the parent's placed insertions), the composer, current-fork bookkeeping and summary-stamp settlement: 4–34 ms in forkcost, growing with branch points and insertions, not with messages, swipes or overrides. The cap is the only part that grows with history: past 64 entries it copies the parent's effective overrides (one `INSERT` per row, each firing the override triggers), snapshots its visible fork events and sums its history reductions.

## 3. Requirements

- Making a fork costs the same however long its history, however many swipes and overrides, and however deep its genealogy.
- Every read in a fork is bounded independently of lineage depth and of the number of forks in the chat (it may grow with what it reads: the window, the path, the summaries).
- The first reply in any fork costs what it costs in a shallow fork.
- Every current semantic stays (ARCHITECTURE §3.8): a choice in F never shows in G, made before or after; a fork made later inherits from any point of its parent's path (keys are slots and versions, not positions); nothing a fork does later reaches forks made from it; per-fork deletes, copies (`replace`), flags, hides and hide ranges, image exclusions, insertions, events and their suppression, summary choices, reruns and history reductions.

## 4. Proposal: nested-interval fork labels [P]

### 4.1 Labels

Each fork F has a **base** `B(F)` (a byte string) and an **epoch** `e(F)`: how many forks were made from it so far. Its **point** is `B(F)·enc(e(F))`; its **range** is every string from `B(F)·enc(0)` up to `end(F) = B(F)·0xFF`. `enc` is an order-preserving, prefix-free code: one byte `e + 1` for `e < 224`, else `0xF0` and two bytes (up to 65,759 forks from one fork); `0xFF` never starts a code. A chat's first fork has the empty base.

Making G from F: `B(G) = point(F)`, `e(G) = 0`, then `e(F) += 1`. That is two row writes and no reads beyond the parent's row.

So the ranges nest like the fork tree. G's range sits after F's point at the time and before F's next point; everything F writes from then on is at a later point than anything in G's range, and everything F wrote before is at an earlier one. Ancestors' points at the time each child was made are exactly the labels below G's point whose ranges contain it.

### 4.2 Overrides as a step function

`fork_overrides` keeps its rows (one per fork, kind and target, updated in place while no fork was made since, as now). A second table indexes them:

```
fork_steps(kind, target_id, label, override_id)   PRIMARY KEY (kind, target_id, label), WITHOUT ROWID
```

Writing a row for (kind, target) in F adds:

- a **step** at `point(F)` naming the row (replacing a step of F's own at the same point: the newest row of that lineage entry wins, as now);
- unless one is already there, an **end step** at `end(F)` naming the row that was in force at `end(F)` just before (null: none, the base column).

The effective row of (kind, target) in any fork X is the step with the greatest label ≤ `point(X)`:

```sql
SELECT override_id FROM fork_steps
WHERE kind = ? AND target_id = ? AND label <= (SELECT point FROM fork_labels WHERE fork_id = ?)
ORDER BY label DESC LIMIT 1
```

One B-tree descent (`SEARCH … USING PRIMARY KEY (kind=? AND target_id=? AND label<?)`), whatever X's depth and however many forks the chat has.

Why it's the lineage rule. Steps inside F's range come only from F and the forks made from it, and every fork's steps are closed by its own end step, so from outside a range its writes cancel out. Points in F's range see F's latest step below them (F's own later choices for F and forks made after them, earlier ones for forks made earlier), and where F has none, the value in force where F's range began: what F inherited. End steps never go stale: the region they restore lies in an epoch of the parent that is closed, so nothing is written there again. The prototype checked this against the lineage query directly: 79,200 lookups (all 264 forks × 300 sampled keys, 1,000 / 200 with the 63-deep chain), 40,100 lookups with a 200-deep chain, and every fork × fork-event pair for visibility: no differences.

Hides: a slot's own `hide` step and the `hide_range` steps of published runs containing it are each one probe; the innermost wins, which is the one whose writer has the longer base (same writer: the newer seq), as lineage order and seq do now.

### 4.3 Events and history reductions

Rows that are added rather than keyed (fork-scoped `state_events`, `history_changes`) record the writer's point when written (`fork_label`). Such a row is visible in X iff `label ≤ point(X) < end(writer)`: two comparisons, no lineage walk. `fork_event_snapshots` and the history copy exist only for the cap and go.

### 4.4 Enumerations

Three reads list a fork's effective rows of a kind rather than looking up a key: placed insertions (`placedInsertions`), the plain-fork check (`shellPlainForksQuery`) and the ST re-import's local-choice check (`stImportWrites.ts`). They walk the fork's ancestors by `parent_fork_id` (a recursive CTE; one range probe of `fork_overrides_point` per ancestor and kind, as today), then keep the candidates whose step probe names them. That is O(depth) probes once per operation, not per message (estimated well under a millisecond at depth 200; the prototype keeps the uncapped lineage list for these and its 200-deep `ReadPath` took 10 ms). Reads of "the forks that see a row" (summary-stamp invalidation in `summaryValidity.ts`, `instr(lineage_json, …)` today) become a range scan of `fork_labels(chat_id, point)` over `[label, end(writer))`.

### 4.5 What goes

`LINEAGE_CAP` and the copy at the cap, `fork_event_snapshots`, the history copy, and `forks.lineage_json` (its readers move to labels or to the ancestor walk). `branched_at` and `seq` stay: optimistic row versions, the in-place update rule and ST re-import ordering use them.

### 4.6 Costs

- **Making a fork**: one `forks` row, one `fork_labels` row, one update of the parent's epoch. Independent of everything. The rest of `CreateFork` is unchanged (§2.4).
- **A per-fork write**: the row as now, plus one probe and up to two step writes. The first write of a key in a fork writes the end step; later ones replace the point step.
- **A lookup**: one probe. On the 5,000 / 600 seed: 8.6–9.5 µs warm in both a shallow and a 63-deep fork, against 12–18 µs (shallow) and 69–84 µs (63-deep) for the lineage walk (Python harness, 20,000 lookups of four kinds over the main path, 32–512 MB cache).
- **Locality**: the step index is ordered by key across all forks, not by fork. In the 5,000 / 600 seed every fork overrides the whole shared prefix, so a prefix key carries 1,200 steps and each lookup touches its own leaf page; at 32 MB cache a lookup took 43–56 µs in either fork. The readers' cache goes to 256 MB (§2.3, §4.8), which master's shallow reads already need at this scale. In chats where forks mostly choose among their own new messages, a key has a few steps.
- **Space**: two steps per (fork, key) at most. Prototype: +898 MB (+16%) on the 5.6 GB 5,000 / 600 seed, 7.2 million steps for 3.6 million overrides, about 125 bytes each, mostly the two text ids (target and override). Naming the override by its integer rowid would save about a third. Labels grow by one byte per level of genealogy (201 bytes at depth 200); rows written in shallow forks keep short labels.
- **Rebuilding** labels and steps from seqs (bulk fixtures, `rebuildForkLabels`): 9.6 s for 243,582 overrides, 183 s for 3,605,156.

### 4.7 Ties and order

Forks made at the same seq (two `CreateFork`s with nothing between) get distinct epochs in creation order, so they see the same parent rows and none of each other's. A rebuild orders a fork's children by `(branched_at, id)` and puts a row of seq s at the epoch counting the children with `branched_at < s`, which reproduces the bounds `seq ≤ branched_at` exactly, ties included (verified above).

### 4.8 Choices made here [P]

- Labels are BLOBs (the prototype uses lowercase hex text: same order, twice the size).
- Labels live in their own table `fork_labels(fork_id, chat_id, base, epoch, point, label_end)`, so bumping an epoch doesn't touch `forks` rows, their row versions or shell-stamp triggers.
- Steps and event labels are maintained by `AFTER INSERT` triggers on `forks`, `fork_overrides` and `state_events` (writes into `fork_overrides` happen in three files today; the triggers keep them all right). Bulk fixtures pause them through a one-row table and call the rebuild.
- Purging a chat deletes its steps by its overrides' keys (target ids are unique per chat).
- Reader `cache_size` 256 MB (`-262144`), from 32 MB. SQLite allocates it as pages are read, so small libraries don't pay it.

## 5. Measured on the prototype

Prototype in worktree `job/forkdesign-proto` (`db/forkLabels.ts`, `effectiveOverrideSql`, `eventVisibleSql`, `insertFork` without the cap, baseline additions). Same seeds, forks and operations as §2.2.

| 5,000 messages / 600 forks, 256 MB cache | Master shallow | Master 63-deep | Labels shallow | Labels 63-deep |
|---|---:|---:|---:|---:|
| `PlanSummaries` (reply) | 1,719 | 12,313 | 1,846 | 1,185 |
| `AssembleContext` | 500 | 3,999 | 564 | 323 |
| `GetLcmState` | 285 | 2,327 | 349 | 235 |
| `ReadPath` (100) | 18 | 145 | 16 | 14 |
| First-reply reads (first two rows) | 2,219 | 16,312 | 2,410 | 1,508 |
| `insertFork` from main / from the 63-deep chain | 3.5–13 / 5,046–6,722 (copies 6,010) | | 1.6–12.8 / 1.7–2.6 (copies 0) | |

ms, warm second run; ±30% between runs on the shared host (the labels' 63-deep fork ran faster than its shallow one only by noise).

| 1,000 messages / 200 forks, 32 MB cache | Master shallow | Master 63-deep | Labels shallow | Labels 63-deep | Labels 200-deep |
|---|---:|---:|---:|---:|---:|
| `PlanSummaries` (reply) | 398 | 2,405 | 267 | 256 | 177 |
| `AssembleContext` | 131 | 738 | 73 | 94 | 60 |
| `GetLcmState` | 104 | 465 | 68 | 55 | 40 |
| `ReadPath` (100) | 50 | 138 | 16 | 13 | 10 |

The 200-deep fork has a 201-entry lineage (no cap); master would have compacted it three times.

### 5.1 First reply end to end

| 5,000 messages / 600 forks, server end to end | Shallow fork | 63-deep fork | 64th link of the chain |
|---|---:|---:|---:|
| Labels (prototype, 256 MB cache): first-token latency | 3,157 ms | 2,843 ms | |
| Labels: `CreateFork` | 26 ms | median 7.7 ms over the 64 links, max 31.8 | 7.1 ms |
| Master (forkcost, 32 MB cache): first-token latency | 2,594 ms | 10,041 ms | |
| Master: `CreateFork` | 9.6 ms | | 4,511 ms (copies 6,010 rows) |

`forkDesignScale.test.ts` (prototype), loopback provider, single runs on the shared host; the master row is forkcost's run of the same shape at another time, so compare within a row. In the prototype the deep fork's first token is as fast as the shallow one's. What's left in it doesn't depend on the fork: `AssembleContext` (2.25 s) and the live-rewrite read `RewriteLive` (2.46 s) run in parallel readers and each spends 1.8 s validating the 99 summaries' 4,950 inputs; `GetSlot` takes 0.24 s, 0.22 s of it in `forkThrough` scanning the chat's 600 forks for those that reach the slot (§7).

Semantics: the fork, path, insertion, event, history-edit, bin, shell and summary test files (24 files, 299 tests) pass on the prototype except four assertions that check the cap's mechanics (lineage at most 64, a fork that restarted with copied rows, event snapshots); with those removed the behaviour in the same tests passes (52/52).

## 6. Alternatives

| Alternative | Make a fork | Lookup | First reply, 63-deep, 5,000 / 600 | Verdict |
|---|---|---|---|---|
| Today: lineage, capped at 64 | ms; O(effective overrides) at the cap (5–6.7 s) | one probe per lineage entry (≤ 64) | 16.3 s reads (measured) | the problem |
| **A.** Materialize every fork's effective view when made (today's cap copy, always) | O(parent's effective overrides): 5–6.7 s for 6,010 rows, measured | one probe | ≈ labels (lineage 1) | fails "O(1) fork"; also 600 × 6,000 extra rows |
| **B.** Materialized views kept incrementally / filled lazily | O(1) | first lookup walks the lineage, then cached | today's cost on the first reply; readers are read-only, so the cache would need writer round trips | fails "first reply near shallow" |
| **C.** Copy-on-write persistent map (B-tree or HAMT of blocks keyed by slot, root pointer per fork, path copying on write) | O(1): copy the root pointer | log₃₂ n node reads plus decoding a block (JSON) per key | estimated ≈ labels or slower: 3–4 row reads and a JSON decode per lookup instead of one probe | same asymptotics as labels; every helper inlined in SQL (about 150 call sites) would decode blocks; a swipe on a shared message copies a block of every level. Labels are this structure (fat nodes over a version order) with SQLite's B-tree doing the path work |
| **D.** Cache effective rows per (fork, chain segment) | O(segments) to share, O(segment overrides) on first divergence | one probe in the cache | ≈ A for a fork that changes anything in a shared segment | segments are shared by slots, not by choices: a fork that re-swipes one early message diverges for the whole segment |
| **E.** Move flags per slot instead of per fork (stars, picker hides, image exclusions) | unchanged | fewer kinds per message (≈ 39 → 30 lookups) | ≈ −25% | a constant factor, and it changes the decided fork independence (§3) |
| **F.** Resolve a read's overrides in one pass per lineage entry (range scans by `(fork_id, slot_depth)` into a CTE), no schema change | unchanged (cap stays, or lineage grows) | O(depth + rows of all ancestors in the window) per operation | ≈ shallow for a chain of empty forks; O(depth × path) when every ancestor chose in the shared history | depends on depth again; rewrites every query that inlines the helpers |

## 7. Build units

1. **Schema and maintenance** (`db/baseline.ts`, `db/forkLabels.ts`, `db/forkState.ts`): `fork_labels`, `fork_steps`, `state_events.fork_label`, `history_changes.label`, the triggers and the pause table; `insertFork` without the cap; drop `fork_event_snapshots`, the history copy and `lineage_json`. BASELINE CHANGED.
2. **Readers**: `effectiveOverrideSql` (and its hide variant), `eventVisibleSql`, `historyChanges.ts`'s two visibility tests, `forks.ts` `shownElsewhere` (its inline lineage query becomes `effectiveOverrideSql` on `f.id`), the three enumerations (§4.4) and `summaryValidity.ts`'s descendant scan.
3. **Reader cache** to 256 MB (`connection.ts`).
4. **Tests**: a property test that runs random fork trees (ties, chains of 300, fan-outs of 300, writes and in-place updates at every step, deletes, restores, insertions, events) and compares every lookup and visibility with the lineage rule kept as an oracle in test code; the four cap tests become deep-chain tests without a cap; `pathScale.test.ts` rows-visited checks at depths 1 and 200 equal; `forkCostScale.test.ts` expects no copy at any depth and a deep fork's first-reply reads within 1.5× of a shallow one's; the fixture worker pauses the triggers and rebuilds.
5. **ARCHITECTURE** §3.7–§3.8 ("Per-fork selection", fork-scoped events, display paths' insertion lookup), §16 notes and the forkcost paragraph; this spec and FORK-INDEPENDENCE-DELTA §2.2's lineage paragraph marked obsolete where built.

Size: the prototype is about 200 lines (units 1 and 2's hot paths); with the enumerations, the tests and the documentation, one job.

Not covered here, and still growing with history or fork count (forkcost, and §5.1): `forkThrough` (a read at a slot without a fork, as `GetSlot` in the reply path) scans every fork of the chat that reaches the slot, 0.22 s at 600 forks, where the caller could name its fork; the validator re-checking every summary's inputs three times per plan and again in each assembly, the live rewrite's included (§2.2: 297 runs for 99 summaries; a validity cache per fork and summary would remove most of what's left of the first reply), and the shell summary of a new fork reading its path (9.2 min cold for 600 forks; a fork made at its parent's tip could start from the parent's summary). Both are independent of this design.

## 8. Parallel work

- **chatmerge** writes the join message through `writeInsert` and reads with `shownIn` and `slotDeletedIn`: their signatures don't change, and the insertion's steps come from the trigger. Both add tables at the end of `baseline.ts` (keep both). If a merge later makes forks, it gets them at constant cost.
- **phase4** records `fork_id` on rollouts and adds rollout columns and `rollout_receipts` to `baseline.ts`; it doesn't read overrides directly. Agent tools that read the history go through the assembler and get the faster lookups.
- **Phase 7 thread merges** (`slot_parents`) are structural and independent of fork state.
- **forkcost**'s benchmark and its ARCHITECTURE paragraph change with unit 4–5.
