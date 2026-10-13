# LCM: hierarchical summarization

**Status**: Proposed, 2026-10-13. Phase 3 (PLAN.md). Slices 1–7 are implemented in ARCHITECTURE §16; what is not built is listed under its section and in §5. Items are marked as in DESIGN.md: **[D]** the owner stated or confirmed it (with where), **[P]** proposed and not confirmed, **[O]** open. The baseline is reference-harness as described in [the earlier reference notes](the earlier reference notes), cited as "ref §N". This document lists what carries over, then only the differences.

Scope:
- **[D]** LCM is the main feature: chats of unlimited length with a fixed, cache-friendly budget, keeping every message and every intermediate summary (DESIGN §8).
- **[D]** Phase 3 builds the plain chat mode: the model sees only the top-level summaries, with no drill-down and no search of the original text (DESIGN §8, owner 2026-10-12). `expand_summary`, summary search and expansion handles come with agentic rollouts in phase 4.
- It runs on what exists: the assembler (ARCHITECTURE §15), the provider layer (§6), the database workers (§3) and the summary tables already in the schema (§3.7).

---

## 1. What carries over unchanged

| From reference-harness | Ref |
|---|---|
| Lineage: L1 records its ordered inputs (`summary_inputs`), higher levels their ordered children (`summary_parents`); a condensation job stores its explicit child list. | §1 Tables; §1 What a summary covers |
| Completion is atomic: summary, lineage, supersessions and the job's completion in one transaction, rolled back if the job row isn't updated. | §1; §6 |
| Eager L1 generation off the build path. A chunk takes whole messages until about 4,000 tokens (`leaf_input`), with a 600-token target (`leaf_target`). A single message over 1.5× `leaf_input` is clipped for the summarizer with a marker. | §2 Knobs; §3 Prompt assembly |
| L1 is cutoff-addressed (prior summaries as continuity, the chunk as material); L2+ is input-addressed (exactly its children). The rendered inputs are checked against the declared ones before the request. | §3 Prompt assembly |
| Ordinary condensation: fanout 5, target 800; condensed children leave the pool; runs split at failed ranges. | §2 Ordinary fanout condensation |
| Budget absorption and bootstrap, which reduce the original children again rather than a parent's prose. | §2 Budget-driven eager condensation |
| The durable queue: claim by compare-and-set with the attempt counted at claim, `max_retries` 2, a best-effort draft salvaged as `truncated` with a sentence-boundary clip, startup reset of `processing` jobs, a drain that refunds the attempt. | §3 Queue; §6 |
| Use / wait / omit: a build over its maximum escalates the covering job and waits, with one 120 s deadline across waits. A timeout fails the build, not the job. | §4 Live overflow |
| Greedy coverage preferring higher levels; superseded summaries excluded; duplication preferred to losing raw text when lineage is inconsistent. | §4 Coverage selection |
| A running generation keeps the summary selection it started with; a summary landing meanwhile affects only later contexts. | §4 Cache breakpoints |
| Usage per request in the ledger, separate from the estimated `token_count` stored on a summary. | §3 Refusals, bad output and accounting |

Token counts here use the assembler's estimate (four characters a token, three a message), where reference-harness uses gpt-tokenizer (ref §2 Related controls).

---

## 2. Differences

### 2.1 Summaries over path segments in a branching graph

reference-harness keys summaries by timeline (ref §1 What a summary covers) and shares them across views only by copying rows (ref §5 Summary mirroring).
Implemented in [ARCHITECTURE §16](../ARCHITECTURE.md#16-lcm-hierarchical-summaries): shared primary-parent chains, on-path selection, freshness/level/newness preference, continuous root coverage and a cursor independent of the raw budget. Selection uses indexed ending-slot candidates over the path, with shared freshness memoization; no summary copying between branches.
- **[P]** Chunks end at branch points when they can (DATA-MODEL §8.2). A chunk that would cross a slot with two or more live children ends at that slot, unless that leaves it under a quarter of `leaf_input`. The shared segment then gets summaries both branches use.
- **[P]** A branch made later inside a summarized chain doesn't contain that chain. Its path uses the summaries before the fork, and the planner summarizes on from there.
- **[P]** No chain contains a merge slot until threads are built (DESIGN §3.3).
- Why: branches are first-class (DESIGN §3.2). Copying summaries per branch would multiply cost, and the copies would drift apart.

### 2.2 Edits, swipes, deletes and restores under a summary

reference-harness records event ids only. A covered edit or delete leaves its summaries as they were, and they stay current (ref §5; §8 item 7).
Implemented in [ARCHITECTURE §16](../ARCHITECTURE.md#16-lcm-hierarchical-summaries): nullable effective version and amendment pins, child revision pins, recursive derived freshness, and stale fallback only without a fresh candidate at that endpoint. Edits, swipes, deletes, restores and hides change no summary rows.
- Implemented (ARCHITECTURE §16, condensation and stale summaries): re-summarizing writes a new summary row over the same chain with the new inputs; the stale one stays, and a swipe back makes it fresh again with no request. It runs only with the next reply, for summaries the path uses, once per affected summary; a hand-written stale summary is flagged, never replaced.
- Re-summarizing runs at `idle` class (§2.5). "Re-summarize" and Retry are rerun requests (`SetSummaryRerun`) that the next reply's planning answers; no click generates (ARCHITECTURE §16).
- Implemented: a summary whose selected revision the user wrote isn't replaced automatically when it goes stale; it's flagged (`SummaryPlan.flagged`). See question 2.
- **[D]** Deleting a message for good keeps an empty placeholder, so summaries over it stay valid (DESIGN §6.2). **[P]** Those summaries are stale, since the slot has no effective version, and their text may still describe it. The summary panel says so and offers Re-summarize.
- **[P]** A version still generating has no effective version, so the planner doesn't summarize a chain while a covered slot is generating.
- **[P]** Mechanical edits through changesets (DESIGN §10.3) come in phase 5. DATA-MODEL §8.2 proposes updating `summary_inputs` in place; inputs are immutable here, so a changeset will write a new summary row for the new versions with the replaced text instead.
- Why: swipes and edits at any depth are normal (DESIGN §3.1). A summary silently describing a version that's no longer selected contradicts the story the user sees.

### 2.3 Summarizing through the user's preset

reference-harness runs a separate agent session with a summary editor tool and its own tail, and accepts only a draft written through the tool (ref §3 Prompt assembly; §3 Editor and success criterion).
- **[D]** Summarizing through the user's own preset must be supported, and is likely to work very well (DESIGN §8, owner 2026-10-12): the conversation is cut at the point to summarize to; an instruction is appended as a system message where the provider takes one mid-chat, as a user message otherwise; the reply is the summary; it shares the cache prefix with the normal conversation.
- **[P]** A summarization request is the normal assembly as if the chat ended at the chunk's last slot, followed by the **summarization tail**. Same preset, cards, notes, lorebooks and summary layer; history from the cursor to the cut.
  - For L1, the layer is the coverage up to the chunk's start (ref §3: prior summaries are continuity).
  - For a condensation, the layer is cut after its last child, with no history, and the tail names the children ("parts 6 to 10").
- **[P]** It uses ST's `quiet` generation type, as ST's Summarize extension does, so preset prompts trigger as they do there. The prefill, the speaker's tail directive and the one-turn direction are left out.
- **[P]** The tail is the last message. It's a system message where the model's capabilities say mid-chat system messages are taken, otherwise the user's. Today `wire.ts` turns later system messages into the user's for some providers; this adds a capability flag, defaulting per provider kind and overridable per model.
- **[P]** Tail text, in order: a per-chat override in `lcm.settings`, the user's default, a built-in default. The ST importer keeps the Summarize extension's prompt (`extension_settings.memory.prompt`) and offers it as the user's default. The tail says what it's for and asks for at most `target` words, in the story's language and voice. (The owner's preset needed a line acknowledging summary instructions, DESIGN §8 [D]; a tail that names its purpose serves the same end.)
- **[P]** The summarizer resolves its preset and model through the existing scoped bindings (`preset.binding` and `model.binding` with scope `summarizer`, DATA-MODEL §5.3), defaulting to the narrator's. Another model or preset loses the shared cache, and the cost estimate says so.
- **[P]** The reply is the summary, without its reasoning. `max_tokens` is the target × 2.5, reference-harness's overage factor (ref §2 Knobs). A reply cut by length is salvaged as `truncated` (ref §6).
- **What's cached [P].** By construction the request matches the live one through the preset prefix and the summary layer, so with explicit breakpoints (Anthropic) those are cache reads. The chunk is read from cache only by providers with automatic prefix caching, and only up to the first in-chat injection. Summarization requests put no marker on the chunk, since nothing reuses it.
- reference-harness's tool-based summarizer can be offered once rollouts have tools (phase 4). See question 1.
- Why: the owner's ST workflow already works this way (DESIGN §8 [D]); chat-mode models may have no tool support; the cache is shared.

### 2.4 Refusal detection

Implemented in [ARCHITECTURE §16](../ARCHITECTURE.md#16-lcm-hierarchical-summaries) (refusals and failed summaries): hard refusals from provider metadata, soft refusals decided only by a judge model, never a text heuristic; a summary refusal fails the attempt, retries, tries the fallback model, then becomes a failed summary; a chat version's soft refusal marks it and keeps its text.

### 2.5 Idle-time jobs while the cache is warm

reference-harness has no idle class or idle gate for summaries (ref §4 Idle-time work).
- **[D]** LCM work runs in the gap after a reply while the cache is still warm, which also refreshes it, depending on settings and provider (DESIGN §8.1).
- **[P]** When a reply finishes, the planner runs for its chat. Jobs it creates while the cache-warmth estimate (ARCHITECTURE §15) says warm get class `idle`, otherwise `background`. The pool claims `interactive`, then `idle`, then `background`, oldest first.
- **[P]** An idle job reads the prefix and layer the reply just cached, pays only for its chunk, and its read refreshes those cache entries. On Anthropic it refreshes only those, not the reply's history marker.
- **[P]** Per chat, L1 jobs run one at a time in path order: each needs the previous summary as continuity, and reuses the layer its predecessor cached. reference-harness can run one timeline's jobs at once when `worker_count` > 1 (ref §3 Queue). Condensations may run beside L1s. Across chats, a pool of 2 per user by default.
- **[P]** The planner runs on: a message appended; a reply finished; a version selected, added, deleted or restored; a message hidden or shown; a summary completed; LCM settings changed; startup, for chats with LCM on. It's coalesced per chat, 250 ms after the last trigger, like the cache estimate.
- **[P]** A per-user setting turns spending ahead off: LCM jobs then start only when a send would otherwise have to wait.

### 2.6 The window and batched boundary advances

- **[D]** The baseline includes rich, compact and summary tiers with target/max hysteresis, and an eager threshold below the compact maximum (DESIGN §8).
- **[P]** reference-harness's rich and compact tiers render events differently. Here they differ once versions have a context form (DESIGN §10.2): rich sends `content`, compact sends `context_form` when it's set. Until then they coincide, and the verbatim window is one tier.
- **[P]** The window's maximum, `window_max`, is the history budget the assembler already computes: context, less the response, the fixed prompts, the lore allowance and the layer allowance. Defaults:
  - **keep:** the newest 50% of `window_max` is never summarized (reference-harness's rich target);
  - **trigger:** when the window passes keep + 25%, the planner enqueues enough chunks to bring it back to keep, as one **batch**;
  - **runway:** the last 25% is room for a batch to finish before a send has to wait. It must hold at least two chunks. reference-harness only documents this (ref §2 Exact trigger points); here a setting that breaks it is refused.
- **[P]** A batch's summaries become selectable together, when its last job ends. The cursor, and the cache rewrite that comes with moving it, then moves once per batch instead of once per chunk. Over `window_max`, finished summaries are used at once.
- Example: a 32k window keeps 16k, summarizes 8k (two chunks) at a time, and rewrites its cached history about every 8k tokens of story. A 120k window does so about every 30k.
- **[P]** The layer allowance has a target of 15% of the context and a maximum of 25%. Budget absorption engages above the maximum; reference-harness has it off by default (ref §2). With fanout 5 the layer grows with the logarithm of the story's length, about 10k tokens for a 750k-token story, so it rarely engages.
- **[P]** Omit, made concrete: over `window_max` with no job covering the window's oldest part, or after the wait times out, the oldest verbatim messages past the budget are left out through the stepped fallback (ARCHITECTURE §15), and the context reports the range ("Messages 40–52 left out: not summarized yet"). This is the normal state while a backfill runs.
- **[P]** While a send waits, its version shows "Summarizing messages 40–52…". Stop ends the wait, not the job.

### 2.7 Adopting an imported ST summary as L1

- **[D]** Importing a chat imports its summary, and that's required before the owner switches. The summary is kept in its own field. When a run hidden from message 0 has a summary covering it, the summary can act as the L1 over it. LCM is off by default on imported chats, and enabling it is easy and obvious; on enabling, the user chooses between keeping the summary as that L1 and redoing LCM from scratch (DESIGN §8.1, owner 2026-10-12).
- Built (ARCHITECTURE §13): the `imported_summary` note, sent as ST placed it, recording `covers` when it sits at or after the hidden run's end.
- Implemented in [ARCHITECTURE §16](../ARCHITECTURE.md#16-lcm-hierarchical-summaries) (*Enabling and backfill*), as one transaction named `EnableLcm` (the `AdoptImportedSummary` proposed here): the dialog (from the chat settings switch and from the notice a chat with LCM off shows once its context drops messages); adopting writes an L1 over the run with each slot's effective version and a revision of origin `imported` holding the text the shown path has, after showing the run again (a hidden slot has no effective version, §2.2); starting over shows the run too and plans the backfill; the note is never changed and is sent only while the layer is empty, so adopting replaces it at once and starting over loses nothing while the backfill runs; the adopted L1 covers the hidden run only.
- **[P]** If branches saved different summaries inside the run, the adopted text is the shown path's. Other branches share the chain and so the L1. Re-summarize fixes one that differs.
- The panel labels it "Imported from SillyTavern".

### 2.8 Failure placeholders

reference-harness synthesizes a placeholder from a failed job row and never persists it. It omits the range's raw messages at once, treats the failure as terminal, and needs an operator to delete the job row before the range can be retried (ref §6).
- **[D]** Failure placeholders are part of the baseline (DESIGN §8).
- Implemented (ARCHITECTURE §16): a failed L1 is a summary row with status `failed`, its inputs, its error and an empty revision; it is held while its inputs are unchanged, stale after an edit or swipe inside the range, and Retry and Retry with… are rerun requests on it (`SetSummaryRerun`). A failed row never replaces messages that fit.
- **[P]** Not yet built: the assembler rendering the marker ("[Messages 40–52 could not be summarized.]") when the window would pass `window_max`, and the failure on the divider, the rail and the summary panel (slice 7). Today such a range is left out through the stepped fallback with the "not summarized yet" report.
- A failed condensation leaves its children selected, as in reference-harness. It gets a failed row too, so it shows (implemented, slice 5).

### 2.9 How summaries enter the context

Implemented in [ARCHITECTURE §16](../ARCHITECTURE.md#16-lcm-hierarchical-summaries): literal rendering in both modes, placement, stable examples and the layer allowance, breakpoint (b), omitted ranges, cache estimates and assembler semantics version 14. LCM-off assembly retains the unchanged ST differential oracle. Depth-positioned summaries move ahead of verbatim history to preserve §4's partition invariant. Planner waits and budget absorption remain in slices 3 and 5.

### 2.10 RebuildContext and pins

Implemented in [ARCHITECTURE §16](../ARCHITECTURE.md#16-lcm-hierarchical-summaries): selected immutable revisions, freshness/status and cursor pins, replay without reselection, and inspector flags for summaries changed since generation. Summarization rollout snapshots arrive with slice 3.

### 2.11 Backfill and its cost estimate

- **[D]** LCM normally runs in response to user messages, and doesn't have to run at once on large imported chats (DESIGN §8). **[P]** Backfill is lazy (DESIGN §1.4).
- Implemented in [ARCHITECTURE §16](../ARCHITECTURE.md#16-lcm-hierarchical-summaries) (*Enabling and backfill*): a backfill starts only from the enable dialog, after the estimate, and covers the shown path (other branches get theirs when visited); a `jobs` row of kind `lcm-backfill` holds the approved estimate, the cap and its state, so it survives restarts; it waits for the next reply or "Summarize now", then runs through the existing planner in its bounded batches; spending is read from the ledger and stops at 150% of the estimate until the user continues (Continue sets a new limit of 150% of what is left); it can be paused.
- The estimate follows the formula below, which the planner's rules refine: for a path with S tokens before the window, a prefix of P tokens (preset and cards), chunks of C = 4,000:
  - about S / C L1 jobs, plus a quarter as many condensations (S/C × (1/5 + 1/25 + …));
  - each L1 sends P, the layer so far (L, bounded by §2.6), C and the tail, and returns up to 600 tokens (capped at 1,500);
  - with explicit breakpoints and jobs inside the TTL, P and L are cache reads; C and the tail are uncached.
- Worked example: S = 750k tokens (3,000 messages of 250), P = 6k, L averaging 5k. That's 188 L1s and about 46 condensations: about 0.95M uncached input, 2.4M cache reads and 0.15M output. Without caching, about 3.4M uncached input. As a rule of thumb, uncached input is about 1.3× the story and output 0.2×.
- The dialog and the panel show the counts, the cost through the user's cost formulas for the summarizer's model (DESIGN §9 [D]), whether caching applies, and a duration from the model's recent output speed (null without a history). Judge requests are outside the cap.

### 2.12 Settings and plain chat mode

- Implemented: chat-wide initial `lcm.settings`, enabled for new chats and disabled for newly imported chats, with an optional tail (ARCHITECTURE §16). **[P]** Further knob overrides and user defaults arrive with the planner and enable flow.
- **[D]** Plain chat mode has no drill-down and no search (DESIGN §8). **[P]** The layer is always bare in phase 3, like reference-harness's generation layer; reference-harness's live layer adds expansion handles and a note (ref §4 Coverage selection).
- Not carried over: the diary layer, donor mirroring (path sharing replaces it), recency labels, the summary editor tool (phase 4).

### 2.13 UI

Implemented in [ARCHITECTURE §16](../ARCHITECTURE.md#16-lcm-hierarchical-summaries) (Summary UI): the divider, the panel with editing, revisions and re-summarize requests, the rail, the marks, the context view and the chat switch. Not yet built: cost and model per summary and summarization rollouts in the panel. The enable dialog and the backfill section are slice 6.

- **[D]** The UI shows where verbatim context ends and which summaries stand in for older history (DESIGN §8.1). **[P]** The three layers proposed there:
- **Boundary divider [P].** Always shown with LCM on, after the cursor on the path shown: "Older messages: 7 summaries, ~6k tokens", with stale and failed counts and running jobs ("Summarizing 40–52…"). Clicking opens the summary panel. It's read for the path's leaf (`LcmState`) and pushed as a chat event when it changes.
- **Summary panel [P].** The layer in order. Each summary expands to its children, and an L1 to links to its messages. Each shows level, range, tokens, model, cost and state (fresh, stale, failed, edited), with Edit, Re-summarize, Retry with… and its revisions. Summarization rollouts and their cost show here until the activity panel exists (DESIGN §7.4, phase 4).
- **Editing [P].** The editor with server drafts (target `summary_edit`, ARCHITECTURE §3.10). Save writes a revision of origin `user` and selects it; any revision can be selected again. For a summary in the current layer, the cache cost shows before saving.
- **Coverage rail [P].** Optional, per user. A thin rail beside the messages with a bar for each summary covering them, by level outward: hatched when stale, in the failure style when failed, pulsing while a job runs. A click opens the summary. It's read per loaded window (`CoverageForWindow`), so its cost is the window's.
- **Context view [P].** Summaries as sources ("Summary, level 2, messages 40–120, revision 2"), stale marks, omitted ranges as issues, and breakpoint (b) with its reason.
- **Enabling [P].** An imported chat with LCM off shows "Older messages beyond the context aren't summarized" with Enable summaries (§2.7).

---

## 3. Data model

### 3.1 Migration `0023_lcm` — implemented

Moved to [ARCHITECTURE §16](../ARCHITECTURE.md#16-lcm-hierarchical-summaries), with the slice 1 code. The migration, summary writes and derived freshness are built; queue and planner operations below remain proposals.

### 3.2 Operations

**Writer** (`ops.ts`, each one synchronous transaction with no other work inside):
- `EnqueueSummaries`: one batch of jobs. It re-checks each chain by walking parents from its last slot (bounded by the chunk), and relies on the unique index for one live job per chain and level.
- `ClaimSummaryJob`: pending to processing, by class then age, counting the attempt (ref §3 Queue).
- `StartSummaryRollout`: the rollout (kind `summarize` or `condense`, its class) and its frozen snapshot.
- `CompleteSummary`: summary, revision, inputs or lineage with child revisions, supersessions on absorption, the job completed and the rollout finished with its usage. It refuses inputs that aren't the job's chain in order.
- `FailSummaryAttempt`: a retry (pending, the error, the rejected draft) or the end (a failed summary with its error); the rollout finished either way.
- `ReleaseSummaryJob` (drain, attempt refunded), `ResetSummaryJobs` (startup), `EscalateSummaryJob`.
- `EditSummary` (a user revision, selected, committing its draft, with `expectedRowVersion`) and `SelectSummaryRevision`.
- Implemented: `EnableLcm` (§2.7, adopting and the switch in one transaction), `SetBackfill` (§2.11), `SetSummaryRerun` (a request the next reply answers, optionally with a model).

**Readers:**
- The `lcm` stage's sources inside `AssembleContext`, in the same read transaction: summaries ending on the path, their freshness, their batches.
- `AssembleContext` for a job: the summarization request (§2.3).
- `PlanSummaries(chat, leaf)`: the chunks, condensations and re-summaries to enqueue. The writer re-checks what it's given.
- `LcmState(chat, leaf)` for the divider, `CoverageForWindow` for the rail (through the `summary_inputs_slot` and `summary_parents_parent` indexes), `GetSummary`, `SummaryRevisions`, and `EstimateBackfill` with `GetBackfill` (implemented, slice 6).

**Main thread** (Effect services, no SQL): `LcmPlanner` (triggers and coalescing), `Summarizer` (the pool, provider calls, output checks, waits), the output-check registry, and an `Lcm` chat event through `ChatHub`.

Every RPC acts as the caller and reaches summaries through their chat. Each gets a cross-user probe in the isolation matrix.

---

## 4. Invariants and tests

Every change to LCM keeps these, as every change to drafts keeps ARCHITECTURE §3.10's:
1. **On the path.** Every summary in an assembled context, and every summary below it, covers a chain of slots each the primary parent of the next, whose last slot is on the context's path.
2. **Partition.** Every slot on the path, from the root to the slot before the one generated, is in exactly one of: a selected summary's chain, the verbatim history, or a range the context reports as left out. The layer is in path order, and comes before all verbatim history.
3. **Derived freshness.** A summary is fresh exactly when each input's effective version is the one recorded, and, above level 1, each child is fresh and selects the recorded revision. A stale summary is in a context only where no fresh summary ends at the same slot, and the snapshot records it as stale.
4. **Nothing lost.** Summary rows, revisions, inputs and lineage are never changed or deleted, except a summary's selection, its supersession on absorption, and removal with its chat. A swipe back or a restore makes a stale summary fresh again without a write.
5. **No refusal saved.** No revision of origin `generated` holds an output a check failed or suspected.
6. **Rebuild.** RebuildContext of a snapshot with summaries returns the same snapshot after any later summary, edit, staleness or cursor move.
7. **Jobs.** At most one live job per chain and level. A completed summary's inputs are exactly the versions its request rendered. A chat's L1 jobs run one at a time, in path order.
8. **Batches.** A path's cursor moves past a batch's summaries only once the whole batch has ended, or while the window is over its maximum.
9. **Isolation.** Another user's chats, summaries and jobs are `NotFound` through every operation.

**The model test** (`test/protocol/lcm.model.test.ts`), in the style of `drafts.model.test.ts`: the real server, workers and assembler, with a fake provider.
- Built for slices 1–4: fixture summaries encode their inputs, and graph steps check invariants 1–4 and 6; job steps run the real summarizer against a scripted provider and a fake judge, with planted hard and soft refusals (invariants 5 and 7). Slice 5 adds real condensations (fanout of two), edits and hand-written summaries, and a cascade per `maintain` step and at the end, checked at quiescence.
- The fake summarizer's reply encodes its inputs: an L1 lists `depth:version` for each slot it read, a condensation its children and their revisions. So the oracle can decode any summary in any context back into what it covers and from which versions.
- Random steps: append a message or a reply, branch, swipe, edit, select, delete a message, branch or version, restore, purge, hide and show, run some jobs, fail one with a planted refusal, edit a summary, select a revision, re-summarize, retry, change LCM settings, restart the server.
- The oracle is an in-memory model of the graph and its selections, written apart from the SQL, which computes paths, effective versions and freshness.
- After every step it assembles contexts for the active leaf and a random other leaf and checks invariants 1–3 and 8, and checks 4 and 5 over the tables. At the end it runs jobs until none are left, then checks that no context holds a stale summary the user didn't edit, and that no window is over its maximum.
- `LCM_MODEL_SEEDS`, `LCM_MODEL_STEPS` and `LCM_MODEL_SEED` as for the drafts model. A failure shrinks to a short trace. `npm run check` runs 4 seeds of 150 steps.
- Before it's trusted, it must catch planted defects: freshness that ignores deleted or hidden slots, a summary used off its path, stale preferred to fresh, a batch selected early, a refusal saved, inputs recorded from the wrong version.

Other tests:
- a summarization request equals the live request through the layer, compared message by message at a mock provider;
- RebuildContext after summaries change (invariant 6);
- the ST gate unchanged with LCM off;
- the output checks against a labelled synthetic set of refusals, roleplay continuations, copies and good summaries;
- the isolation matrix;
- the performance harness's 100k-message fixture with summaries, within the existing budgets.

---

## 5. Slices

Each slice moves its part of this document into ARCHITECTURE.md in the same commit. The last marks this document obsolete. All seven slices are built, but the document stays current for what is not: the Summarize prompt kept on import (§2.3), and the items §2.8 and §2.13 list as not built.

| # | Slice | Test oracle | Tier |
|---|---|---|---|
| 1 ✓ | Migration 0023, its triggers, the summary writes (`CompleteSummary`, `EditSummary`, `SelectSummaryRevision`) and derived freshness | A schema test per trigger; freshness against hand-built graphs; isolation probes | A |
| 2 ✓ | The `lcm` stage, the layer in both modes, breakpoint (b), pins, assembler version 11, summary sources in the inspector and the cache estimate | The model test over graph steps with summaries written by fixtures (invariants 1–4, 6); the ST gate unchanged with LCM off | B |
| 3 ✓ | Planner, queue operations, `Summarizer`, summarization requests, use / wait / omit, batches, idle class | The model test with jobs (7, 8); the prefix comparison at a mock provider | A |
| 4 ✓ | Hard refusals and the judge model for soft refusals, retries, failed summaries, Retry with…, marks on chat versions | A fake judge; the model test with planted refusals (5) | B |
| 5 ✓ | Condensation, absorption, re-summarizing stale summaries | The model test with condensation and edits, run to quiescence | B |
| 6 ✓ | Enabling LCM, adopting imported summaries, backfill with its estimate and spend cap. **Not built:** the ST Summarize prompt kept on import (§2.3) | A synthetic ST folder adopted and backfilled; the estimate within 25% of the ledger at a fake provider | A |
| 7 ✓ | UI: divider, summary panel, editing with drafts and revisions, coverage rail, context view | Browser flows at phone and desktop width; the performance harness with summaries | B |

---

## 6. Questions for the owner

Only questions whose answer changes what gets built.

1. **Which summarizer is the default?** Through your preset with a tail prompt (§2.3), or reference-harness's tool-based summarizer with its own prompt? DESIGN §8 says both "may be the default". *Recommendation:* the preset path, the only one built in phase 3. It shares the cache, needs no tools and is your ST workflow. The tool-based one becomes an option with phase 4's rollouts.
2. **A summary you edited goes stale. Replace it automatically, or keep your text and flag it?** *Recommendation:* keep it and flag it, with Re-summarize one click away. Replacing it would take your edit out of the context without asking.
3. **A summary fails. Placeholder at once, or keep the raw messages until the window overflows?** reference-harness drops the raw messages at once. *Recommendation:* keep them verbatim while they fit, and show the failure with Retry and Retry with… The placeholder replaces them only when the window would overflow. You have time to retry with another model before anything is lost from the context.
4. **Is LCM on by default for new chats?** It's off for imported ones (DESIGN §8.1 [D]); new chats aren't decided. *Recommendation:* on. A new chat costs nothing until it outgrows its window.
5. **Older images (DESIGN §10.2a [O], "decided with phase 3").** *Recommendation:* summarize them as text. Images in the window are sent; images in a summarized range are sent to the summarizer with their chunk when its model has vision, so the summary describes them, and they leave the context with the rest of the range. Nothing else needs building.
