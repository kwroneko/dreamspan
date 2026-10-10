# Data model

**Status**: Partially implemented, 2026-10-10. The schema (every table below) and the message-graph operations are implemented and documented in ARCHITECTURE.md §3.7–§3.8. The library operations of §3.2 are implemented too (ARCHITECTURE.md §3.9), except export. Drafts are implemented (ARCHITECTURE.md §3.10). Not yet implemented: changeset application and revert, summaries and jobs logic, and the ST import mapping (§14). Implementation deltas from this draft:
- `rollouts.version_ids` is derived from `versions.rollout_id` instead of stored (principle 2).
- FTS-indexed tables have an integer `seq` rowid alias.
- Invariants are enforced by database triggers.
- `GetPath` returns windows (§4.4).
- `summary_revisions` has `token_count`, and `media_assets` has `byte_size`.
- A follower with no edits of its own since its last merge fast-forwards to the new revision instead of getting a merge revision.
- "Update available, conflicts" is derived (followed head ≠ merge base), not stored.
- Text merges word by word, so edits to different sentences of one prompt combine.
- Drafts: `undo_log` became the `draft_history` table, with one reversible patch per entry. Drafts gained `status` (active, committed, discarded), `created_at` and a single `recovery_text`, and writes can commit their draft atomically. A commit or discard deletes the history (owner, 2026-10-10); text it would lose goes to the recycle bin's recovered-text section.
- The recycle bin (migration 0004): `deleted_at`, `bin_item_id` and `purged_at` on chats, slots, versions and entities, plus `bin_items` and `recovered_texts` (ARCHITECTURE.md §3.11).

Original status: Draft, 2026-10-09. Phase 0 deliverable (see PLAN.md). Everything here is **[P] Proposed** unless marked otherwise. Section references like "DESIGN §3.1" point to [DESIGN.md](DESIGN.md).

**Baseline**: reference-harness's storage layer (`src/storage/database.ts`). We reuse its patterns:
- `agent_sessions` with a separate `agent_session_payloads` blob table holding the frozen context snapshot and transcript
- `agent_session_branches` holding the spans discarded by a fork
- summaries with `summary_events` / `summary_parents` lineage
- coverage worked out at build time instead of stored
- a single-writer SQLite queue

What's new here: reference-harness's timeline is a **linear** event list per room. Ours is a **graph** with versions, and it carries state, layered library entities, changesets, and drafts.

---

## 1. Principles

1. **Content is immutable and selections are mutable.** Message text, entity revisions and summary text are never overwritten in place. Edits create new rows, and what changes is *which* row is selected. That's what makes "nothing is ever lost", cheap reverts and changesets possible.
2. **Derive rather than store.** Staleness, coverage, the current state at a message, usage counts and "never used" are computed (and cached) rather than kept as flags that can drift. Where a materialized index is needed for speed, it can be rebuilt from the source rows.
3. **One state mechanism.** Everything about a chat that can change over the story is a **state event** at a position in the graph (§5). That covers settings, participants, presence, notes, overrides, preset and model choices, and bindings. Branching then restores state for free.
4. **Git semantics for library documents.** Cards, presets and lorebooks are documents with a revision history. Variants and upstream versions are named pointers into that history. Re-importing is a three-way merge.
5. **IDs** are time-sortable (UUIDv7) strings, so `ORDER BY id` approximates creation order.
6. **Separate users [D].** Each user has their own library, chats, connections, settings and drafts, as in ST's multi-user mode. Every owned table has `owner_user_id`, and every query is scoped by it. Sharing between users is not planned.
7. **Every generation is a rollout**, including a plain non-agentic request. The inspector, context snapshots, usage and resuming then all work the same way.

---

## 2. Overview

```
Library                          Chats
───────                          ─────
entities ──< entity_revisions    chats ──< lanes
   │              ▲                │
   └──< entity_refs (upstream,     ├──< slots ──< versions ──> rollouts ──> rollout_payloads
        variant, chat override)    │     │  ▲                        │
                                   │     └──< slot_parents (merges)  └──< rollout_branches
entity_tags (folders/personas)     │
notes are entities too             ├──< state_events (position = slot, optional version)
                                   ├──< summaries ──< summary_inputs / summary_parents
connections ──< models             │        └──< summary_revisions
media_assets                       ├──< changesets ──< changeset_items
users ──< user_prefs, drafts       └──  jobs (summarization, idle-time, import)
```

---

## 3. Library: entities, revisions, refs

### 3.1 Tables

**`entities`**: one row per logical thing. `id` is its **identity** (DESIGN §4).

| column | notes |
|---|---|
| `id` | |
| `owner_user_id` | |
| `kind` | `card` · `preset` · `lorebook` · `note` · `preset_overlay` |
| `created_at`, `archived_at` | |

**`entity_revisions`**: immutable full snapshots, like git commits.

| column | notes |
|---|---|
| `id` | |
| `entity_id` | |
| `parents` | JSON array of revision ids. Two parents for a merge (an upstream re-import merged into a variant). |
| `doc_json` | The full normalized document for its `kind` (§3.3) |
| `doc_hash` | Content hash, for deduplication and "did the file change" |
| `origin` | `import` · `user` · `agent` · `changeset` · `merge` |
| `origin_ref` | e.g. the import source path and hash, the rollout id, the changeset id |
| `message` | Optional commit-style note ("softened impersonation rule") |
| `created_at` | |

**`entity_refs`**: named, movable pointers. This is what users see and pick.

| column | notes |
|---|---|
| `id` | |
| `entity_id` | |
| `ref_kind` | `upstream` (the imported/base line) · `variant` (a user fork) · `chat_override` (one chat only) |
| `head_revision_id` | Current tip |
| `follows_ref_id` | For a variant or override: which ref it is layered on (the upstream for a variant, a variant for an override) |
| `merge_base_revision_id` | The revision of `follows_ref_id` that this ref last merged from. The common ancestor for three-way merges. |
| `label`, `subtitle` | **Library label** (DESIGN §4). Separate from the in-chat name, which lives in the document. |
| `chat_id` | Set only for `chat_override` |
| `source_path`, `source_hash` | For upstream refs created from a file (watched folder, "update available") |
| `created_at`, `updated_at`, `last_used_at` | |

**`entity_tags`**: `(entity_id, tag)`. Folders are tags, so a card can be in several. The reserved tag `persona` is the **persona folder** (DESIGN §2.2).

### 3.2 Operations
- **Edit** a ref: write a new revision whose parent is the ref's head, then move the head. Every editor commit does this; drafts come before it (§10).
- **Fork** (new variant): create a ref with `ref_kind=variant`, `head = merge_base = source head`, and `follows_ref_id = source`.
- **Re-import upstream**: add a revision to the upstream ref. For each variant that follows it, compute `merge3(base=merge_base, ours=variant head, theirs=new upstream head)` field by field. Long text fields use diff3. If it's clean, write a merge revision with two parents and advance `merge_base`. On conflict, leave the variant untouched and mark "update available, conflicts".
- **Chat-local override**: a `chat_override` ref following the variant in use, merged the same way.
- **Promote**: turn a `chat_override` into a `variant` by changing `ref_kind` and clearing `chat_id`.
- **Export**: flatten a ref's head (plus its exportable card modules) to V2/V3.

### 3.3 Normalized documents (sketch)
- **card**:
  - `name` (the in-chat name), `description`, `personality`, `scenario`, `first_mes`, `alternate_greetings[]`, `mes_example`, `system_prompt`, `post_history_instructions`, `creator_notes`, `tags`, `creator`, `version`
  - `avatar_media_id`
  - `character_book` (an embedded lorebook document)
  - `modules[]`: `{id, title, content, exportable}` (card modules, DESIGN §4.1)
  - `extensions{}`: unknown V2/V3 fields, preserved verbatim for lossless round trips
- **preset**:
  - `prompts[]` (`identifier`, `name`, `role`, `content`, `system_prompt`, `marker`, `injection_position`, `injection_depth`, `injection_order`, `forbid_overrides`, …)
  - `order[]` (the prompt order with enabled flags; we keep one order rather than ST's per-character order lists, and import the active one)
  - `samplers{}`, `postprocess`, `prefill{assistant, continue}`, `regex[]`, `squash`, `names_behavior`, …
  - `unsupported{}`: everything the importer couldn't represent, kept for export and for the import report
- **lorebook**: `entries[]` (`keys`, `secondary_keys`, `content`, `constant`, `position`, `depth`, `order`, `probability`, `group`, `sticky`, `cooldown`, `delay`, `enabled`, …) plus our own fields (`decision_hint`, `placement_override`).
- **note**:
  - `title`, `content`
  - `placement`: `{mode: tail|depth|section, depth?, role?}`
  - `condition`: `{always | speaker_is: entity | present: entity | decision: question}`
  - `owner`: `{card: entity | chat | persona: entity | global}`
  - `exportable`
- **preset_overlay**: `ops[]` applied to whatever preset is active: `toggle(identifier, on)`, `replace(identifier, content)`, `append(identifier, text)`, `insert(after_identifier, prompt)`. It's attached to a card (the owner) and applied under a condition (DESIGN §6.3). It's stored as operations rather than a snapshot, because it has to apply to presets it has never seen.

The documents are validated with TypeBox schemas (as in reference-harness). Each document has a `schema_version` so it can be migrated.

---

## 4. Chats and the message graph

### 4.1 `chats`
| column | notes |
|---|---|
| `id` | |
| `owner_user_id` | |
| `kind` | `rp` · `workshop`. Fixed at creation (DESIGN §7.7). |
| `status` | `pending` (lazy chat: no message sent yet, DESIGN §2.1) · `active` · `archived` |
| `title`, `title_source` | `auto` · `user` |
| `cover_media_id` | Optional; otherwise an avatar collage |
| `active_leaf_slot_id` | Where the chat opens by default (the main path, §4.4) |
| `created_at`, `last_message_at` | Recents sort by `last_message_at`, never by when the chat was opened |

Pending chats exist so the composer draft and greeting choice survive a refresh. They're hidden from recents and from usage counts, and garbage-collected after a while.

### 4.2 `lanes`: threads (DESIGN §3.3)
`(id, chat_id, name, color, forked_from_slot_id, created_at)`. Each chat has one main lane. **Concurrent threads are separate lanes; alternate branches share a lane.**

### 4.3 `slots`: positions in the story
| column | notes |
|---|---|
| `id` | |
| `chat_id`, `lane_id` | |
| `parent_slot_id` | The primary parent (null for the first slot). Used for fast walks. |
| `depth` | `parent.depth + 1`. Used for ordering and for "message N". |
| `selected_version_id` | **The in-place selection** (DESIGN §3.1). Changing it never touches later slots. |
| `context_excluded` | ST's "hidden from context" flag (imported; also a feature). |
| `placement_group_id` | Links the copies of one message sent to several threads. |
| `created_at`, `last_visited_at` | `last_visited_at` picks which branch to show when you navigate to a branch point |

**`slot_parents`**: `(slot_id, parent_slot_id, ordinal)`, only for **merge** slots with more than one parent. The primary parent is ordinal 0 and duplicates `parent_slot_id`.

How the structure maps to concepts:
- **Versions** are rows in `versions` under one slot. The continuation hangs off the slot.
- **Alternate branches** are child slots of the same parent **in the same lane**.
- **A concurrent thread** is a child slot in a **different lane**.
- **A merge** is a slot with parents from several lanes, placed in the target lane.

### 4.4 Paths
A **path** is the sequence of slots from the root to a leaf, following `parent_slot_id`. Every view, URL and context build works on a path: `/chat/<id>?leaf=<slot>`, defaulting to `active_leaf_slot_id`. It's computed with a recursive CTE over `parent_slot_id`. **Implemented as windows** (2026-10-10): reading a whole long path costs time linear in its length (about 180 ms of SQL at 20,000 slots), so `GetPath` returns at most `limit` slots ending at a leaf, and older history is paged in (ARCHITECTURE.md §3.8).

At a **merge slot**, the path covers both incoming lanes. How they're turned into one sequence is still open (DESIGN §3.3); the data model allows either interleaving by time or a merge-summary block.

### 4.5 `versions`
| column | notes |
|---|---|
| `id`, `slot_id`, `ordinal` | `ordinal` = position in the version picker |
| `status` | `generating` · `complete` · `stopped` (partial text kept) · `failed` · `interrupted` (resumable, DESIGN §7.5) |
| `speaker_entity_id` | Which participant this turn belongs to (any card, including persona-folder cards) |
| `writer` | `human` · `model` |
| `content` | The text. For `macro_mode=template` it keeps unresolved macros. |
| `macro_mode` | `template` (resolved at render and assembly: card greetings and other card-sourced text) · `verbatim` (model output, and **user-typed text by default** [D], DESIGN §5.6). [P] A user can turn on `template` for an individual message. |
| `context_form` | Optional compact form for the context (when the display form is HTML or rich, DESIGN §10.2) |
| `display_form` | Optional rich or HTML form, rendered sandboxed |
| `reasoning` | Extracted reasoning or chain of thought, kept separately |
| `frozen_macros` | JSON of non-deterministic macro values evaluated once (`{{random}}`, `{{roll}}`, `{{time}}`) |
| `origin` | `generated` · `user_written` · `edited` · `greeting` · `imported` · `changeset` · `scratchpad` |
| `source_version_id` | For `edited`/`changeset`: "edited from #7" |
| `greeting_ref` | For `greeting`: `{card entity, index}`, so a pending chat follows the current card version |
| `direction` | The one-turn direction given with Generate (DESIGN §2.2) |
| `rollout_id` | The rollout that produced it (null for human-written) |
| `connection_id`, `model_id` | Recorded per version (DESIGN §3.1) |
| `error_json` | For `failed`: class (http, context_length, refusal{category}, length, …), status, body |
| `usage_json` | Tokens, cache read and write, cost |
| `starred`, `hidden` | Hiding keeps a version out of the picker. Deleting is also allowed, as a deliberate act (owner, 2026-10-10). |
| `changeset_id` | If created by a changeset |
| `created_at`, `updated_at` | |

**Amending a user-created version** (DESIGN §3.1) is the one in-place content update. It first copies the old content into **`version_history`** `(version_id, content, at)`.

**Rule:** a failed version is never part of the context. If the selected version of a slot isn't usable (`failed`, or `generating` with no text yet), the slot is left out of the context.

### 4.6 Slots, versions and generation
- **Swipe** (anywhere): create a `versions` row (`status=generating`) plus a rollout. Several can generate under one slot at once; each streams independently and can be stopped on its own.
- **Branch**: create a new child slot of the slot to branch from (same lane), plus its first version.
- **New message**: create a child slot of the current leaf, plus a version, then move the leaf.
- **Generate after a later version was swapped:** later versions remember the context they were generated with in their rollout's snapshot. The "written against an older version" mark is derived by comparing a version's snapshot inputs with the current selections. Nothing is stored for it.

---

## 5. State events (DESIGN §3.4)

### 5.1 `state_events`
| column | notes |
|---|---|
| `id`, `chat_id` | |
| `slot_id` | Position: takes effect **after** this slot. Null = chat initial state (before the first message). |
| `version_id` | Null = applies whichever version of the slot is selected (user actions). Set = applies only while that version is selected (rollout effects, DESIGN §7.3). |
| `seq` | Order within a position |
| `key` | Typed key, see §5.3 |
| `scope` | Optional target: a participant entity, a role (`narrator`, `summarizer`, `agent:<entity>`), a lane |
| `value_json` | |
| `origin` | `user` · `rollout` · `changeset` · `import` |
| `origin_ref`, `created_at` | |
| `superseded_by_changeset` | Set when a changeset rewrites the event, so reverting it is possible |

### 5.2 Folding
The state at a slot S on a path is the result of applying, in path order, every event at positions up to S that is either version-independent or attached to the currently selected version. The result is cached per `(leaf, slot)` with periodic checkpoints. Any write to `state_events` or to a slot's selection invalidates the cached state of descendants.

Events made "now" are attached to the **current leaf** of the view where they were made. Branching from a slot therefore inherits every event up to that slot and none after it.

### 5.3 Keys (initial set, typed and validated)
| key | value |
|---|---|
| `participant.join` / `participant.leave` | `{entity}`: who is in the chat (persona-folder cards included) |
| `presence.set` | `{entity, present}` (DESIGN §3.5) |
| `played_by_me.set` | `{entities[]}` |
| `card.binding` | `{entity, ref?, revision?}`: which variant or override (following its head) or pinned revision a participant uses from here. **Covers non-additive story changes.** |
| `note.activate` / `note.deactivate` | `{note_entity}` |
| `note.binding` | `{note_entity, revision}`: "from here on" note content |
| `preset.binding` | `{ref?, revision?}`, with `scope` = role |
| `preset_overlay.binding` | `{overlay_entity, on}` |
| `model.binding` | `{connection, model}`, with `scope` = role |
| `layout.cards` | `concat` · `swap_tail` · … |
| `roles.projection` | `by_writer` · `alternate` · `perspective` |
| `macro.binding` | `{name: "user" \| "char" \| …, value}`: pinned bindings (DESIGN §5.3) |
| `orchestration.mode` | Mode id plus its configuration |
| `output.contract` | `final_text` · `send_message` · `both` |
| `rollout.continuity` | `fork` · `resume_previous` |
| `lorebook.attach` / `lorebook.detach` | `{ref}` |
| `var.set` | `{name, value}`: ST-style chat variables (`{{setvar}}`) |
| `author_note.set` | Imported ST author's note state (mapped to a chat-owned note) |

### 5.4 The settings scope chain (DESIGN §6.1)
Values are resolved in this order: **instance default** (`app_settings`) → **user default** (`user_settings`) → **user default for the chat kind** (`user_settings`, keyed by kind) → **chat state** (the fold, including `scope` = role) → **card overlays and per-turn conditions** at assembly time. The strip above the composer shows each resolved value together with the level it came from.

---

## 6. Notes (DESIGN §4.1)
Notes are `entities` of kind `note` (§3.3), so they have revisions, variants and history for free.
- **Which notes exist for a chat:** the notes owned by its participants' cards, the chat's own notes, persona notes, and global notes.
- **Whether a note is active, and which content applies:** the state fold (`note.activate`, `note.binding`).
- **"From here on"** edits write a new note revision and a `note.binding` event. **"Fix everywhere"** writes a new revision and runs a changeset that repoints this chat's `note.binding` events from the old revision to the new one (the open question on note identity, DESIGN §3.4, is about how this choice is presented to the user).
- **Stashing** a note is `note.deactivate`. The note itself is untouched.

---

## 7. Rollouts

### 7.1 `rollouts` (the equivalent of reference-harness's `agent_sessions`)
| column | notes |
|---|---|
| `id`, `chat_id` | |
| `kind` | `generation` · `summarize` · `condense` · `decision` · `workshop` · `idle_job` · `edit` (agentic chat editing) |
| `status` | `created` · `running` · `completed` · `stopped` · `failed` · `interrupted` (resumable) · `discarded` |
| `slot_id`, `version_ids` | For `generation`: the slot and the versions it produced (usually one) |
| `leaf_slot_id` | The path it was built from |
| `parent_rollout_id` | Set when it resumes a previous rollout (`rollout.continuity = resume_previous`, DESIGN §7.7) |
| `role` | `narrator` · `agent:<entity>` · `summarizer` · … |
| `connection_id`, `model_id` | |
| `request_class` | Scheduler priority (`interactive` · `idle` · `background`), as in reference-harness |
| `usage` | Input, output, cache read, cache write, cost, request count |
| `cache_observed_json` | Per request: whether a cache read happened. Feeds the warm/cold indicator and the parallel-swipe staggering. |
| `error`, `created_at`, `started_at`, `completed_at` | |

**`rollout_payloads`** `(rollout_id, context_snapshot_json, transcript_json)`: blobs kept in their own table, as in reference-harness. The **context snapshot** is the assembled context *as structured parts*, each tagged with its source, not just the final request body. That's what lets the run inspector show "preset block X, card Y, summary Z, notes".

**`rollout_branches`**: the same idea as `agent_session_branches`. These are discarded spans from step edits, redos and forks inside a rollout.

### 7.2 Resuming
As in reference-harness `recovery.ts`. The snapshot is taken when the rollout is created, and the transcript is flushed after each turn completes. To resume, synthetic error turns and partial turns are stripped, the interruption policy is applied (DESIGN §7.5), and a fresh agent is reseeded. Editing a step writes a `rollout_branches` row for the discarded tail and then resumes.

---

## 8. Summaries (LCM over a graph)

### 8.1 Tables
**`summaries`**
| column | notes |
|---|---|
| `id`, `chat_id`, `level` | |
| `selected_revision_id` | Summaries are editable, with versions (DESIGN §8) |
| `first_slot_id`, `last_slot_id` | The covered chain: a contiguous run of slots, each the primary parent of the next |
| `slot_count`, `token_count` | |
| `audience` | Null = everyone. Otherwise the set of entities whose views it may appear in (presence-limited agents, DESIGN §7.1). |
| `status` | `complete` · `truncated` · `superseded` |
| `rollout_id`, `created_at` | |

**`summary_revisions`** `(id, summary_id, content, origin: generated|user|changeset, created_at)`

**`summary_inputs`** (level 1) `(summary_id, slot_id, version_id, ordinal)`: **records the version of each slot that was summarized.**

**`summary_parents`** (level ≥ 2) `(summary_id, parent_id, ordinal)`, as in reference-harness.

**`summarization_jobs`**: as in reference-harness, but keyed by `(chat_id, first_slot_id, last_slot_id, level)`. `request_class` includes `idle`.

### 8.2 Behavior on a graph
- **Sharing:** a summary is valid for **every path that contains its covered chain**. Branches and threads share summaries up to the fork automatically, with no copying.
- **Coverage selection** works as in reference-harness's `selectSummaryCoverage`, restricted to summaries whose chain lies on the path and whose `audience` includes the viewer. Contiguity is checked by slot parentage instead of timestamps.
- **Staleness is derived, not flagged:** a level-1 summary is stale if any `summary_inputs.version_id` differs from that slot's current `selected_version_id`, or if a slot became `context_excluded`. A higher level is stale if any parent is stale. Stale summaries are shown and queued for regeneration in idle time (DESIGN §8).
- **Mechanical changesets** (renames) write a new `summary_revision` and update `summary_inputs.version_id` to the new versions, so the summary stays fresh without being regenerated.
- **Chunking:** the job planner never lets a chunk cross a branch point it doesn't need to, or a presence boundary when presence-limited views are active.

---

## 9. Changesets (DESIGN §10.3)
**`changesets`** `(id, chat_id, title, origin: user|agent, rollout_id, status: applying|applied|reverted|partially_reverted, created_at)`

**`changeset_items`** `(changeset_id, target_kind, target_id, before_json, after_json)`:
- `slot_selection`: slot id, version before and after (the new version itself is a normal `versions` row with `changeset_id` set)
- `summary_revision`: summary id, revision before and after
- `state_event`: the event replaced or added
- `ref_head`: an entity ref's head before and after (card overrides in this chat)

An agent edit applies items as it goes, under one changeset. **Revert** restores each item's `before`, if the target still has the changeset's `after` value. Items whose target has moved on since are reported, not overwritten. Partial revert is the same thing for selected items.

---

## 10. Drafts, undo and preferences (DESIGN §6.2)
**`users`** `(id, handle, display_name, role: admin|user, auth_json, created_at, disabled_at)`: separate users [D].
- **Authentication:** built-in login, or a trusted header from a reverse proxy (e.g. Authelia's `Remote-User`), mapped to `handle`.
- **Isolation:** everything owned (entities, chats and all their descendants, connections, media references, drafts, preferences, settings, jobs) is scoped by `owner_user_id`. Child tables (slots, versions, events, rollouts, summaries, changesets) inherit ownership through their chat, so they need no column of their own.
- **Admin:** a user with `role=admin` manages users, but has no implicit access to other users' content in the UI.

**`drafts`**
| column | notes |
|---|---|
| `id`, `user_id` | |
| `target_kind`, `target_id`, `field` | e.g. (`composer`, chat id), (`version_edit`, version id), (`scratchpad`, slot id), (`entity_field`, ref id + JSON path) |
| `content` | |
| `undo_log` | Compressed edit history: survives a refresh, and recovers from Ctrl-A plus a stray key |
| `base_revision` | What the draft was started from, for conflict detection on commit |
| `updated_at` | |

Drafts are written continuously (debounced) through the WebSocket. Committing turns a draft into a revision or version and clears it.

**`user_prefs`** `(user_id, key, value_json)`: sticky rollout collapse, the speaker-panel tab, cache countdown on or off, and so on.

**Optimistic concurrency:** every mutable row (`slots.selected_version_id`, `entity_refs.head_revision_id`, chat fields, drafts) has a `row_version` integer. A write states the version it expects and is rejected if the row has moved on.

---

## 11. Connections, models, media, settings

**`connections`**
| column | notes |
|---|---|
| `id`, `name`, `owner_user_id` | |
| `api` | Wire type: `anthropic-messages` · `openai-completions` · `openai-responses` · `gemini` · `openrouter` · … |
| `base_url` | Always overridable |
| `api_key_enc` | Write-only, encrypted with a server secret |
| `headers_json` | |
| `preset_override_ref_id` | Optional one-way binding (DESIGN §9) |
| `created_at` | |

**`models`** `(id, connection_id, model_key, source: fetched|user, display_name, capabilities_json {context, max_output, reasoning, prefill, cache_mode, cache_ttl_s, vision, tools}, hidden, fetched_at)`. Fetched models are merged with pi-ai's metadata, and user edits always override.

[PROVIDERS.md](PROVIDERS.md) proposes changes to both tables (provider kind, split upstream and override columns, proxy override) and a new `llm_requests` usage ledger, in migration `0005_providers`.

**`version_attachments`** `(version_id, ordinal, media_id, kind: image, alt_text)`: images attached to a message version (DESIGN §10.2a). New versions copy the rows they keep, because version content is immutable (§1).

**`media_assets`** `(id, sha256, mime, width, height, path, created_at)`: content-addressed files on disk, **originals kept at full resolution**, deduplicated across users. Thumbnails are derived on request. **`media_refs`** `(media_id, owner_user_id)` controls access: a user can only fetch media they hold a reference to.

**`app_settings`** `(key, value_json)`: instance-wide defaults (admin). **`user_settings`** `(user_id, key, value_json)`: each user's defaults, including defaults per chat kind.

**`jobs`**: generic background work (import, backfill, idle-time scheduling), separate from `summarization_jobs`, with reference-harness-style claim, retry and priority.

---

## 12. Search
- FTS5 over `versions.content` (every version; results are filtered to "selected on this path" when that's the scope), `summary_revisions.content`, and entity documents (cards, presets, lorebooks, notes).
- The search-and-replace UIs query this index, and replacements are written as changesets (for chats) or revisions (for entities).

---

## 13. Derived indexes (rebuildable)
- **`participation`** `(chat_id, entity_id, first_slot_id, last_message_at)`: maintained from `participant.join` events and versions. It powers "used by N chats", "never used" (only chats with `status=active` count), and the list of a card's chats.
- **Path cache, state-fold checkpoints, coverage selection:** kept in memory, or in derived tables invalidated by writes.

---

## 14. ST import mapping (DESIGN §1.4)
Based on ST's public formats. Fixtures must be synthetic; never read the owner's data.

ST's multi-user layout (`data/<handle>/…`): importing a whole ST data root offers to create one user per handle, or to import a chosen handle into the current user.

| ST | Here |
|---|---|
| Character PNG/JSON/CHARX | `entities(card)` + an `upstream` ref + a revision (`origin=import`, `source_path`, `source_hash`). Avatar → `media_assets` (original). Embedded `character_book` kept in the card document. |
| Chat JSONL line 0 (header, `chat_metadata`) | `chats` row; `note_prompt`/position/depth/role → a chat-owned note + `note.activate` at the initial position; `variables` → `var.set`; attached world info → `lorebook.attach` |
| Chat messages | One slot per message in the main lane. `mes` plus `swipes[]` → versions (`swipe_id` → `selected_version_id`). `is_user` → `writer`/speaker. `extra.reasoning` → `reasoning`. `is_system`/hidden → `context_excluded`. ST has a single hidden flag, so hidden-for-summary can't be told apart from hidden for other reasons. If the importer finds a long consecutive run of hidden messages starting at message 0 (the manual-summary pattern), it proposes un-hiding them in the import report, so LCM can take over [D]. `send_date` → `created_at`. `extra.api/model` → model fields where known. |
| Branch and checkpoint files (`chat_metadata.main_chat`) | Merged into the parent chat's graph. Messages shared with the parent (matched on content and send date) become shared slots; the rest become a child branch from the last shared slot. |
| Group definitions + group chats | One chat with all members as `participant.join` at the initial position. Disabled or muted members → `presence.set false`. `force_avatar`/`original_avatar` per message → speaker entity. |
| Personas (`settings.json` persona map + descriptions + avatar files) | Card entities tagged `persona`, with the original avatar files. The description goes into `description`, and the persona's position/depth/role into a note. User messages map their persona name or avatar to the speaker entity. |
| World Info files | `entities(lorebook)` + `upstream` refs |
| Chat-completion presets | `entities(preset)` + `upstream` refs; anything unrepresentable goes in `unsupported{}` and the import report |
| Chats with zero user turns | Skipped and counted (DESIGN §1.4) |

Linking chats to cards uses ST's folder name, falling back to the card name, the avatar file name, or a match on the greeting text. Anything ambiguous goes in the import report for the user to resolve.

---

## 15. Invariants (to be tested)
1. Nothing in `entity_revisions`, `versions.content` (except amending a user-created version, which keeps history), `summary_revisions` or `rollout_payloads` is ever overwritten: edits are non-destructive. Deleting is a deliberate act and is allowed (owner, 2026-10-10).
2. A failed or contentless version is never part of an assembled context.
3. Changing `selected_version_id` never alters any other slot, and never alters state events that don't belong to that slot's versions.
4. The state at slot S depends only on events at positions on the root→S path, and on the selections of those slots.
5. A summary only appears in a context whose path contains its whole covered chain and whose viewer is in its audience.
6. Every assembled context can be rebuilt exactly from the database (no hidden inputs), and is stored as the rollout's snapshot.
7. Model-written and user-typed text (`macro_mode=verbatim`) is never macro-expanded, in display or in assembly, unless the user switched that message to `template`.

---

## 16. Open questions
0. **[O]** How `StateEventsAt` scales: it walks the path to the root, linear in chat length. Options: branch-segment ancestry, or checkpointed fold caches (§5.2). See ARCHITECTURE.md §3.8 "Known limits".
1. How a merge is turned into one sequence (interleaving vs. a merge-summary block). **Deferred** (owner: doesn't matter now). The schema allows either.
2. ~~Whether user-typed text defaults to `template` or `verbatim`.~~ **Resolved: `verbatim`** (owner, 2026-10-09).
3. ~~ST's per-character prompt order.~~ **Resolved:** not needed. One order per preset (owner, 2026-10-09).
4. ~~Multiple users.~~ **Resolved:** separate users, as in ST (owner, 2026-10-09). See principle 6 and §10.
5. ~~Imported ST hidden messages.~~ **Resolved:** ST has one hidden flag. Hidden messages import as `context_excluded`, and a long run of hidden messages starting at message 0 triggers an offer to un-hide them (§14). Summary text kept in the context gets no special handling; it imports through whatever field held it (author's note → note, and so on).
