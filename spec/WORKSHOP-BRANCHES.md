# Workshop branches: a side workshop as a parallel thread of its story branch

**Status**: §0–§8 and §10 M1–M6 **obsolete: built** (job `workshopbranch1`, 2026-11-17; ARCHITECTURE §16 "Story position" and "Workshop branches"), with these differences from the text below: the pairing index, the column drop and a backfill went into the numbered migration `0004_workshop_branches` (the baseline was frozen by `0002_files`), not `baseline.ts`; `CreateWorkshop`'s `attachFork` is optional (absent: the story's current branch); the center/pane branch list names each branch's story branch on its row rather than grouping by it. §9 is still **Open** and not built. Originally: Proposed, 2026-11-17 (job `workshopbranchspec`). A delta from master `ddfe16b5` (ARCHITECTURE §3.7, §3.8, §3.11, §16 "Workshop side chat" with the workfix1, review-workfix1, sidechat2 and review-workshop9 records; spec/WORKSHOP.md §4; DESIGN §3.4 "Human note inheritance on fork" and §7.7). It replaces the built rule "each workshop message reads whatever branch the tab beside it shows" (workfix1) and the review-workshop9 rule "forks of a story retain the same attached workshops because attachment is to the chat, not its branch". reference-harness has no counterpart: its rooms have no side conversations, and its forks only truncate and continue (`src/agent/fork.ts`), so nothing there is reused; its LCM (ARCHITECTURE §9b) is reused through the workshop's existing summaries (§6.7). Everything here is **[P]** unless it quotes the owner as **[D]**; §9 is **[O]**. The owner's statements are recorded in DESIGN §7.7.

## 0. Summary

- **[D]** A workshop beside a story is a parallel thread of one story branch. Each workshop branch is paired with exactly one story branch, stored, not inferred from what a tab shows. A message reads its paired branch up to that branch's newest message when it's sent, wherever the workshop is displayed (side panel, its own pane, the center column, another device).
- **[D]** Branching the story branches each attached workshop. The new story branch B gets a new branch of each workshop, paired with B, and they evolve independently. Going back to the original branch A shows A's workshop as it was, whatever was said in B's.
- **[D]** By default B's workshop is the workshop **as it was when the story stood at B's fork point**: it ends at the newest workshop message sent while A's newest message was at or before the fork point. Branching at the newest message therefore copies the whole workshop. **[P]** When a workshop has messages after that point, the existing "Branch from here" note dialog asks for it too: **As it was then** (default) / **As it is now**, with the dialog's set-all switch covering it.
- Storage is one fork row per attached workshop per story branch (no message, version, state or rollout row is copied), one state-event key for the pairing, one version-scoped state-event key for each workshop message's story position, and one partial index. The baseline is still editable, so these go into `baseline.ts` (BASELINE CHANGED, fresh deploy).
- **[O]** What the workshop knows of the story without a tool call (§9) is undecided; the build plan leaves it out.

## 1. What the build does now, and why it changes

ARCHITECTURE §16: `CreateWorkshop { attachTo }` writes a chat-wide `workshop.attached { chat }` in the workshop. Every reply request from the side panel carries `storyAt { chatId, forkId, leafSlotId }`, the branch and newest loaded message the story tab showed (`storyPosition`, `replyExtras.ts`), stored on queued messages (`queued_messages.story_at_json`) and in the run's snapshot; the story tools (`search_story`, `read_story`, `open_story_summary`, `search_story_summaries`, and `read_chat`/`search_chats` on the attached story) read exactly that position and refuse without one. Continuity (review-workfix1) rebuilds a new turn without earlier story reads whenever the position or the story's `StoryReadStamp` changed. All story branches share every attached workshop.

**[D]** Owner, 2026-11-17, on that: "This seems incoherent. How would this work given the workshop can be opened in its own pane, or even as the only chat in the center column? It's no longer in the sidebar, so it can no longer be considered to be coherently connected to any 'currently open chat'". And: "once the workshop is opened in the center-column in any way, there's no way to go from Workshop -> branch or chat it is connected to *at all*". The link back is job `workshoppop1`, built separately; this spec gives it a stored branch to name (§8).

**[D]** The model, owner, 2026-11-17: "My proposal was that it follows the chat it's connected to, as if it was a parallel thread part of it. So, when you branch a chat, you branch its workshop, and the new branch is attached to the new branch. This way they evolve independently. if you go back to the original branch, the workshop is *as it was*, because it never was changed, even if you messaged its branch."

## 2. The pairing

### 2.1 Stored per workshop branch

- New state key **`workshop.paired { fork: ForkId }`** (`@dreamspan/shared/state.ts`), branch-owned (in `branchOwned`, so it is fork-scoped with `slot_id` null), written in a workshop fork. `IdField` gains `{ table: "storyFork" }`, checked by `db/stateRefs.ts`: a live fork of the chat that this workshop's `workshop.attached` names.
- A workshop fork's **paired story branch** is the `workshop.paired` event in force there, i.e. the one with the greatest fork label at or below its point (the existing fork-scoped event rule, `db/forkLabels.ts`). So a branch the workshop makes of itself (Branch from here, sending below an older message, a "several" resume) inherits its parent's pairing and reads the same story branch (§6.5) without writing anything.
- Like `workshop.attached`, only two writers may insert it: `CreateWorkshop` and the story-fork hook (§3). Generic state writes, merges and tool writes get `NotFound`, as `insertStateEvent` does for `workshop.attached` today (`graphWrites.ts`).
- `CreateWorkshop { attachTo, attachFork }`: `attachFork` (required with `attachTo`) is the story branch the workshop is started beside; the workshop's first fork gets `workshop.paired { fork: attachFork }` in the creating transaction. `workshop.attached` stays: it names the story chat for permissions, listing and the chip row.
- Reverse lookup (which workshop branches belong to story branch B): the new partial index `state_events_workshop_paired ON state_events(json_extract(value_json, '$.fork'), chat_id) WHERE key = 'workshop.paired'` finds the workshop forks that wrote a pairing to B; their descendant forks that write no pairing of their own inherit it (`forks_parent`, within the workshop chat; bounded by the workshop's own branch count).

### 2.2 The story position is the server's, not the browser's

- A workshop request's story position is its paired branch's display end (`displayEndOf`, inserted messages included) when the reply starts: when sent, or when a queued message posts. The server resolves it in the run's setup; `ToolContext.storyAt` is filled from it, so the story tools, the "branch / up to message" approval rows and the snapshot's `storyAt` work as now.
- **`storyAt` goes away from the browser.** It is removed from `SendMessage`, `Generate`, `Regenerate`, `ContinueVersion`, `ResumeVersion` and `ResumeFromStep`, from `ReplyExtras`, and `queued_messages.story_at_json` is removed from the baseline. It isn't kept as a consistency check: the owner's rule is the branch's newest message at send time, which a tab showing an older window would only make fail. The refusal "This request wasn't sent from beside the story…" goes away; a workshop opened in its own pane or the center reads its paired branch like the side panel.
- Each workshop message's version records where the story stood: a version-scoped state event **`workshop.story_at { leaf: SlotId }`** in the workshop (`IdField { table: "storySlot" }`: a slot of the attached story), written with the version: the user's message when it's written (send time), each version of the reply with the position its run resolved. A message with none (a greeting, or a message from before the attachment existed) counts as before the story's first message. This is what §3.2's cut reads; one small row per workshop message.
- The reading line under the header ("Reads “Tavern fight”, up to message 41") is computed from the pairing and the story branch's live tip, not from the story tab.

## 3. Branching the story branches its workshops

### 3.1 One hook, every creation path

Every story fork row is made by `insertFork` (`db/forkState.ts`). It gains one step: when the chat has attached workshops (one probe of `state_events_workshop_attached`; none is the common case and costs nothing more), it makes, in the same transaction, a branch of each live attached workshop that has a live branch paired with the parent fork A. For each:

1. **Source**: the workshop's branch paired with A that was chatted in most recently (`last_chatted_at`, then `created_at`), the one the side panel shows beside A by default (§8.1).
2. **Cut**: §3.2, then the user's choice where the dialog asked (§4).
3. **Made**: the same steps `createFork` takes in the workshop chat (`insertFork` at the cut message plus `placeAsShown`), without changing the workshop's `current_fork_id`, then `workshop.paired { fork: B }` written in the new workshop fork.

The story's own rows are unchanged; only rows of the workshop chats are added. `test/workshopSideChat.test.ts`'s byte-for-byte story comparison keeps holding for the story chat's rows.

| Path | Where | Fork point N | Asks? |
| --- | --- | --- | --- |
| Branch from here (`CreateFork`, `message.branch`, `ForkNotesDialog`) | `db/writes.ts` `CreateFork` → `createFork` | `atSlotId` | Yes (§4) |
| Sending or generating below an older message, now or queued (`AppendMessage`/`SendOrQueue` with `branch`) | `graphWrites.ts` `appendMessage`, `chatSetupWrites.ts` | the parent message | No: default |
| A "several" reply resumed off the tip | `rolloutWrites.ts` | the resumed reply's message | No: default |
| Opening a line no fork follows (a restored message's line) | `writes.ts` `SwitchBranch` | the line's parent | No: default |
| Restoring a deleted message whose fork moved on | `bin.ts` restore | the message's parent | No: default |
| Starting threads (`StartThreads`) | `threadWrites.ts` | the thread start | No: default (its own dialog has no note choice either) |
| ST import into an existing chat | `stImportWrites.ts` | none (base null): the workshop is cut to before the story's first message | No: default |

There is no edit-as-branch path (editing writes a new version or an amendment in place) and plain regenerate or swipe adds a version to the same message, so neither makes a fork. Splitting a chat (`split_chat`) marks an existing fork and makes none: pairings are unchanged and a split group's branches keep their workshop branches. Merging another chat or branch here (spec/CHAT-MERGE.md) adds a join message to the destination and makes no fork: the destination's workshops are unchanged and the source's workshops aren't brought along. A new chat (New chat, an ST import into a new chat) has no workshops.

### 3.2 The default cut: the workshop as it was when the story stood at N

**[D]** Owner, 2026-11-17: "We have established that branching from an earlier point by default means that connected data is branched from the state it had at that point - so the workshop would be branched from its own earlier state, in this case. That said, I am not certain this is the correct/expected behaviour in practice."

The cut message M is the newest message on the source workshop branch's display path whose recorded story position (§2.2) is on A's display path at or before N, or has none. B's workshop is the source's path up to M: a conversation is kept as a prefix, so an earlier message with a later position (possible when the story's tip moved back, e.g. after deleting messages) comes along with M. With N the newest message of A, every position qualifies and M is the source's tip: the whole workshop. One set-based query per workshop: the path's `workshop.story_at` leaves against their display positions on A (the positions `GetSlot { onForkOnly }` validates) and N's.

**As it is now**, where chosen (§4), sets M to the source's tip.

Kept messages are as they are now: like a story branch from message N, which shows N's messages with their current versions and edits, the cut removes later workshop messages but doesn't roll back edits or version choices made since on the kept ones.

### 3.3 Eager fork rows, lazy everything else

Recommendation: **one fork row at story-fork time, nothing else**. A lazily made workshop branch (made on first open or send in B) can't be observably identical to an eager one, and recording the workshop's leaf alone isn't enough. A new fork sees its parent's per-fork rows (swipe choices, edits, deletions, hidden flags, settings, notes, `workshop.*` events) by its label point, and the point is fixed only when the fork row is made: `insertFork` places it below the parent's current point and moves the parent's epoch on (`forkLabels.ts`). Made later, B's workshop would see everything A's workshop changed in its kept messages and settings in the meantime. The fork row is that record: `base_slot_id = tip_slot_id = M`, `branched_at` = the workshop's state seq, and its label.

Cost: one `forks` row and one `fork_labels` row per attached workshop per story branch, no copied messages, versions, state events, rollouts or summaries (`insertFork`: "Copies nothing, whatever the history"). With no attached workshop, nothing. A workshop with no messages still gets its row (an empty branch whose settings are frozen at B's creation, as for any fork). At the owner's data shape (hundreds of branches per chat, thousands of messages each), a chat with two workshops gains a few hundred small rows, the same order as the story's own fork rows, and the workshop's fork tree mirrors the story's depth, so labels grow at the same rate. What stays lazy: shell fork summaries (computed on read, as for every fork), LCM work (only when the branch is sent in), and the client, which lists a workshop branch only when asked (§8).

A merged ST import with hundreds of branches makes one workshop fork per branch per workshop in the same batched transaction; the attached-workshop probe is done once per import record, not per fork.

## 4. The choice in "Branch from here"

**[P]** Owner, 2026-11-17: "With author's notes, we explicitly let the user choose. I think we should consider asking for the workshop chat as well, maybe in the same UI (only if there is a workshop chat, and it changed since after the forking point, of course)".

The proposed mechanics use the existing dialog (DESIGN §3.4 "Human note inheritance on fork" [D]; `ForkNotesDialog.tsx`) with a row per attached workshop:

- **Shown only** when the workshop's default cut differs from its source's tip, i.e. it has messages sent after the story stood at N. With no changed note and no such workshop, no dialog appears and the branch is made at once, as today.
- **Row**: the workshop's title, a subtitle "Workshop · 3 messages after this point", and the same Segmented choice: **As it was then** ("The workshop as it was when the story was at this message.") / **As it is now** ("The whole workshop as it is now, including what was said after this message."). Then is the default, matching notes.
- **Expanded**: the workshop messages that would be left out, as a compact list (speaker and first line, newest last, at most 20 with "and 14 more"), not a text diff.
- **Set all**: the top-level then/now switch sets notes and workshops together; its label becomes "Set all" when workshops are present ("Set all notes" otherwise); rows can differ afterwards, with "Mixed choices" as now.
- **API**: `PreviewForkNotes` returns `{ notes, workshops: ForkWorkshop[] }`, `ForkWorkshop { workshop, title, sourceForkId, leftOut: { count, first: [{ speaker, line }] } }`. `ForkNoteSelection` gains `workshops: [{ workshop, choice }]`; its `comparison` digest covers the workshop rows (each source branch and tip), so a workshop message sent while the dialog was open fails the write with `ForkNotesChanged` ("The notes or a workshop changed while this was open. Review them again.") and the dialog reloads.
- **Paths that never ask** (every row of §3.1's table but the first) use the default, As it was then.

## 5. Independence

- Messaging B's workshop writes only in the workshop fork paired with B; A's workshop fork doesn't see it (ordinary fork rules). Going back to A shows A's workshop exactly as it was, and vice versa. Edits, swipes, deletions and settings in one workshop branch stay in it (DESIGN §3.2 [D], owner 2026-11-13, branchundo1).
- Story tools in B's workshop read only B, at B's newest message when sent. They never read A, so talk copied with "As it is now" about A's later messages can't make them read A.
- **[P]** Copied with As it is now, B's workshop may hold talk about A's messages after N. The minimum honest handling is one line at the copy point, in the workshop's context: "The story was branched at message 40. Anything said above about later story messages is about the branch “Original”, not this one." With As it was then there's nothing to note: every kept message was sent while the story stood at or before N, on the history B shares.
- Library changes made from any workshop branch (cards, presets, lorebooks) are library-wide as before; the library isn't branched.
- **[P]** Capability grants (`workshop_grants`) stay per workshop, shared by its branches: they're permissions, not conversation. The Changes panel lists the changes of runs on the shown workshop branch's path.

## 6. The other cases

1. **Several workshops per story**: each attached workshop is handled independently in §3 and gets its own row in §4.
2. **Workshops not beside a story**: unchanged. No `workshop.paired`; they read other chats only through `list`/`search`/`read_chat` with the `chats.read` permission.
3. **A workshop started beside B** (`CreateWorkshop { attachFork: B }`) belongs to B and the branches made from B afterwards. It isn't listed beside A or B's other existing siblings (Question 1).
4. **Deleting a story branch** (`DeleteFork`): the workshop branches whose paired story branch is B (their own sub-branches included) go to the bin with it, in the same bin group, and `RestoreBinItems` brings them back together; purge purges them together. If that would leave a workshop with no live branch, the workshop chat itself joins the group (a chat's last fork can't be binned alone, `CannotDeleteLastFork`). Deleting a workshop branch on its own is allowed and leaves the story alone; B then has no branch of that workshop. **[P]** Deleting the whole story chat bins its attached workshops in the same group too, replacing review-workshop9's independent lifetimes, since a workshop is now part of its story's branches; a workshop whose story was purged keeps today's "The story this workshop is beside isn't available any more."
5. **The workshop's own branching** (Branch from here in the workshop, sending below an older workshop message, a "several" resume): an ordinary fork of the workshop chat, which inherits `workshop.paired`, so it stays paired with the same story branch. No hook runs (a workshop has no attached workshops of its own).
6. **Merges/joins of story branches**: a join message, no fork; nothing changes (§3.1).
7. **Continuity and summaries**: B's workshop shares A's workshop runs and LCM summaries up to M by lineage, like story forks (`lcmFork.ts`). Its first run usually has a new story position, so review-workfix1's rule rebuilds it without carried story reads.

## 7. Storage

All in existing tables:

- `state_events`: keys `workshop.paired` (branch-owned) and `workshop.story_at` (version-scoped), with their `IdField`s and writer guards.
- `forks`: one row per workshop branch, as for any fork.
- DDL: the partial index `state_events_workshop_paired` (§2.1); dropping `queued_messages.story_at_json` (§2.2).

**The baseline is still editable.** `packages/server/src/db/migrations.ts` holds only `0001_baseline`, with the comment "Until the owner declares real use, edit baseline.ts and deploy an empty database", matching ARCHITECTURE §3.7; `0002_files` is planned (spec/FILES-AND-ENVIRONMENT.md §10) but not built. So: edit `baseline.ts` and the recorded schema fixture (`test/fixtures/preSquashSchema.json`), BASELINE CHANGED, fresh deploy, no backfill. If the owner declares real use first, the same changes become an additive migration numbered after `0002_files` (`0003_workshop_branches`): the index, the column left in place (unused), and a backfill of one `workshop.paired` per existing attached workshop's forks, naming the story's `current_fork_id`.

## 8. The client

1. **Beside a story branch**: the Workshop tab lists the attached workshops that have a live branch paired with the branch the story shows (`ListAttachedWorkshops { chatId, forkId }`), and shows the one the URL names (`workshop=`), else the most recently chatted. A story branch switch makes the tab follow: it shows that branch's workshop branch, and an empty list shows **Start a workshop**. `side.fork` stays the side chat's branch in the URL; a value that isn't paired with the shown story branch is dropped for the default.
2. **The link back** (job `workshoppop1`): in its own pane or the center column, the workshop's header shows "About “Ledger” · branch Tavern fight" as a link opening the story at that branch. It names the stored pairing, so it is right on any device.
3. **A branch switcher on the workshop: yes.** The side chat's branch menu already exists (`side.fork`). Beside a story it lists only the workshop's branches paired with the shown story branch (the workshop's own branches), so the panel never shows talk about another branch. In its own pane or the center it lists all the workshop's branches, each labelled with its story branch, grouped by it; switching changes which story branch it reads and what the header link names, and doesn't change the story pane. Hover: "Each branch of this workshop goes with one branch of the story."
4. **Reading line**: "Reads “Tavern fight”, up to message 41", from the pairing and the live story tip.
5. **Branch from here**: §4's rows.

## 9. What the workshop knows of the story without reading (Open)

**[O]** Not decided, and nothing here is in the build plan. Owner, 2026-11-17, as context: "I think the user would expect it to know where the story is, just like the user can see it. We decided not to just dump all context into it… But I also don't want it to have to sort of, eat soup with a fork in order to reconstruct the story as it is. It's also kind of an issue if it has to constantly call tools to get story pieces in because I feel like it'd end up redundantly getting some of the same stuff in turn by turn whenever the story changes and you message it again. Not sure". And on the update-block option below: "The problem is, I don't see how this is anything but 'dumping the entire story (as the RP model sees it) into the agent context' regardless. So I would hold off on this before we make a decision."

The options, each with how it answers the redundancy concern (the same story text fetched again turn after turn). All of them keep the story tools, read only the paired branch (§2.2), quote story text in the `<story_excerpt>` wrapper, and send only as part of the user's own send to the workshop's provider, under **Read this story**.

1. **Tools only (today).** The assistant reads what it decides to. Redundancy: not answered. A carried read is dropped whenever the story moves (review-workfix1's continuity rule), so a question after each story turn tends to re-read the same recent messages. Costs nothing when the talk isn't about the story.
2. **Append-only updates in the workshop's transcript.** A "story so far" block before the first workshop message on a branch (the story's summaries for the older part, the newest messages verbatim, within a budget), then before each later message only the story messages added since, plus short entries for edits, deletions and hidden messages among those already shown; old blocks are summarized by the workshop's own LCM. Redundancy: answered (each story message enters once, and the cache prefix stays stable). The owner's objection applies: over a long workshop it carries the story much as the RP model sees it.
3. **A small "where the story is" header**, always present and rebuilt each turn at the end of the request: the paired branch's name, its message count, the newest message's speaker and first line, and the titles of the story's summaries. Redundancy: partly answered. It's tiny and never quotes more than one line, so re-sending it costs little; the assistant still reads with the tools for anything more, but knows what has changed and where to read. Not the story's content, so the objection mostly doesn't apply.
4. **A short digest the model writes and the workshop keeps**, updated after story turns the workshop hasn't seen (a few hundred tokens: where things stand, who's present, open threads), stored per workshop branch and shown in its context. Redundancy: answered for the gist, at the cost of a background model call per update and a summary that can be wrong; under DESIGN's provider-send consent rule the extra call needs its own opt-in per connection, since it isn't the user's submit.

Whatever is chosen has to follow §4: with As it was then the workshop is cut back with whatever it holds; with As it is now, anything it holds about messages after the fork point is about the original branch (§5's note).

## 10. Build plan

Each milestone has its own tests; the browser ones run at 1440 and 390, light and dark, on synthetic fixtures with the scripted provider.

- **M1 Pairing and server position.** `workshop.paired`, `workshop.story_at`, their `IdField`s and writer guards, the index, `CreateWorkshop { attachFork }`, the server-resolved position, removing `storyAt` from the API and `queued_messages`. Tests: a workshop read from no tab at all (as from the center column) reads its paired branch to its newest message; a story message added after the send isn't read; two workshop branches paired with two story branches each read their own; the generic writers refuse both keys; isolation across users.
- **M2 The hook and the default cut.** `insertFork`'s step for every path in §3.1. Tests mirroring the owner: *branch → independent evolution → go back and it's as it was*: talk in A's workshop, branch the story at message 40 while it's at 60, message B's workshop, then A's workshop shows exactly what it did before the branch, rows compared byte for byte; *branch at the newest message copies the whole workshop*; *branch at 40 leaves out talk sent while the story was past 40*; an edit made to a kept workshop message in A after B was made doesn't appear in B (the label check); one test per creation path in the table; a story with no workshops writes nothing extra; an ST-shaped fixture (hundreds of branches, two workshops) imports with one extra fork row per branch per workshop and no copied messages.
- **M3 The dialog.** `PreviewForkNotes`' workshops, the selection, `ForkNotesChanged`. Tests: no dialog when no note and no workshop changed; a row only for a workshop with later messages; its left-out list; set-all covers workshops; As it is now copies the tip; a workshop message sent while the dialog is open makes it reload.
- **M4 Bin.** Deleting, restoring and purging a story branch with its workshop branches; a workshop whose only branch goes; deleting a workshop branch alone; the story chat's deletion.
- **M5 Client.** The tab following the story branch, `ListAttachedWorkshops { forkId }`, the switcher's two scopes, the reading line, the header link from `workshoppop1`. E2E: open the workshop in the center column, then its header link opens the story at its branch, and a message there still reads its paired branch; switch the story pane's branch and the side panel follows; layout audit on the touched surfaces.
- **M6 Records.** ARCHITECTURE §16 replaces "Story position" and the review-workshop9 sentence on forks; this spec is marked obsolete part by part.

## 11. Question for the owner

1. **Answered.** **[D]** (owner, 2026-11-17, answer "Ok." to the coordinator's recommendation) A workshop appears only beside the story branch it was started on and the branches made from that branch later; existing sibling branches don't list it. Starting to talk on a sibling starts a separate workshop there. (The question was: A workshop started on one branch: should it also appear beside the story's other existing branches (each getting an empty branch of it when first opened there), or only beside the branch it was started on and the branches made from that one later (proposed, following "the new branch is attached to the new branch")?)
