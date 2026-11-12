# Merging another chat into this one

**Status**: Obsolete: implemented 2026-11-05 (chatmerge); ARCHITECTURE §12 "Merging another chat into this one" documents what was built, and §10 below lists what wasn't. Kept as the design record. Originally Proposed, 2026-11-05 (chatmerge). The owner's decisions are in DESIGN §3.3 (**[D]**, 2026-11-05); everything below is **[P]** unless it cites one. It is a delta from master 12cf25b (ARCHITECTURE §3.7, §3.8 "Display paths", §3.11, §12, §15, §16; spec/MESSAGE-INSERT.md). reference-harness has no counterpart: its rooms never merge, and its forks only truncate and continue (`src/agent/fork.ts`), so nothing there is reused.

## 0. Summary

- A merge is a **join message** J in the destination fork, placed below a chosen message M of the destination (default the newest). It's an ordinary slot: appended when M is the fork's tip, otherwise inserted below M (spec/MESSAGE-INSERT.md). Delete, restore, branch from it, hide it like any message; a fork made before M never shows it, because it is J that carries the merge (DESIGN §3.3 [D]: the destination is THE conversation, the source is only read).
- J's one version (origin `merge`) holds what the model reads of the source: the source's post-base part, its older part from the source's own summaries and its recent part verbatim, as a transcript (§3). A `chat_merges` row records the second parent: the source chat and fork, the source tip it was pinned at, the merge base, the destination's parallel-span start, the title, framing line and counts. `chat_merge_messages` keeps a frozen copy of every merged source message for the timeline's read-only view.
- The second parent is not a `slot_parents` row: those are Phase 7's in-chat thread merges, and LCM refuses to summarize across them (`summaries_chain`, `summary_inputs_chain`). Recorded in its own table, the destination stays a plain chain, so its LCM summarizes the join like any history, and a source in another chat needs no cross-chat graph edge. Every reference out to the source is soft (`ON DELETE SET NULL` or plain text): deleting or purging the source never blocks, breaks or changes the destination.
- The source keeps going on its own. Merging it again brings only what's new since the last merge of that source fork on the destination's path: that merge's pinned source tip is the new base.
- How J reaches the model is a registered, replaceable **merge layout** (§4): `parallel` (default) places the source's section before the destination's own span that ran in parallel and a short join marker at J; `join` places the whole section at J. Chosen per chat, in the chat's settings. The texts are preset utility prompts with editable defaults.
- LCM: a destination summary whose chunk holds a join is asked for one section per line, the destination first (§5, the owner's multi-room addition). The source's own summaries supply its older part (§3).
- Cast: after J, the destination's cast is the union of both casts at the merge point (DESIGN §3.3 [D]). The source's chat notes are listed and copied only when ticked.

## 1. Words

- **Destination**: the fork the user is in and merges into. Its preset, model, cards and settings apply wherever both chats are involved (DESIGN §3.3 [D]).
- **Source**: another chat's fork, or another branch of this chat (split groups included: they are forks of one physical chat).
- **Base**: the last message both display paths share, for two forks of one physical chat; none for different chats. With an earlier merge of the same source fork on the destination's path up to M, whose pinned source tip is still on the source's display path, the later of the two.
- **Post-base part**: the source's display path after the base, to its display end, without messages deleted or hidden there, failed or empty versions, and earlier join messages of its own (a merged chat's own merges are not merged again; listed as a limit).
- **Parallel span**: the destination's messages that ran alongside the post-base part: from the first destination message after the base through M. For different chats the user picks where it starts; the default is M itself, so the section sits right before M and the join.

## 2. Data

```
chat_merges (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  slot_id TEXT NOT NULL UNIQUE REFERENCES slots(id) ON DELETE CASCADE,   -- J
  fork_id TEXT REFERENCES forks(id) ON DELETE SET NULL,                  -- where it was made
  source_chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
  source_fork_id TEXT REFERENCES forks(id) ON DELETE SET NULL,
  source_tip_slot_id TEXT REFERENCES slots(id) ON DELETE SET NULL,       -- pinned tip (display end)
  base_slot_id TEXT REFERENCES slots(id) ON DELETE SET NULL,             -- same physical chat only
  start_slot_id TEXT REFERENCES slots(id) ON DELETE SET NULL,            -- parallel span start; null: directly before J
  title TEXT NOT NULL, framing TEXT,                                     -- framing null: the preset's
  cast_json TEXT NOT NULL,          -- [{entity, name, from: "both"|"destination"|"source"}]
  counts_json TEXT NOT NULL,        -- {messages, verbatim, summarized, summaries, leftOut, tokens}
  created_at INTEGER NOT NULL
)
chat_merge_messages (merge_id, ordinal, source_slot_id TEXT, speaker_entity_id TEXT, speaker_name,
  side, content, sent_at, PRIMARY KEY (merge_id, ordinal)) WITHOUT ROWID
```

Triggers keep a merge in its destination chat (J's chat), frozen after insert. The source ids are deliberately not "in the same chat": that is what a merge is. `versions.origin` gains `merge`. Baseline only (SCHEMA RULE); a fresh database.

The join version: writer `human` (it's the user's act), speaker none, macro mode verbatim, `cast_json` the union, content the transcript of §3 (what the model reads; so history reads, token counts, LCM planning and search treat it as one message of that size, without new paths). A history edit (search and replace) that changes J's text changes what the model reads, not the frozen copy the timeline shows.

## 3. What comes in, and its size

Computed by one function the preview (reader) and the write (writer, again in its transaction) share, so the write merges exactly what was previewed or refuses as stale (`MergeChanged`, with the new preview):

1. Read the post-base part through the source fork's display path (`pathPieces`, `displaySlots`: one range per structural stretch).
2. Budget: the destination's parallel span in tokens, at least 4,000 (a short span still lets something through), at most 50,000. So the merged line weighs about as much as our own line beside it, never more (the owner's concern: "our continuation might take more from the merged chat than our own").
3. Newest first, source messages go in verbatim while they fit the budget.
4. The older remainder comes from the source fork's selected summary layer at its tip: summaries entirely after the base, oldest first, as `<summary>` blocks.
5. What neither covers is **left out**, with its count and tokens. The dialog says so and offers **Summarize these in the source first**, which opens the source's Summaries tab, where its backfill shows its estimate and runs only when the user approves it (provider-send consent). Or the user ticks **Include them as written** (the budget then doesn't hold, and the dialog says by how much).

The transcript is plain text: summary blocks, then one paragraph per message, `Name: text`, names as the cards' current names (the user's persona by its name). The framing heading and the join marker are not in it: the layout adds them (§4).

## 4. Layouts (registered: `Assembler.mergeLayouts`)

An assembler stage `merge-layout`, after `roles` and before `note-gate`, in its own file (`assembler/merges.ts`; the note-overrides and phase4 jobs change other stages). For each history entry that is a join (the history read carries its `chat_merges` row as `HistoryEntry.merge`, pinned with the entry, so rebuilds replay it), it calls the layout the chat names (state key `merge.layout`, an open id resolved at use; unknown: `parallel`, with a `merge_layout_missing` issue). A plugin registers, overrides or disables layouts like projections.

- **`parallel`** (default, "Parallel span"): the section (heading + J's text) is sent right before the first history entry at or after the span start (when the start isn't in the history read, before the first entry: it was summarized or cut), and J's place gets the join marker. Both are system messages without a name, like summaries.
- **`join`** ("Block at the join"): heading + text + marker at J (the first proposal, kept selectable).

Templates are preset utility prompts, optional keys with defaults, edited in the preset editor beside the other utility prompts: `merge_section_prompt` (default `Meanwhile, in parallel with what follows: {{title}}, with {{cast}}.`), `merge_join_prompt` (default `[Here “{{title}}” joins this chat.]`). A merge's own framing line, edited in the dialog, replaces the section prompt for that merge. `{{title}}` and `{{cast}}` are the merge's; nothing else in them expands. Lorebooks scan the section like history (it's a history message to lore scanning). Causal order holds by construction: a message before J is assembled from the path before it, which has no J, so it never sees the source (DESIGN §3.1 [D]).

With per-character agents (Phase 4), only agents whose character was in the source's cast see the section (presence): the `merge-layout` stage gets the viewing agent's card and drops the section for others. Not built: there are no per-character agents yet.

## 5. LCM

- J is a message of the destination's chain: planning counts its tokens, a chunk can hold it, and the summary request renders it through the same layout stage. So once the destination's LCM summarizes the span, its summary covers both lines like any history (owner: "Once the destination's LCM summarizes that span…").
- **Unified blocks** (owner's multi-room addition, 2026-11-05; coordinator's mapping): the alignment unit is the whole parallel span; there is no finer order inside it to get wrong. A summary whose request holds a join is asked for one section per line, this chat's first, then the merged one under its title (registered summary transform `merge-sections`, after `summary-request`; replaceable). The source's side is built from its own existing leaf summaries (§3 step 4), the destination's from its own messages; condensations cascade upward over these blocks like any tier.
- Merging below a message already covered by a summary makes that summary stale in the fork (MESSAGE-INSERT §3.4), and the next reply's pass writes it again over the join: the dialog shows this as "The summary of #a–#b will be written again with the next reply (≈N tokens)", which is the destination's existing LCM setting at work, not a new send.
- Not built, noted: finer alignment inside a span by the messages' wall-clock times.

## 6. Cast and state

- **Separate timelines option** (owner, 2026-11-08, DESIGN "Merging another chat into this one" [D]): "the chat merge should be possible with the other way where the timelines remain separate for the characters from chat A and chat B." Besides the built layout (one shared transcript of the source), a merge can leave each character with the history of the chat it came from, as separate contexts by origin (CHARACTER-CONTEXT §2.1, §2.2). Not designed here yet.
- After J, the destination's cast is the union of both casts at the merge point: `participant.join` events at J for source members the destination lacks, in one transaction. J's version pins the union, so the merged-in characters count as having taken part (DESIGN §3.5 [D]: their messages are in this chat now).
- The source's chat notes, switched on at its tip, are listed in the dialog with a tick each, off by default; a ticked one is copied into the destination as a new chat note, switched on from J. Card notes need nothing: they belong to the cards, which are now in the cast. Other source state (preset, model, lorebooks, variables) is never adopted: the destination's settings apply (DESIGN §3.3 [D]).

## 7. UI

- **Entry points**: the chat's ⋯ menu, "Merge another chat…" ("Brings another chat's messages into this one, after the newest message."), and a message action in the `place` group, "Merge a chat here…" ("Brings another chat's messages into this one, after this message."). Both open one dialog.
- **Dialog** ("Merge a chat into this one"): a searchable list of chats with their branches, newest first (this chat's other branches included, this branch excluded); then, for the chosen source: what comes in ("Shares #1–86 · merges 54 messages from #87", or "Merges 120 messages", and the verbatim/summarized/left-out split with tokens); the position ("After #140", a select of the destination's messages, default the newest); for chats that share nothing, the parallel span's start (a select, default the position); the title and framing line, prefilled; the cast union (faces with a "+" on those the destination gains); the source notes to copy; a preview of exactly what the model receives, as the layout sends it; **Merge** and Cancel. Every control has its hover/focus explanation; fields keep their "?" help.
- **Timeline**: J renders as one collapsible row, "Merged “<title>” · N messages", a link to the source ("Open “<title>”"), expanding to the frozen messages, read-only, paged. It takes no message number of its own in the list: numbering skips joins. Its message actions are the usual ones that make sense (delete, hide, branch, copy link).
- **Chat settings** (This chat tab): "Merged chats" layout select, shown when the fork's path has a merge.
- **Context inspector**: the section shows where it is sent, as J's message with its heading piece, and the marker as its own piece.

## 8. API and commands

`PreviewChatMerge`, `MergeChat`, `MergeMessages` (`@rp/shared/mergeApi.ts`, merged into AppApi). `MergeChat` dispatches through the registered command `chat.merge`, so a plugin or the in-app agent merges the same way. The writer's `MergeChat` is one transaction: recompute and compare the preview's digest, write J (append or insert), its version, the `chat_merges` and message rows, the join events, the copied notes; chat in the fork. The API publishes J as the fork's `Slot` (with its position), the chat, the cast and `Lcm`.

## 9. Scale

Owner-shaped data (hundreds of branches, thousands of messages, 20–50 swipes): the preview reads the source's post-base path once by display pieces (its window, not the chat), the destination's span by the same read, and the source layer once. A merge writes one slot, one version and one row per merged message. Re-merges read only after the new base. Tests measure a merge of a 3,000-message source branch from a chat with 200 branches.

## 10. Limits

- A source's own joins are not merged again (the transcript notes "[n earlier merges not included]").
- Per-character agents' presence filter: Phase 4.
- Interleaving by time: rejected by the owner; finer alignment inside a span by time: noted, not built.
- Not built in this round: copying the source's chat notes (§6; the dialog lists none), and numbering that skips joins (§7): J takes a display position like any message, so after a merge in the middle of the history the later messages number one higher. The default, merging after the newest message, renumbers nothing.
