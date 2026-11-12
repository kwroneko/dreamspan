# Parallel threads in one chat

**Status**: Proposed, 2026-11-12 (job `threads`, design only, no code). Everything here is **[P]** unless it cites a **[D]** or is marked **Open**. Question 1 (§16.2) is **Decided** (owner, 2026-11-12): (a). **Built so far** (job `threads1`): TH1, the stored shape (ARCHITECTURE §3.8 "Parallel threads, stored shape"); this spec stays the record for TH2 on. Deltas from §4 as built: a split's label is F's point read before its threads' forks are made (so they sort inside it), and a split always has F as its continuing member (ordinal 0); the played-stretch correction of §5.2 step 5 is stored as `presence_away` overrides of F, one per message and moved card (key `<slot id>:<card id>`), so it needs no table; a split shows only while two of its threads still have a live fork; `ListForks` carries each fork's shown places (`Fork.threads`) and `ThreadsOf` a fork's sets. It is a delta from master `21c7fb3d` (ARCHITECTURE §3.7, §3.8 "Forks", "Fork labels", "Display paths", §3.11, §12 "Merging another chat into this one", "The branch control", §15, §16), from spec/CHAT-MERGE.md (built), from spec/CHARACTER-CONTEXT.md and its §9 build plan for separate contexts (job `contexts`, commit `d0a9b218`, being built now: units C1–C9 are cited by number), from spec/MESSAGE-INSERT.md (built), spec/LCM.md, spec/AGENTIC.md, the removed lane scaffolding (commits `18b52d59`, `38a3286f`) and reference-harness `latest` (`9b385944`). The owner's decisions are in DESIGN §3.3, §7.1 and "Merging another chat into this one". No chat logs or card definitions were read.

## 0. Summary

- **A thread is a fork.** Starting threads at a message S makes, in one transaction, one new fork per extra thread at S beside the branch the user is in, which continues as the first thread, at the newest message and at an earlier one alike: started at an earlier message, the messages already played after it are that first thread's, and the characters who go to the other threads count as not present for them in this branch only (§5.2; **[D]** owner, 2026-11-12, §16.2). Everything a fork already has (its own path, URL, composer, selections, notes, state, summaries, generations, bin) is the thread's. What is new is a small record saying which forks run *alongside* each other from S, so the UI can show them as threads, never as alternate branches (DESIGN §3.3 [D]).
- **Before they join, threads never see each other.** Each thread's requests are assembled from its own path: the shared history up to S, then its own messages. That is causal order with no notion of time (DESIGN §3.1 [D], §3.3 [D] 2026-11-08), and it holds in every Context setting.
- **Who is in which thread** is presence: at S, each thread marks the characters of the other threads away (CHARACTER-CONTEXT C1's `away.set`, fork-scoped). Each message then records who knew it (C1's `presence_json`), which is all separate contexts and separate-timeline joins need.
- **Sending to several threads** appends one copy of the message to each chosen thread, each with its own speaker, linked by a group id (DESIGN §3.3 [P]). Each copy gets its thread's own reply; they generate at the same time.
- **Joining is the built chat merge** with another thread of this chat as the source (CHAT-MERGE): a join message J in the destination thread, the source pinned at its tip, the base at S. Its frozen copy of the source's messages gains who knew each one (C1's `knowers_json`), and the join records which of two views it uses (DESIGN "Merging another chat into this one" [D] 2026-11-08): **together** (the built behaviour: every reply reads both lines, the other one as a labelled section) or **separate timelines** (each character reads only the line it was in; a narrator reads both). The default follows the chat's Context setting.
- **A joined history is ordered by line, never interleaved**: the shared past, then the joined thread's line as one block, then the destination's own line, then J and what follows (CHAT-MERGE's parallel span; the alignment unit is the whole span). A character whose only line is the joined one reads it as its own plain history, so its cached prefix carries over.
- **Summaries** before S are shared by every thread; each thread summarizes its own line; after the join, a destination summary over J has one section per line (built `merge-sections`). With separate timelines each view keeps its own summaries from S on (C7), reusing the summaries its thread already wrote.
- **UI**, all on existing surfaces: a message action and a ⋯ command to start threads, a Threads section and a thread label in the header's branch control, a row in the timeline where the threads part, a "To 2 threads" chip in the composer's strip, the merge dialog in a thread mode for joining, the built "Joined …" row.
- **Stored data**: two small tables for the record of threads, one for send groups, and five columns on built tables (plus C1's `knowers_json`). Every Later feature listed in §4.4 fits this shape without a migration.

## 1. Words

- **Thread**: one of several lines of a chat that run at the same time from a message. In the UI, "thread". An alternate continuation stays a "branch".
- **Split point S**: the message the threads continue from. All of them share the history up to and including S. ("Split" already names a branch's start and "Split off" makes a branch its own chat in the UI, so the UI never calls this a split: it's "Start parallel threads".)
- **Thread set**: the threads started at one S together. A thread can start a set of its own later (nested threads).
- **Member fork**: the fork that starts a thread. Its alternates (branches made inside the thread later) belong to the same thread.
- **Join J**: a merge message (CHAT-MERGE) whose source is another thread. **Destination** and **source** as in CHAT-MERGE §1: the destination is the thread the user joins into, which continues as THE conversation (DESIGN §3.3 [D] 2026-11-05).
- **Line**: the messages one thread has after S. **Knowers** of a message: the characters present when it was written (CHARACTER-CONTEXT §2.1 [D]; C1).
- **View**: what one speaker's request is built from: the whole path (one shared context, or a narrator) or what that character knew (separate contexts, or a separate-timeline join).

## 2. What the owner's discussion already settles

The design takes these as given and doesn't re-ask them:
- Threads that fork and merge, sending one message to several threads with the same or different speakers, any card as a speaker (DESIGN §3.3 [D]). Threads and alternate branches look different (§3.3 [D]).
- No interleaving by time: "Messages do not have a real 'time' to them" (§3.3 [D] 2026-11-08). A generated message sees only what precedes it (§3.1 [D] 2026-10-30).
- A merge is made from the destination, which is THE conversation; the source is only read; the destination's settings apply (§3.3 [D] 2026-11-05). Merge position: any message, default the newest (§3.3 [D]). Cast after it: the union (§3.3 [D]).
- A merge may keep timelines separate: characters from A keep A's history, from B keep B's; "arguably the most straightforward timeline merge" (§3.3 [D] 2026-11-08).
- Knowers are the characters present when a message was generated; "If there are different branches of conversation, however, logically different characters may be part of them. A merged in chat only had those characters present" (§7.1 [D] 2026-11-06).
- The default is one shared context with every character at once (§7.1 [D] 2026-11-06). Separate contexts summarize parallel by default, shared up to the common prefix (§7.1 [D] 2026-11-06). Gap lines only within a character's own storyline; nothing said about a storyline it was never in; an optional join line (§7.1 [D] 2026-11-06, "Ok").
- A narrator is a character that sees everything and has no presence value (§7.1 [D] 2026-11-06). How it shows storylines that diverged and converged is **Open**; the working default is labelled sections per storyline, "the way a chat merge shows two chats" (§7.1 [P] 2026-11-08, owner: "Okay, although … not really solved or fully settled yet").
- Changes never spread to other forks on their own: "You explicitly merge git branches, you don't push to master and then see every branch change on its own. We don't want that anywhere" (§4 [D] 2026-11-01). Fork independence (FORK-INDEPENDENCE-DELTA, built).
- The multi-chatroom idea: a summary layer carrying all rooms together with a section per room, recent context grouped by room (§3.3 [D] 2026-11-05).

## 3. Deltas

### 3.1 From the removed groundwork

The first data model (`18b52d59`, DATA-MODEL §4.2–§4.4) had `lanes` (a thread per lane), `slots.lane_id`, multi-parent merge slots in `slot_parents`, `slots.placement_group_id` for a message sent to several threads, and `chats.current_leaf_slot_id`. None of it was ever used: every slot sat in the chat's one lane. Schemaclean (`38a3286f`, 2026-11-06, owner: "remove the leftovers of the never-built 'parallel threads in one chat' design"; "removed, not decided against") took it out. What this design does instead, and why:

| Removed | Instead | Why |
|---|---|---|
| `lanes`, `slots.lane_id`: thread identity on every slot | Thread identity on forks (`thread_members`, §4.1) | Since lanes were drafted, forks became the unit of "a line": per-fork selections, deletions, notes, events, summaries, composer and URL (FORK-INDEPENDENCE-DELTA, FORK-COST). A thread needs every one of those, so it is a fork. A slot column would add a write and a read to the hottest table for something forks already answer |
| `slot_parents`: a join as a slot with two parents | A join as the built single-parent J with its second parent in `chat_merges` | LCM refused to summarize across multi-parent slots (`summaries_chain`, `summary_inputs_chain`); CHAT-MERGE showed the soft second parent keeps the destination a plain chain, so its summaries, numbering and search treat J as one message |
| `slots.placement_group_id` | `thread_sends` (§4.1) | A separate small table keeps the slot row as it is and is read only by the edit and delete prompts |
| `chats.current_leaf_slot_id` | `forks.tip_slot_id`, built | Each thread has its own tip as any fork does |

### 3.2 From the build

| Built | Delta |
|---|---|
| Forks (ARCHITECTURE §3.8): a fork made at a message, nested-interval labels, per-fork everything | Unchanged. `StartThreads` makes member forks with the existing `insertFork` and `CreateFork`'s display-path rules (`hiddenAtFork`) |
| `chat_merges`, `chat_merge_messages` (§12), `MergeChat`, `mergePlan`, the `merge-layout` stage, `merge-sections` | A thread is a valid source (it already is: "another branch of this chat"). Adds `chat_merges.timelines` and `chat_merges.split_id`, `chat_merge_messages.source_version_id` and `media_json` (§4.1); the join also clears the away marks of the joined thread's characters at J |
| `queued_messages` (§12, the send queue) | Adds `send_group`, so a copy that has to queue keeps its group when it posts |
| `ListForks`, shell fork summaries (§3.8, §12) | Each fork carries its thread (split id and ordinal), computed with the fork summary and stored with it (format bump) |
| Message actions, chat commands, composer controls, timeline transforms, the branch control, the merge dialog (§5, §12) | New registrations (§13); the branch control gets two extension points |
| Assembly (§15) | Nothing new before a join. At a join, the per-viewer rendering of §7.3, on top of C3/C6 |

### 3.3 From CHAT-MERGE

A joined thread and a merged chat are one mechanism: the same J, rows, plan, preview, layouts, summary sections, timeline row and command (`chat.merge`). The thread case differs only in what is already true of it: the source is in the same chat, the base is S, every source character is already in the cast, and its characters come back from away at J. Two things are added for both cases: the separate-timeline view (decided 2026-11-08, "not designed yet" in CHAT-MERGE §6) and per-message knowers. CHAT-MERGE's limits carry over (a source's own joins are not merged again; numbering after a mid-history join).

### 3.4 From CHARACTER-CONTEXT and its build plan (job `contexts`)

Reused as built by C1–C9, not a second mechanism:
- **Presence**: a thread is a set of characters present; everyone else is away in it (`away.set`, C1), so Auto and Who replies next skip them (C8) and each version records them in `presence_json` (C2). A narrator (`cast.role`, C1) is in every thread and never away.
- **Knowers on merged rows**: `chat_merge_messages.knowers_json` (C1), written by the merge (C2).
- **Views**: separate contexts filter history by knowers (C3), gap lines (C4), tools (C5), merged sections per viewer (C6), summaries per view (C7).

Deltas on that plan:
- **Own-line rendering at a join** (on C6): a viewer that knew messages only on the source side of the parallel stretch gets them as its plain history, one message per row in its normal role and name, in place of the destination's span, with no section heading. C6 as planned renders them as a section headed "Meanwhile, in parallel with what follows", which is wrong for a character whose own past it is (what follows is hidden from it), and changes its cached prefix.
- **A separate-timeline join in a shared-context chat**: the join's `timelines = separate` applies C3's knowers filter and C6's per-viewer rendering to the parallel stretch only (S to J, both lines). The rest of the chat stays one shared context. C6's plan covers the separate-context case only.
- **Thread presence is per fork**: the away marks a split writes are fork-scoped events at S, so each thread has its own cast. Nothing in C1 changes.
- **Knowers under a branch-local correction** (needed by the owner's answer to question 1, (a), **[D]** 2026-11-12, §16.2): a fork override over `presence_json`, read by `@rp/shared/knowledge.ts`. C9's `CorrectPresence` corrects every fork that shows the messages; that's right for a wrong scene check, not for a thread started inside one branch.

### 3.5 From reference-harness

reference-harness's timeline/rollout separation (ARCHITECTURE §3: an append-only timeline per chat context; agent sessions read it at a position, write back, end) carries over as it already does here (AGENTIC §2): a rollout reads one fork's view, so it reads one thread. A Matrix thread there is its own timeline key (`src/storage/timeline-key.ts`: `…:room:<id>:thread:<root>`), with its own events and summaries; threads never join, and summaries are mirrored only between agents watching the same room or thread (`summaries_from`, `src/summarization/mirror-worker.ts`). Its cross-channel messaging (`spec/CROSS-CHANNEL-MESSAGING.md`) lets an agent send into another channel with a stored context note explaining why. What carries over: a thread is addressable on its own (here: a fork id in the URL), and an agent sending into another thread would need such a note (later, §11). Joining, sending one message to several threads and summaries shared up to a split have no counterpart there.

## 4. Stored shape

All in `db/baseline.ts` (no migrations, ARCHITECTURE §3.7). **BASELINE CHANGED** when unit TH1 lands.

### 4.1 Tables and columns

```
thread_splits (                       -- one row per "Start parallel threads"
  id TEXT PRIMARY KEY,                -- UUIDv7
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  slot_id TEXT NOT NULL REFERENCES slots(id),        -- S
  fork_id TEXT NOT NULL REFERENCES forks(id),        -- F: the branch it was started in
  fork_label BLOB NOT NULL,           -- F's point when made: visible where label <= point < F's end
  seq INTEGER NOT NULL,               -- chats.state_seq when made
  origin TEXT NOT NULL DEFAULT 'user',              -- registered storage kind: user | rollout | import
  origin_ref TEXT,                    -- e.g. "<rollout>:<toolCallId>" (later, §11)
  version_id TEXT REFERENCES versions(id) ON DELETE CASCADE,  -- reserved: a reply that started it (later)
  bin_item_id TEXT REFERENCES bin_items(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
) STRICT
thread_members (
  split_id TEXT NOT NULL REFERENCES thread_splits(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  fork_id TEXT NOT NULL REFERENCES forks(id),        -- the fork that starts this thread
  starts INTEGER NOT NULL CHECK (starts IN (0, 1)),  -- 1: made by this split; 0: F continuing
  name TEXT, name_user INTEGER NOT NULL DEFAULT 0 CHECK (name_user IN (0, 1)),
  meta_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(meta_json)),   -- display extras later (colour)
  row_version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (split_id, ordinal)
) STRICT, WITHOUT ROWID
thread_sends (                        -- copies of one message sent to several threads
  slot_id TEXT PRIMARY KEY REFERENCES slots(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL
) STRICT, WITHOUT ROWID
```

Indexes: `thread_splits(chat_id)`, `thread_splits(slot_id)`, `thread_members(fork_id)`, a unique `thread_members(fork_id) WHERE starts = 1`, `thread_sends(group_id)`, plus the referencing-side indexes the schema test demands.

Columns on built tables:
- `chat_merges.timelines TEXT NOT NULL DEFAULT 'together'`: `together` (the built view) or `separate` (§7.3), a registered storage kind so a plugin can add a view. Chosen in the dialog; frozen with the row.
- `chat_merges.split_id TEXT`: soft reference, set when the source is a thread of that split (for the UI's "Joined" wording and the thread control's joined state).
- `chat_merge_messages.source_version_id TEXT`: soft reference to the version copied, beside the built `source_slot_id`.
- `chat_merge_messages.media_json TEXT` (NULL when none): the copied version's image media ids, so a later unit can send them (the first build sends text, as built).
- `chat_merge_messages.knowers_json`: C1's column, used as specified there. If C1 has landed, TH1 adds nothing for it.
- `queued_messages.send_group TEXT`: the group of a copy that queued behind a reply; the post writes its `thread_sends` row.

**No new state keys.** Thread presence is C1's `away.set`, written fork-scoped at S (§5.2) and cleared at J (§7.1). Thread names are not chat state: a thread has one name in all its branches, like a chat.

### 4.2 Invariants (triggers in the baseline, each tested on a bare connection)

- A split's slot and fork are in its chat; a member's fork is in its split's chat.
- A member with `starts = 1` is a fork whose parent is the split's fork and whose base is the split's slot (it was made from F at S). A member with `starts = 0` is the split's own fork, at most one per split.
- A fork starts at most one thread (the unique partial index). A fork may be the continuing member of several splits (F starting threads at 40 and again at 70).
- Splits are frozen; a member's split, ordinal, fork and `starts` never change; only its name, `name_user`, `meta_json` and `row_version` do.
- A send group's slots are all in one chat; a `thread_sends` row never changes.
- Written by the writer and checked there, not by triggers: S is on F's display path and not deleted there; a split has at least two members; each member's fork shows S; a group's slots are in different forks.

### 4.3 Which thread a fork is in (derived, not stored per message)

For a fork G and a split X (slot S, fork F):
1. X is **visible** in G when X's `fork_label` ≤ G's point < F's end (`labelVisibleSql`, the rule state events use) and S is on G's display path (`onForkPath`). So branches made from F before the threads were started never show them (fork independence), and a branch made from a thread at a message before S isn't in X.
2. G is in member k (`starts = 1`) when G's point lies in that member fork's label range (G is that fork or made from it, at any depth: two comparisons); otherwise in the continuing member.

`ListForks`, the shell's fork summaries and `ThreadsOf` (§13.6) compute this once per fork summary and store `(split_id, ordinal)` pairs in it. A split invalidates only F's summary (its members are new forks); a rename invalidates nothing (names are read from `thread_members`, a handful of rows).

### 4.4 Why nothing marked Later needs a migration

| Later | Fits because |
|---|---|
| Agents starting or joining threads, or moving characters between them (Phase 7, DESIGN §3.3 [D] 2026-11-05) | `thread_splits.origin`, `origin_ref` and `version_id` are there; moving a character is `away.set` attached to a version (C8's tool), as built for `set_presence` |
| Live joined text instead of the frozen copy | `source_slot_id` and `source_version_id` name what was copied |
| Images in joined lines | `media_json` |
| More views at a join (a summaries-only view, an audience chosen per join) | `timelines` is a registered kind; the renderer is the registered layout stage |
| A "shared past" at a join (CHARACTER-CONTEXT §2.4, Open) | J is the rejoin point; `summaries.audience_json` and `summarization_jobs.audience_json` (C1) hold either answer |
| A branch-local correction of who knew a message (question 1 (a), **[D]** 2026-11-12) | A new `fork_overrides` kind, which is a registered storage kind with no CHECK list (ARCHITECTURE §3.7) |
| Thread colours or icons | `thread_members.meta_json` |
| Exporting threads in an app-native chat file | Everything is in rows; nothing is implied by ordering |
| Nested threads, joins of three or more threads | Supported by the shape now (a member can start a split; several J's) |

## 5. Starting threads

### 5.1 What the user does

On any message, **Start parallel threads here…** (message action, `place` group); ⋯ **Start parallel threads…** opens it at the newest message. The dialog, "Threads from #40":
- Two thread rows to start with: **This branch** and **New thread**, and **Add a thread**. Each has a name field (placeholder: its characters' names, e.g. "Mira and Tobin") and the cast as toggle chips: who is in it. Every character starts in This branch; the user moves some into the new one. A character may be in more than one (a phone call, a ghost); a narrator is in all and isn't listed. The user's own cards go where the user toggles them.
- Each row's **Writes as**: the card the user writes as in that thread, defaulting to one of the user's cards in it, else a narrator, else its first character.
- At the newest message, nothing more. At an earlier message, the dialog says what happens to the messages after it (**[D]** owner, 2026-11-12, §16.2): "#41–#54 become This branch's thread. The characters you move to another thread count as not there for them, in this branch only." (To start every thread empty at #40, the user makes a branch at #40 first and starts threads there, where #40 is the newest message.)
- **Start** and Cancel. Hovers: "Continue from this message in two or more threads that run at the same time, each with its own characters, until you join them." on the action; "Who is in this thread. The others are away in it." on the chips.

Afterwards the user stays where they were. A toast "Threads started" offers **Open “Wren”** and **Undo**.

### 5.2 What is written (`StartThreads`, one writer transaction, registered command `thread.start`)

1. Check: ownership, the chat and fork, S on F's display path and not deleted there (else `StaleWrite` with the row version the tab saw), at least two threads, each with at least one character or narrator, the casts are cast members.
2. The split row (`fork_label` = F's point, `seq` = the next `state_seq`).
3. The continuing member (`starts = 0`, fork F), whether S is F's display end or an earlier message (**[D]** 2026-11-12, §16.2). One fork per new thread with `insertFork` at S from F, with `CreateFork`'s `hiddenAtFork` rows; they don't become current, and each starts with its own composer, its "writes as" card as the composer speaker and F's other composer state.
4. In each member's fork, at S: `away.set { entity, away: true }` for each cast character not in that thread, and `away.set { away: false }` for one in it who was away. Fork-scoped, origin `user`, `origin_ref` the split id. Written after the member forks are made, so each thread's events are its own.
5. At an earlier message (**[D]** 2026-11-12, §16.2): the messages F shows after S, through its display end, are the played stretch of F's thread. Each character F's step 4 marks away counts as not present for them in F and the forks made from F later only: the per-branch correction of who knew them (§3.4, §4.4), never `CorrectPresence`, which would change every fork that shows those messages.
6. The member rows.

Undo is a bin item of a registered kind `threads`: it marks the new member forks deleted (as `DeleteFork` does) and suppresses the split's away events in F (`suppress_event`, flag 1); restoring reverses both; deleting it for good purges the forks as `DeleteFork`'s item would. A split whose other members are all deleted shows nowhere (derived).

Fork-scoped state is untouched: each thread starts with F's notes, lorebooks, LCM settings and everything else as at S, and from then on changes them on its own, like any branch. A note edited in one thread doesn't change the other (§2, [D] 2026-11-01); the note editor in a thread offers **Also change it in “Wren”**, which writes the same revision binding there at its newest message, as the user's explicit act.

## 6. Sending one message to several threads

### 6.1 What the user does

In a thread, the composer's strip shows a chip, **To this thread** ▾ (hover: "Choose other threads that get this message too. Each one replies on its own."). Its popover lists the other threads of every set this thread is in, innermost first, each with a tick, its name, its characters' faces and a **Writes as** select (any card the composer offers, the thread's own composer speaker by default). Ticked, the chip reads **To 2 threads**, and Send's hover says so. The chip isn't there outside threads, and joined threads with nothing new aren't offered.

Example: in "At the Lantern" the user ticks "At the docks", types "Midnight. The harbor bells ring twelve times.", sets Writes as to the Narrator in both, and sends. Both threads get the message; Mira answers at the Lantern, Wren at the docks, at the same time.

### 6.2 What is written (`SendToThreads`, one writer transaction, command `thread.send`)

For each target: the thread's current fork (of the thread's forks, the one current most recently), at its tip, with the target's speaker, the same text and images. Each is exactly an append in that fork (`SendOrQueue`'s rules: posted at once, or queued behind a reply still generating, with `queued_messages.send_group`). One `thread_sends` row per posted copy, one `group_id` for all; the composer's draft is committed once. Each copy's reply follows its own thread's Next (Auto, a pick, No one), so No one in a thread means that copy gets no reply. The API starts each reply's generation after the commit; generations in different forks already run in parallel.

### 6.3 Afterwards

The copies are ordinary messages of their threads: each has its own versions, swipes, replies, deletions. The group only prompts:
- **Edit** on a copy (an amend of the user's text) offers **Save here** and **Save in both** (or "in all 3"), each amending the copy in its own fork (`AmendVersion` per fork).
- **Delete** of a copy: the toast adds **Delete the copy in “At the docks” too**.
- The message header shows a small "Also in At the docks" link to the other copy (`?fork=…&slot=…`).

## 7. Joining threads

### 7.1 What the user does and what is written

**Join a thread here…** (message action, `place` group, offered while the fork is in a set with another thread that has messages not yet joined here) and ⋯ **Join threads…** open the merge dialog (`MergeChatDialog.tsx`) in its thread mode: the threads of this fork's sets first, each with its characters and "10 messages since #40" (or "3 new since the last join"); several can be ticked. Everything else is the built dialog: position (default the newest), title (the thread's name) and framing, cast, "What the model reads". Added:
- **How the characters see it** (only in a chat with one shared context): **Everyone reads both threads** or **Each character reads only its own thread**, with hovers "Every reply sees both, the other thread as a section before this one's messages since #40." and "Characters see only the thread they were in. A narrator sees both." A chat with separate contexts shows the line as text instead: "Each character reads what it was present for (this chat's Context setting)."
- "What the model reads" gets a **For** select (each character, a narrator) when the view is separate, so the preview shows each speaker's request.

**Join** writes, per ticked thread, the built `MergeChat` (J, its row with `timelines` and `split_id`, the frozen rows with `knowers_json`, `source_version_id` and `media_json`), plus `away.set { away: false }` at J in the destination for the joined thread's characters (they're back). Several threads joined at once are consecutive J's in one transaction. The source thread stays a fork: the user can open it, and if it goes on, joining it again brings only what's new (built). The thread control shows it as "Joined at #55" (derived from `chat_merges`).

### 7.2 How a joined history is ordered

Not by time, which messages don't have (§3.3 [D] 2026-11-08), and not interleaved. By line, with the whole parallel span as the unit (CHAT-MERGE §5 [P] 2026-11-05):
1. The shared history up to S.
2. Each joined thread's line, as one block, in the order joined.
3. The destination's own line since S.
4. J (the join marker), then everything after.

The destination's line comes last, closest to what follows, so the conversation being continued stays the nearest (the owner's concern in CHAT-MERGE: "our continuation might take more from the merged chat than our own"). This is the built `parallel` layout. The built `join` layout (the block at J) stays selectable per chat ("Merged chats" in This chat). Within a block, the thread's own order. A joined thread's block holds its newest messages verbatim up to the built budget (the destination's span in tokens, 4,000 to 50,000) and its older part as its own summaries (built).

### 7.3 What each speaker sees

| View | Before the join | At and after J |
|---|---|---|
| **Together** (shared context; the default there) | Its own thread's path | Blocks 1–4 for everyone: the joined line as the built section ("Meanwhile, in parallel with what follows: At the docks, with Wren."), the destination's line as plain history, the join marker |
| **Separate**, character C | Its own thread's path (in a separate-contexts chat, filtered by what C knew there, C3) | Of the parallel stretch, only messages C knew (`knowers_json` for the joined rows, `presence_json` for the destination's): known on one side only, that side as C's plain history in the block's place; known on both sides (C moved between threads), each side as a labelled section; known on neither, nothing |
| **Separate**, a narrator (or a persona turn, or no speaker) | Its own thread's path | As Together: every line, each joined one as a labelled section (the 2026-11-08 working default) |

No gap line covers the other thread's span for a character that was in its own thread meanwhile: that's someone else's storyline (§7.1 [D] 2026-11-06). The optional join line (C4's `absent_join_prompt`, empty by default) is sent at J to a character for whom the joined storyline is new. After J, in a shared-context chat every reply sees what follows; in a separate-contexts chat, what each was present for, as always.

## 8. Worked example

Cast: Ash (the user's persona), Mira, Tobin, Wren, and a Narrator card with the narrator role. Context: one shared context, LCM on, history window about 40 messages. Messages #1–#40 happen at the market. #40, Tobin: "Wren, find out whether the Gull has docked. We'll take rooms at the Lantern."

### 8.1 What the user sees and clicks

1. On #40, ⋯ More actions → **Start parallel threads here…**. Names the rows "At the Lantern" (Ash, Mira, Tobin) and "At the docks" (Wren; Writes as: Narrator). **Start**. The timeline shows under #40 a row "Parallel threads from here: At the Lantern (this one) · At the docks", and the header's branch control reads "Thread: At the Lantern ▾".
2. Plays the Lantern to #47. Then clicks "At the docks" in the row (a link; middle-click opens a new browser tab, so both threads can sit side by side in two frames). Writes the docks as the Narrator; Wren answers.
3. At the Lantern's #47 / the docks' #45: the composer chip **To this thread** → ticks "At the docks" → Writes as Narrator in both → sends "Midnight. The harbor bells ring twelve times." Mira replies at the Lantern (#48), Wren at the docks (#46), together.
4. The Lantern reaches #54, the docks #50 (Wren is on her way back). In the Lantern, on #54: **Join a thread here…** → "At the docks · 10 messages since #40" → **Join**. The timeline shows #55 "Joined “At the docks” · 10 messages", expandable, with "Open “At the docks”". The header now reads "Thread: At the Lantern ▾" with the docks shown as joined; Wren's Cast row loses "Away · At the docks".
5. ▶ on Wren in the Cast tab: Wren speaks at #56.

### 8.2 Stored rows (abridged)

```
forks          f-main   (the chat's first; tip moves 40 → 54 → 56)
               f-docks  parent f-main, base s40, tip s50d
thread_splits  sp1  slot s40, fork f-main, fork_label <f-main's point>, seq 812
thread_members (sp1, 0, f-main,  starts 0, "At the Lantern")
               (sp1, 1, f-docks, starts 1, "At the docks")
state_events   away.set {Wren, away}            at s40, fork f-main, origin_ref sp1
               away.set {Ash, away} {Mira, away} {Tobin, away}  at s40, fork f-docks, origin_ref sp1
slots          s41…s54 under s40 in f-main's chain; s41d…s50d under s40 in f-docks' chain
version_texts  presence_json: f-main's 41–54 {"away":[Wren],"narrators":[Narrator]};
               f-docks' 41d–50d {"away":[Ash,Mira,Tobin],"narrators":[Narrator]}
thread_sends   (s47, g1), (s45d, g1)
chat_merges    J = s55 in f-main: source_chat = this chat, source_fork f-docks, source_tip s50d,
               base s40, start null (the span starts after the base: s41), title "At the docks",
               timelines together, split_id sp1
chat_merge_messages  10 rows (merge, 0…9): source_slot s41d…s50d, source_version, speaker, side,
               content, knowers_json [Narrator, Wren] (the cast less those away), included verbatim
state_events   away.set {Wren, away: false} at s55, fork f-main
```

### 8.3 Three requests

**Point 1, the docks, Wren's reply #46**: preset, every card's definitions (all are in the cast; away changes who replies, not the cards), the summaries of #1–#20, #21–#40, docks #41–#45 (the bells last). Nothing from the Lantern: it isn't on this path, and nothing makes it precede #46.

**Point 2, the Lantern, Tobin's reply #52**: preset, definitions, the summaries of #1–#20, #21–#40, Lantern #41–#51. Nothing from the docks.

**Point 3, after the join, Wren's reply #56** (shared context, Together): preset, definitions, summaries of #1–#20, #21–#40, then a system message "Meanwhile, in parallel with what follows: At the docks, with Wren." with the docks' #41–#50 as `Name: text`, then Lantern #41–#54, then "[Here “At the docks” joins this chat.]", then Wren's turn. Tobin's #57 and the Narrator's #58 read the same, plus #56.

The same point with separate contexts, or with "Each character reads only its own thread":
- **Wren #56**: …#21–#40, docks #41–#50 as her ordinary history (the Narrator's lines and hers, in their roles), Wren's turn. No Lantern messages, no gap line. Her prefix is the one her docks requests had through #50.
- **Tobin #57**: …#21–#40, Lantern #41–#54, #56 (Wren's arrival), Tobin's turn. Nothing of the docks; with a join line set, "[From here, Tobin's story continues together with Wren's.]" at J.
- **Narrator #58**: as in the shared context: both lines, the docks as the labelled section.

### 8.4 What the summaries cover

- **Before S**: L1 summaries over #1–#20 and later #21–#40 are on both threads' paths, so whichever thread's planner writes one first, the other uses the same row (built: summaries are shared up to a fork). A chunk ends at #40 when it can, since #40 now has two live children (LCM §2.1).
- **While apart**: each thread summarizes its own line in its own fork once it outgrows its window (built per-fork LCM): a summary of Lantern #41–#54 belongs to f-main, one of docks #41–#50 to f-docks.
- **After a Together join**: J is a message of f-main's chain. When it falls behind the window, the f-main summary over the chunk holding J is asked for one section per line, the Lantern first, then "At the docks" (built `merge-sections`). The docks' older part enters through its own summaries, frozen into J. That is the owner's multi-chatroom layer: one summary block, a section per room.
- **After a separate join**: the views differ from #41 on, so each keeps its own summaries from there (C7, §7.1 [D] parallel by default): Wren's view reuses what f-docks already wrote over the docks line (frozen into J), Tobin's what f-main wrote over the Lantern's. From J on, each view's chunks are summarized per audience, so a 3-view chat pays up to 3 summary requests per chunk for the rest of the chat. Whether a join should instead make the past shared is CHARACTER-CONTEXT's Open "shared past" (§2.4); J would be its rejoin point.

## 9. Summaries, in general

- A split point is a branch point, so LCM's chunk rule already ends chunks there (LCM §2.1).
- A thread's summaries are its fork's (ARCHITECTURE §3.8 "Summaries belong to the viewed fork's state"): selections, freshness, queues and backfill per fork. Nothing new.
- A join over a covered message makes the covering destination summary stale (built insert rule) and the next reply's pass writes it again over J; the dialog says so (built).
- Separate views: C7 plans per view; a separate-timeline join in a shared-context chat creates views only from S on, for the characters whose knowledge differs; before S everything stays one shared summary chain.
- Frozen summary rows of a joined line (`kind = 'summary'`) are shown to a viewer only when it knew the whole line's cast (`knowers_json` NULL means the whole source cast, C1); otherwise its known messages are shown and the rest is a gap by C4's rule.

## 10. Cache

Sizes as in CHARACTER-CONTEXT §4.4 (synthetic: preset 5,000 tokens; four cards, 12,000; summary layer 16,000; recent history 16,000; per reply the newest message, 400, and the tail, 1,000). Prices per million tokens, input / cache read / cache write: Sonnet 5.5 $2 / 0.20 / 2.50, Opus 5.5 $4 / 0.20 / 5. These are calculations, not measurements; the cache estimate shows the real numbers per request.

| Event | What breaks the cached prefix | Cost |
|---|---|---|
| Starting threads | Nothing. The continuing thread's next request is unchanged (away changes who replies, not the cards). A new thread's first request repeats the prefix through S exactly | A warm reply as before: 1.33¢ (Sonnet 5.5), 1.68¢ (Opus 5.5) |
| Playing one thread while the other waits | Each thread is its own cached line. A thread idle past the cache lifetime (5 minutes on Anthropic by default) rewrites its recent history on its next reply; the preset, cards and a layer of pre-split summaries are the same bytes in both threads, so they stay warm while either is played | First reply after expiry: 0.66¢ read + 4.35¢ write = 5.0¢ (Sonnet 5.5), 9.4¢ (Opus 5.5); then 1.33¢ / 1.68¢ |
| Sending to several threads | Nothing: one request per thread, each extending its own line | One reply's cost per thread |
| A Together join, `parallel` layout | From the split on: the section goes before the destination's span | Once: about 11,000 tokens written (the 10-message section, 4,000, the 14-message span, 5,600, the rest) ≈ 3.5¢ (Sonnet 5.5), 6.3¢ (Opus 5.5) |
| A Together join, `join` layout | From J on only | Once: about 5,400 written ≈ 2.3¢ (Sonnet 5.5) |
| Either layout when the history budget is full | The section pushes older messages out, so the stepped history start moves: the whole history once, as any overflow | Once: ≈ 4–5¢ (Sonnet 5.5) |
| A separate join | Wren's request continues her docks requests and Tobin's the Lantern's, so both stay warm when the joined rows render as the thread did (they're copied as the thread showed them; images and template macros are the exceptions). Only the narrator's view is new. From then on the start of the history differs by speaker | Per speaker whose copy expired: 5.0¢ (Sonnet 5.5), as CHARACTER-CONTEXT §4.4's speaker-dependent rows |

Bedrock has no lookback: its exact-position repeat (`historyStart.state.cacheHistory`) is kept per path, so per thread, and per view with separate contexts (C7). Local models reuse the longest common prefix with the previous prompt: switching threads re-reads from the split (16,000 tokens here: 32 s at 500 tokens/s, 8 s at 2,000).

## 11. Agent tools

- **Causal, per thread.** Tools read the generating fork's display path above the position (AGENTIC §4.1): a thread's tools never return another thread's messages before a join. That is the same rule, with nothing added.
- **After a join**, `search_chat` and `read_messages` read a join's frozen rows as messages ("At the docks #47, Wren: …"), not J's transcript as one blob, and with a separate view only the rows the speaker knew (C5's filter over `knowers_json`). `expand_summary` and `search_summaries` read the destination's summaries and the joined line's frozen summary rows under the same rule.
- **`set_presence`** in a thread moves a character within that thread (C8). Moving a character between threads, starting, joining or sending into other threads are not tools in this design: "in-chat parallel threads moved by agents" stay Phase 7 (DESIGN §3.3 [D] 2026-11-05). The commands `thread.start`, `thread.send` and `chat.merge` are registered so such a tool calls the same path, and `thread_splits.origin`, `origin_ref` and `version_id` hold what it would record; a send into another thread would carry a context note, as reference-harness's cross-channel messaging does (§3.5).

## 12. Import and export

- **SillyTavern export** (`.jsonl`, the branch shown, built): a thread exports as its fork's path, the shared history then its own line; a joined line exports J as one message holding the transcript, as a merged chat's does. ST has no threads, so nothing about them goes in the file.
- **SillyTavern import**: nothing in ST maps to threads; branch and checkpoint files stay alternate branches (§13).
- **Copies of a send** are ordinary messages in each thread's file.
- **This app's own chat export** (not built) would carry the split, member, send and join rows; the shape needs nothing for it (§4.4).

## 13. The UI on existing surfaces

Each item names the slot it uses; every control has its hover explanation; nothing is reachable only by a key.

1. **Start**: message action `message.threads` in the `place` group (beside Branch from here and Merge a chat here…, `registerMessageActions.tsx`); chat command `chat.threads` in ⋯ (`commands.tsx`).
2. **The thread control**: the header's branch control (`BranchControl.tsx`, slot `chatBranchControls`) gets two extension points, a trigger label provider and a section list. The threads feature registers both. In a thread, the trigger reads "Thread: At the docks ▾" with a threads icon (it truncates and shrinks to its icon on narrow headers as the branch trigger does, so the header's room is unchanged). The popover (and phone sheet) starts with a **Threads** section: one row per thread of each set this fork is in, innermost set first, with its name, its characters' faces, "since #40", the start of its last message and, when joined, "Joined at #55"; rows are links (`?fork=`), with a rename pencil like the branch rows. Below it, **Branches** lists the alternates as today, leaving out every fork that belongs to another thread of those sets. A fork outside any set still lists other forks' threads under a "Threads" heading, never as branches.
3. **The timeline**: a registered timeline transform `timeline.threads` puts a thin row after S, "Parallel threads from here: At the Lantern (this one) · At the docks", each name a link, hover "These threads run at the same time. Each goes on by itself until you join them." The join is the built `MergedChatRow.tsx`, worded "Joined “At the docks” · 10 messages" when `split_id` is set.
4. **The composer**: composer control `composer.threads`, placement `strip` (beside Next and the model chip, `registerComposerControls.tsx`), only in a thread (§6.1).
5. **The Cast tab**: C8/CU2's Away mark says where: "Away · At the docks".
6. **The left panel**: the open chat's branches at the panel's foot (`ShellBrowser.tsx`, `orderBranches` in `forks.ts`) get a "Threads" group before the branch groups; the chat row's "⑂ 12" counts branches without thread forks.
7. **Joining**: message action `message.join-thread` and ⋯ `chat.join-threads` open `MergeChatDialog.tsx` in thread mode (§7.1). This chat's "Merged chats" layout setting covers joined threads too.
8. **Seeing two threads at once**: the workbench's frames and browser tabs, each with its own URL (`/chats/<id>?fork=<thread fork>`); nothing new.

The thread a tab shows is its URL's `fork`, so reloads, links and the workbench keep it (the URL is the state of a tab).

## 14. Performance at the owner's scale

Hundreds of branches per chat, thousands of messages each, 20–50 swipes:
- **Path reads, assembly before a join, swipes, sends**: unchanged; a thread is a fork, read by its label and chain segments.
- **Thread membership**: computed with each fork summary (§4.3): per fork, one label comparison per split plus `onForkPath` for S (the path's branch points). Splits are few (tens at most per chat); with 300 forks and 20 splits the first computation is 6,000 label comparisons and at most 6,000 path checks, after which only F's summary is recomputed per new split. `ThreadsOf` for one fork reads its stored pairs and the members' rows.
- **Starting threads**: one split row, a fork per new thread (three row writes each, FORK-COST), the members and a few events: constant in the history's size.
- **Joining**: the built merge measured 133 ms preview and 153 ms write for a 1,000-message source branch in a chat with 200 branches (ARCHITECTURE §12). A 3,000-message thread writes 3,000 frozen rows in batches of 200 in one transaction; target under 500 ms, measured in TH5's slow test.
- **Separate views**: knowers are read per history window (C3), the frozen rows' `knowers_json` with the window; no read grows with the chat.
- **Tests** at the owner's shape: a 3,000-message chat with 300 forks and 30 swipes per message, 10 splits, a thread of 3,000 messages joined; `ListForks` and the branch popover's first paint within the existing budgets (`clientperf`'s windowed lists).

## 15. Build units

In the style of AGENTIC §11: each unit for one agent session, with its tests; each moves its text into ARCHITECTURE and marks what it built here. Stored data first.

| # | Unit | Depends on | Files | Tests |
|---|---|---|---|---|
| TH1 | **Stored shape**: `thread_splits`, `thread_members`, `thread_sends`, the five columns on `chat_merges`, `chat_merge_messages` and `queued_messages`, storage kinds (`timelines`, split origins, the `threads` bin kind), triggers, indexes; membership (§4.3) in fork summaries (format bump) and `ListForks`; reader `ThreadsOf`. **BASELINE CHANGED** | C1 merged, or adds `knowers_json` itself | `db/baseline.ts`, `db/storageKinds.ts`, `db/forkSummaries.ts`, `db/forks.ts`, `db/ops.ts`, `@rp/shared/threads.ts`, the recorded schema fixture | Every trigger on a bare connection; membership against an oracle over random fork trees, splits and nested splits (forks made before a split never in it, a branch of a thread at a message before S not in it); summary invalidation only of F |
| TH2 | **Starting threads**: `StartThreads`, command `thread.start`, the away events, the composer speaker per thread, Undo through the `threads` bin item, rename | TH1, C1 | `db/threadWrites.ts`, `api/threads.ts`, `db/bin.ts` | A split at the tip and at an earlier message (the played messages stay the first thread, with the moved characters not present for them in this branch only); fork independence (a branch made before, a sibling at the same tip); the away marks in each thread only; Auto never picks an away card there; Undo and restore; isolation probes |
| TH3 | **Client: start and switch**: the start dialog, `message.threads`, `chat.threads`, the branch control's extension points and Threads section, `timeline.threads`, the left panel group, the note editor's "Also change it in …" | TH2 | `features/threads/*`, `BranchControl.tsx`, `ShellBrowser.tsx`, `forks.ts`, `timelineContributions.tsx` | e2e at 1440 and 390, light and dark: start at the newest message and at an earlier one (the dialog's line on the messages after it), switch by link, middle-click to a new tab, rename, Undo; layout audit on the header, the branch popover and sheet, the timeline row and the left panel |
| TH4 | **Sending to several**: `SendToThreads`, command `thread.send`, `send_group` through the queue, `composer.threads`, the edit and delete prompts, the "Also in" link | TH2 | `db/threadWrites.ts`, `db/queueRows.ts`, `features/threads/*`, `registerComposerControls.tsx` | Through the mock provider: two replies generating at once in two threads; a copy queued behind a running reply posts with its group; No one in one thread; different speakers; Save in both; layout audit on the composer strip at 390 |
| TH5 | **Joining threads**: the thread source in `mergePlan` (already valid), presence back at J, `timelines` and `split_id`, the frozen rows' `source_version_id`, `media_json`, `knowers_json`; dialog thread mode, the view choice, the per-speaker preview, "Joined" wording | TH1, TH2 (C2 for knowers) | `db/merges.ts`, `MergeChatDialog.tsx`, `MergedChatRow.tsx` | The example's rows exactly; re-join brings only what's new; three threads joined at once; deleting J; slow: a 3,000-message thread in a 300-fork chat |
| TH6 | **What each speaker reads at a join**: the `merge-layout` stage gets the view; own-line rendering; a separate join in a shared-context chat filters the parallel stretch only; narrator and persona turns as Together | TH5, C3, C6 | `assembler/merges.ts`, `assembler/knowledge.ts`, `db/assemblySources.ts` | §8.3's requests byte for byte (snapshots); causal order (a message before J never sees the source); Wren's post-join prefix equals her last docks request through #50; shared-context Together joins byte-identical to today's merges |
| TH7 | **Summaries across splits and joins**: chunks ending at S, per-view summaries from S for separate joins (on C7), frozen summary rows filtered by knowers | TH6, C7 | `db/lcm*.ts`, `lcm/*` | The LCM model test gains split, send and join steps (both views); one shared summary before S; no Lantern text in Wren's separate view; scale at the owner's shape |
| TH8 | **Tools across threads**: read tools over joined rows per message, filtered by the view | TH6, C5 | `agent/tools/history.ts`, `db/agentReads.ts` | A thread's search never finds the other thread before a join; after it, finds "At the docks #47" only for those who knew it |

Order: TH1, then TH2; TH3 and TH4 after TH2, in parallel; TH5 after TH2; TH6 after TH5 and C3/C6; TH7 and TH8 after TH6. TH1–TH5 need no Open answer; question 1 (answered 2026-11-12) changes TH2 and TH3 only.

## 16. Decisions

### 16.1 Settled here because they follow from decided rules (not asked)

- **A thread never sees another thread before a join, a narrator included.** A narrator "sees every message" on its path (§7.1 [D]; CHARACTER-CONTEXT §6 [P]); another thread's messages neither precede nor follow it, and showing them "as they stand now" would order the story by when requests happened, which is time (§3.3 [D] 2026-11-08). To let the docks know what happened at the Lantern so far, join the Lantern into the docks and keep both going: re-joins bring only what's new.
- **Thread state is per thread**, and nothing spreads by itself (§4 [D] 2026-11-01); explicit "Also change it in …" offers do it.
- **The join's default view follows the chat's Context setting** (Together with one shared context, the default, §7.1 [D]; by presence with separate contexts); Separate is offered per join (§3.3 [D] 2026-11-08).
- **The joined copy is frozen at the join**, as merges are ("a merge never changes", built); editing a thread's message after the join changes the thread, and joining again after deleting J brings the change.

### 16.2 Questions for the owner

**1. Starting threads at an earlier message: do the messages already played after it become one of the threads?** **[D]** (owner, 2026-11-12): **yes, (a).**
- *Example:* you played the Lantern scene #41–#54 with Wren in the cast but silent. You decide she went to the docks at #40, and start threads at #40 to play her side.
- *Decided:* #41–#54 become the "At the Lantern" thread, and Wren is recorded as not present for them in this branch only (a per-branch correction of who was there, which other branches showing those messages don't get). The docks thread starts new at #40. The Lantern thread goes on from #54 and its requests hold #41–#54; with separate contexts or a join that keeps timelines separate, Wren's requests leave #41–#54 out in this branch.
- *Struck:* (b), both threads starting new at #40 with #41–#54 left as an alternate. The owner's reason: it is redundant, since whoever wants both threads to start empty at #40 makes a branch at #40 first and starts threads there, where #40 is the newest message. So there is no such mode.

Already open elsewhere and not re-asked; threads use their current defaults: how a narrator's context shows storylines that diverged and converged (CHARACTER-CONTEXT §6; for joined threads the working default is the merge's labelled section, §7.3), and whether a join makes the past shared at the summary layer (CHARACTER-CONTEXT §2.4; default: parallel summaries, §8.4).
