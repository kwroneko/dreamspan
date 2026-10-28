# Card forks: delta from the build

**Status**: Proposed, 2026-10-26. Built: units 1–4 (ARCHITECTURE §3.8, §3.9, §12); these portions are obsolete as proposals. Unit 2 uses fork independence unit 6: swaps are fork-scoped at slot null, inherited by lineage, with no copy on branch or delete. Delta from master acb40f3 to the owner's decided card-fork model. **[D]** = traceable to an owner decision (cited); **[P]** = proposed here or in a proposal doc, not confirmed. Assumes unit C (branch `unit-c-card-names`) has landed: a card's display name, in-character name and subtitle are its document's `name`, `nickname` and `character_version`, and nothing below reads a ref's `label` or `subtitle`.

**Unit 1 built** (§9, "Fork relationship and ForkCard"), 2026-10-27: migration `0056_card_forks`, `ForkCard`, `SetCardParent`, `cardFamily` and the `CardFamily` RPC, as ARCHITECTURE.md §3.9 "Card forks" now documents. Units 2–4 are also built; unit 5 remains. Unit 4 removes card variants and chat overrides without migration; its implemented portions are obsolete as proposals (ARCHITECTURE §3.9, §11.1, §14).

Scope is cards (personas included, since they are cards). Presets, lorebooks and notes keep today's ref model until the owner decides otherwise (§8, question 3).

## 1. What's built today

- **Entities, revisions, refs** (`db/schema/library.ts`, ARCHITECTURE §3.9). A card is one `entities` row. Its revisions are immutable rows with parents. `entity_refs` are movable pointers inside that one entity, of three kinds: `upstream` (the base line), `variant` (follows another ref) and `chat_override` (follows a ref for one chat; `chat_id`, cascade-deleted with the chat). A variant is therefore **not a card of its own**: it shares the entity id, the tags, the card notes (`owner.card` = the entity) and every chat-state key with the card it came from.
- **Following and merging** (`db/libraryWrites.ts:234` `flowToFollowers`, `db/library.ts` `planMerge`, `@rp/shared/merge.ts`). A follower records `merge_base_revision_id`. After any change to a ref, every follower is merged in turn, transitively: fast-forward, merge revision, or left as is with "update available" on conflict. `MergeFollowed`, `ResolveMerge`, `PreviewUpdate`/`ApplyUpdate`/`ResolveUpdate` serve this.
- **Variants** (`ForkRef`, `libraryWrites.ts:478`; `ForkWithDrafts`, `editorWrites.ts:239`; RPC `ForkVariant`; "Make a variant" in `EditorPage.tsx:176`, `RefDialogs.tsx`). A new `variant` ref at the followed ref's head, optionally taking its drafts. Listed as links in the editor (`OpenEditor.variants`) and with a badge in the library list (`list.tsx:60`). No RPC binds a chat to a variant, so a variant is library-only.
- **The chat override** (ARCHITECTURE §12 Cast tab; `OpenCardOverride`, `libraryWrites.ts:514`; RPC `EditCardForChat`, `api/chatSetup.ts:206`; chooser "Only in this chat / Everywhere", `CastTab.tsx:114`). One `chat_override` ref per (chat, card), following the card's library entry, used on **every branch of the chat** wherever no `card.binding` picks another version (`cardInChat` in `db/library.ts`; the assembler's `card` source, `assemblySources.ts:171`). `PromoteOverride` turns one into a variant; the client never calls it. "Edited for this chat" shows in the Cast tab and the editor (`EditorPage.tsx:134`).
- **`card.binding`** (`@rp/shared/state.ts`): `{ entity, ref?, revision? }`, a message-following state event. The only writer is `OpenCardOverride`'s rebind, which fires only when a binding already exists, so no binding can arise through the app; they exist only in tests.
- **Imports** (§11.1, §13). A new file makes an entity, an `upstream` ref with `source_path`/`source_hash`, and an `origin = import` revision. Imports form their own revision line; the upstream follows it like a variant follows its upstream, so a re-import (`ImportFile` with `intoRefId`, or the ST folder matched by `source_path`) is a three-way merge with the user's edits, then flows on to the upstream's variants and overrides. The ST importer creates only `upstream` refs; an ST duplicate (a card cloned in ST) arrives as a separate, unrelated entity.

## 2. Target model

- **[D]** A fork is the child of the card it was forked from; there must be an easy way to find every fork of a card (DESIGN §4). Parent changes never merge into a fork (DESIGN §4, Rejected; UX-REWORK §3 "Cards").
- **[P]** **A fork is its own entity.** A ref inside the parent's entity can't have its own chats, tile, tags, notes or bin state, and can't express "Mark as a fork of…" between two existing cards. So every card is an entity with exactly **one ref** (kind `upstream`, kept to avoid rebuilding the table; ARCHITECTURE calls it "the card's ref"). `variant` and `chat_override` refs no longer exist for cards.
- **[P] The relationship** is stored on the child, outside the card's content (DESIGN §4 [P]: lineage has no standard card field). New nullable columns on `entities`:
  - `forked_from_entity_id` → `entities(id)`, indexed; the parent.
  - `forked_from_revision_id` → `entity_revisions(id)`; the parent revision copied. Null for "Mark as a fork of…".
  - `forked_in_chat_id` → `chats(id) ON DELETE SET NULL`; set by Fork for this chat, shown as "made for ⟨chat⟩".
  - `forked_at`.
  A trigger keeps the parent of the same owner and kind (as `0011_ownership` does for other references). The writer refuses a cycle (triggers can't run recursive queries).
- **[P] The family** of a card is every entity connected to it by `forked_from_entity_id`: walk up to the root (the member with no parent), then down from it. One recursive CTE (`cardFamily` in `db/library.ts`), returning each member with its parent, display name, subtitle, bin state, last use and chat count. The same tree from any member (CARD-FORKS surface 4). Binned and purged members stay in the tree, marked, so a child of a deleted card still shows "forked from ⟨card⟩ (in the bin)".
- **[P] What a fork copies**, in one writer transaction (`ForkCard`):
  - the content: one new revision in the new entity, `parents: []`, `origin: user`, `origin_ref` naming the source revision, with the names from the dialog applied. The source is the parent's head, or, for Fork for this chat, the version the chat reads there (§3).
  - media: nothing to copy. `avatar_media_id` and `asset_media_ids` are in the document and media are referenced per user (`media_refs`), not per entity.
  - the embedded lorebook (`character_book`) and the linked world's name (`extensions.world`): in the document, so copied. Lorebook entities are shared, not copied.
  - card modules and per-field agent flags: in the document, so copied.
  - tags, the persona folder included.
  - the card's notes (`owner.card` = parent): each copied as a new note entity owned by the fork, from its head. See §8, question 2.
  - optionally the parent's unsaved drafts, moved, as `ForkWithDrafts` does now.
- **[P] What a fork doesn't copy**: revision history (the fork's history starts at the fork; Compare with parent covers the rest), `source_path`/`source_hash` (so re-imports never reach it), archive state, chats, `last_used_at`.
- **[P] Removed for cards**: the follow-and-merge flow between refs, `ForkRef`, `CreateChatOverride`, `OpenCardOverride`, `PromoteOverride`, `MergeFollowed` and the override layer in `cardInChat`, `loadCards`, `cardLibraryRef` and the assembler (the version read is a bound revision, else the card's ref head). The import line and its merge stay (§4).

## 3. Fork for this chat

- **[D]** Customizing a card for one chat is "fork and swap": an ordinary fork, with its tile, that the chat uses instead; forking the chat from anywhere earlier keeps it; existing forks of the chat keep what they had; it can be switched back to (DESIGN §4; UX-REWORK §3 "Cards").
- **[P] A new state key `card.swap { entity, replaces }`**: from here on, card `entity` takes card `replaces`' place in the cast. The fold replaces `replaces` with `entity` in `participants` (same position), `absent`, `playedByMe`, `lorebookBindings` and `embeddedLorebooks`. It leaves `cardBindings[replaces]` dormant, so swapping back restores what message-following changes had done to that card on this path. A swap of a card not in the cast does nothing. The new card is in `entity` so the existing `state_events_participants` index and every "chats this card joined" query find it by adding the key. `stateKeyIds`: both are cards; `replaces` checks ownership only (it may be in the bin). The writer refuses an `entity` outside `replaces`' family.
- **[P] Branch-owned events.** `card.swap` is the first key that belongs to the branch rather than to a message (DESIGN §3.4 [O] asks for exactly this split; cards are settled as branch-owned, UX-REWORK §5). Three rules make it so:
  1. **Reading.** On a line ending at leaf X, the state at slot S is the fold of every event on root→S, then the branch-owned events on S→X. So regenerating or swiping an earlier message uses the swapped card. `StateEventsAt` gains the leaf shown (`leafSlotId`); callers that generate at a slot pass the leaf the request came from.
  2. **Branching.** Whenever the writer inserts a slot whose parent isn't the active leaf (every branch: `AppendMessage` with `branch`, generation on a branch, in `insertSlot`), it copies, in the same transaction, the branch-owned events that are on root→(old active leaf) and not on root→(new parent) onto the new slot, in their order, `origin_ref` naming each original. A new fork of the chat from any earlier point therefore starts with the cards the branch uses now.
  3. **Deleting.** When deleting messages moves the active leaf up past slots carrying branch-owned events that applied at the old leaf, the same copy is written at the new leaf. Restoring the messages brings the originals back; re-applying a swap is a no-op, so nothing doubles.
  Existing forks of the chat keep what they had because the swap is written at the leaf shown, which no other line passes through.
- **[P] The operation** `ForkCardForChat { chatId, slotId (the leaf shown), entityId, name, nickname, characterVersion, moveDrafts }`, one writer transaction:
  1. Resolve what the chat reads for `entityId` there (`cardInChat`: a bound revision, else the head).
  2. `ForkCard` from that revision with the dialog's names, `forked_in_chat_id = chatId`.
  3. `card.swap { entity: fork, replaces: entityId }` at `slotId`, origin `user`.
  4. For every `note.activate`/`note.deactivate` of a parent's note on root→`slotId`, the same event for its copy at the same slot (and version, if attached). This is safe on other lines: the copy only matters where the fork is in the cast.
  5. Queued messages in this chat speaking or replying as `entityId` and the composer's speaker choice move to the fork.
  6. Publish `State` and invalidate `library`.
  The dialog is CARD-FORKS surface 1's [P], with the display name/version check [D] (DESIGN §4).
- **[P] "Use another version"** (CARD-FORKS surface 3) writes `card.swap { entity: picked, replaces: current }` at the leaf shown, through `ChangeCast` (new `Swap` change). Swapping back to the parent is the same act. Branching and deleting treat it as above.
- **[P] Messages already written stay attributed to the card that wrote them** (`versions.speaker_entity_id`; nothing rewrites it, and rewriting it would change the message on every line that shares it). The parent's chat list keeps the chat until the fork has spoken more recently there (CHATS.md ordering [D]); the fork's lists it from the swap on. See §8, question 1.
- **[D]** Editing a card edits it wherever it's used (CARD-FORKS "A card in a chat", from DESIGN §4: users expect editing a card to change it everywhere). So editing a fork made for a chat changes every line that uses it.

## 4. Re-import

- **[P]** (DESIGN §4 [P], CARD-FORKS surface 10) A card file re-imported updates only the card it came from: the card whose ref has that `source_path` (ST folder) or the one named by `into`. It is merged with that card's own edits as now, conflicts shown. Nothing flows on: a card ref has no followers, so `SavedRef.followers` and `ImportFile`'s follower outcomes are always empty for cards and are dropped from the card UI.
- **[P]** Forks have no `source_path`, so a re-import never reaches them and never matches them. Their Compare with parent shows what changed.
- **[P] ST duplicates.** "Mark as a fork of…" (`SetCardParent { entityId, parentEntityId }`) sets `forked_from_entity_id` with `forked_from_revision_id = null`; "Unlink" clears it. Neither card's content changes (CARD-FORKS surface 9). Refused: another user's or another kind's card, itself, or a parent that is already its descendant. The picker lists cards with the same display name first. Nothing is linked automatically.

## 5. Migration of existing data

**Obsolete, rejected by owner Q4 (2026-10-28).** No migration and no card-specific startup refusal. Deployment starts fresh from the edited baseline. Shared ref tables/columns remain because non-card entities need them; card refs are constrained to one independent upstream. The original migration proposal below is retained only as a record.

One migration (after unit C's), in the writer, cards only. Each step is user data moved, never dropped.

- **Every `variant` ref V of a card E** becomes a new entity F, processed parents first (a variant of a variant forks from the parent's new entity):
  - F: same owner, `kind = card`, E's tags, `forked_from_entity_id` = the entity of the ref V followed, `forked_from_revision_id` = V's merge base, `forked_at` = V's `created_at`.
  - Revisions: V's first-parent chain from its head back to and including the first revision reachable from the followed ref's head (V's own edits and merges since it last caught up) is copied into F with new ids. Parents are remapped within the copy; a merge's second parent stays in `origin_ref` with the original id and origin. The originals stay in E, unchanged.
  - The ref row V moves to F, **keeping its id**, so its drafts (`drafts.target_id`) and anything naming V still resolve. `entity_refs_entity_fixed` (`0011`) is dropped and recreated around this one statement. V becomes `ref_kind = 'upstream'`, `follows_ref_id`/`merge_base_revision_id` null, head = the copy of its head.
  - E's card notes are copied for F, as `ForkCard` does.
  - Pending conflicts ("update available") are not merged: by the decided model they never will be. Compare with parent shows them.
- **Every `chat_override` ref O of E in chat C** becomes a fork F the same way, with `forked_in_chat_id = C`, the parent being E (or F_V where O followed a variant V). Then in C, so that every line reads what it read before:
  - after each state event in C naming E (`participant.join/leave`, `presence.set`, `played_by_me.set`, `lorebook.binding`, `lorebook.embedded`), at the same slot and version, a seq after every event there: `card.swap { F, E }` for a join, and the same event naming F for the others.
  - for each note event on E's notes in C, the same event for F's copy (as in §3 step 4).
  - origin `user`, `origin_ref` `{"migration": "<name>", "from": <event id>}` (the origin CHECK has no migration value, and rebuilding `state_events` would cascade).
  - Queued messages and composer choices in C speaking as E move to F.
- **`card.binding` events** (none can exist outside tests, §1): one naming a ref now in another entity gets a `card.swap` to that entity right after it; one naming E's own ref or revision in a chat that had an override gets `card.swap { E, F }` after it, which is what the binding's precedence over the override meant.
- **Ref `label`/`subtitle`**: unit C's migration carries them into the document first, so the copied heads already hold them.

**Why nothing is lost.** Every revision stays where it was; the forks' copies add rows. Every ref keeps its id, and with it its drafts and their history. Every chat reads the same content on every line: an override's chat used the override's head wherever nothing bound another version, and after migration that chat's cast has F, whose head is that content, from every point E joined. The migration test checks this directly: for every chat and every leaf, the assembler's card documents before and after are equal, and every draft opens with the same text.

**Counts on the realistic synthetic data** (`writeRealisticStFolder`, imported through the real server, queried 2026-10-26 on acb40f3): 15 card entities (12 characters, 3 personas), 15 refs, all `upstream`; **0 variants, 0 chat overrides, 0 `card.binding` events**; 49 revisions, all imports; 25 chats with 67 `participant.join` events; 15 distinct display names, so 0 "Mark as a fork of…" candidates. The migration changes no row there, as expected: the importer never makes variants or overrides. The migration test therefore builds its own cases on top of that import with today's writer: a variant with edits and drafts, a variant of that variant, a variant with pending conflicts, an override following the upstream, an override following a variant, and an override in a chat where the card joined mid-chat, left, rejoined and was set absent.

**What a user sees afterwards.** Each former variant is its own tile in the grid, under its own names, with "forked from ⟨card⟩", and appears in the parent's Forks tree. Each chat that showed "Edited for this chat" now has the fork in its cast, "made for ⟨chat⟩", with its own tile and editor; the original card is untouched and no longer shows that chat as using it, except as the writer of earlier messages. Unsaved edits in a variant open in the fork's editor. "Update available" no longer appears on forks.

## 6. Message-following card changes

- **[D]** A specific mechanism, mainly for the agent rewriting a card during a turn, which must stay reversible with swipes; manually, for character progression (DESIGN §4, §4.1a; UX-REWORK §3).
- **[P]** (UX-REWORK §4) It takes a whole copy at its first change, replacing DESIGN §4.1a's field patches. On this model: the first change on a path writes a new revision in the card's own entity, parent = the revision the chat read there, which no ref points to, and a `card.binding { entity, revision }` attached to the version that made it (message-following). Later changes on that path parent on the bound revision and rebind. Edits to the card's head never reach it, and swiping or branching before it drops the binding with no extra machinery. These revisions are left out of the card's history (`ListRevisions` follows the ref's first-parent chain only, which they're not on).
- **[P]** It composes with forks: Fork for this chat copies what the chat reads, binding included, so the fork starts from the progressed card; `card.swap` leaves the parent's binding dormant, so swapping back brings it back. Nothing here is built by these units.

## 7. API and UI surfaces touched

Server:
- `db/schema`: the migration (§5); `entities` columns and trigger (§2).
- `@rp/shared/state.ts`: `card.swap` key, fold, `stateKeyIds`; a `branchOwned` set of keys; `card.binding`'s `ref` stays readable for old events, and nothing writes it.
- `@rp/shared/library.ts`: `RefKind` loses `variant`/`chat_override` for cards (kept for other kinds while §8 question 3 is open); `LibraryRef.chatId`, `followsRefId`, `updateAvailable` become import-line only for cards. New `CardFamily` / `FamilyMember`.
- `db/library.ts`: `cardInChat`, `cardLibraryRef`, `usedByChats` (a card's chats are those whose state joins or swaps in that entity), new `cardFamily`. `db/cards.ts` `loadCards`. `assemblySources.ts` card source.
- `db/graphWrites.ts`: branch-owned copying in `insertSlot` and the delete path; `reads.ts` `StateEventsAt(leafSlotId)`.
- `db/libraryWrites.ts`, `editorWrites.ts`, `ops.ts`: add `ForkCard`, `ForkCardForChat`, `SetCardParent`; remove the card paths of `ForkRef`, `ForkWithDrafts`, `CreateChatOverride`, `OpenCardOverride`, `PromoteOverride`, `MergeFollowed`; card followers out of `ImportFile`.
- `chatSetupReads.ts` `ListChatCards`, `GetCast`, `ListChats(entityId)`: read swaps.
- `bin.ts`: binning a card leaves its forks; the bin entry and the forks' line name it.

RPCs:
- `EditorApi`: `ForkVariant` → `ForkCard { refId, name, nickname, characterVersion, moveDrafts }`; new `CardFamily { entityId }`, `SetCardParent`; `OpenEditor.variants` → the fork's `forkedFrom` and `forkedInChat`; `PreviewUpdate`/`ApplyUpdate`/`ResolveUpdate` stay for the import line only.
- `ChatSetupApi`: `EditCardForChat` and `CardOverrideOpened` removed; new `ForkCardForChat`; `CastChange` gains `Swap { entityId, replaces }`; `ChatCard` loses `overrideRefId`, `usesOverride`, and `binding: ref`, and gains `forkedInChat`.

Client:
- Cast tab / right panel card details: the "Only in this chat / Everywhere" chooser and "Edited for this chat" go. The card names the card this branch uses, with "used by N chats", **Edit** (that card, everywhere [D]), **Fork for this chat**, and **Use another version** (the family tree) [P, CARD-FORKS "A card in a chat"].
- Editor: "Make a variant" → **Fork** with the three-names dialog and unit C's clash check; the variants links → a **Forks** section (the tree); "forked from ⟨card⟩", "made for ⟨chat⟩"; **Compare with parent** (read-only diff, any family member); **Mark as a fork of…** / **Unlink** [P, CARD-FORKS surfaces 1, 4, 7, 9].
- Library list (`list.tsx`): `variant` badge removed; "update available" and "Update from file" only on imported cards.
- Home grid: forks are tiles because they're entities; a fork count on tiles with forks opens the tree [P, CHATS.md].

## 8. Open questions for the owner

**Answered 2026-10-26** (recorded in DESIGN §4 and §10.3; the sections above still need updating to match):
- Q1: no single answer. Messages keep the card that wrote them; renaming a card offers, as ST does, to replace its name in past chats, through wide-range history edits (DESIGN §10.3), which also cover a renamed fork used where the old name appears.
- Q2: a card's own notes are forked with it. Named notes shared between things are likely later.
- Q3: cards only. Presets, lorebooks and notes can't work the same way and get their own designs.
- Q4: no migration. Clarified by the owner’s unit-4 brief (2026-10-28): nobody uses the app yet; deployment starts fresh from the single edited baseline. Remove card variants/overrides and card following paths, without a card-specific startup refusal. Shared schema required by other kinds stays.
- Q5: moot.

The original questions, for the record:

1. **Who wrote the earlier messages after a swap.** Messages are tied to the card that wrote them, so after Fork for this chat the transcript holds the parent's messages and then the fork's.
   - (a) Keep each message's own card (proposed). History is exact, and the parent's chat list keeps the chat for what it said. If the fork's in-character name differs, the model sees two names for what the user thinks of as one character.
   - (b) Read earlier messages through the line's swaps, so on a line that swapped to the fork, the parent's messages show and are sent as the fork. One continuous character, and the chat moves to the fork's list entirely. But the same message then reads differently on two lines, and "chats with this character" depends on which line is current.
2. **Card notes on fork: copied or shared?** Notes are tied to a card (ST's Character's Note, outfits).
   - (a) Copy them (proposed): the fork is independent, as the decision on forks says of content. An outfit note fixed on the parent doesn't reach the fork.
   - (b) Share them across the family: maintained once, but a change made for one premise reaches every fork, which is the following the owner rejected, for notes.
3. **Presets, lorebooks and notes.** They have the same variant and override mechanism. The reasons for rejecting following apply to them too, but preset re-import keeping user edits is decided (DESIGN §4) and unaffected either way.
   - (a) Cards now, the others later on the same model (proposed): smaller units; two mechanisms coexist for a while.
   - (b) All kinds in these units: one mechanism at once, roughly twice the migration and UI work, including presets' connection overrides.
4. **Migrate or wipe.** Until the owner starts using the app, wiping and re-importing is acceptable (UX-REWORK §2), and the realistic data has nothing to migrate.
   - (a) Write the migration (proposed): any existing database, the deployment's included, keeps every variant and override as forks. It's the largest piece of risk in these units (unit 4).
   - (b) Refuse to start on a database with card variants or overrides, telling the user to export them first. Much less code, but data made in the app can't come along.
5. **Migrated chat overrides' names.** They come out with the parent's display name and version, so two tiles read the same.
   - (a) Leave the content alone; the tile shows "made for ⟨chat⟩" (proposed). Nothing written for the user.
   - (b) Add a revision setting the version to e.g. "1.0 (for ⟨chat⟩)". Tiles differ at a glance, but the migration writes card content the user didn't.

## 9. Implementation units

Each is one implementer's work, ARCHITECTURE.md updated in the same commit, `npm run check` green.

1. **Fork relationship and ForkCard.** The `entities` columns and trigger, `cardFamily`, `ForkCard` (content, tags, notes, drafts), `SetCardParent` with cycle refusal, `CardFamily` RPC. Tests: copy contents (document, tags, notes, media ids, no `source_path`); the parent and its chats are untouched after editing either; family tree identical from every member, with binned members; cycles, self, other users' and other kinds' refused (isolation matrix probes); draft move.
2. **`card.swap` and branch-owned events.** Built with fork independence unit 6 (ARCHITECTURE §3.8); obsolete as a proposal. The fork-lineage implementation supersedes §3 rules 2 and 3 (no copy-on-branch or copy-on-delete). Key, fold, id declarations, `StateEventsAt(leafSlotId)`, copy on branch in `insertSlot`, copy on delete, `ChangeCast` `Swap`, readers (`GetCast`, `ListChatCards`, `ListChats(entityId)`, `usedByChats`, the assembler). Tests: fold cases (position kept, presence, played-by-me, lorebook keys moved, binding dormant then restored); regenerating an earlier message uses the swapped card; a branch from earlier keeps it; an existing line doesn't get it; deleting the message carrying it and restoring it; swap outside the family refused; `stateKeys.test.ts` oracle extended.
3. **Fork for this chat.** Built, 2026-10-28 (ARCHITECTURE §3.9, §12); obsolete as a proposal. `ForkCardForChat` and the Cast tab/right panel: the card named with "used by N chats", Edit, Fork for this chat (dialog with the clash check), Use another version. Tests: one transaction (a forced failure leaves nothing); note switches carried; queue and composer speaker moved; e2e: fork in a chat, go back three messages and branch, the branch still has the fork; the other existing branch keeps the parent; switch back.
4. **Removal of following for cards, without migration.** Built, 2026-10-28; obsolete as a proposal. Owner Q4 supersedes §5: fresh baseline, card refs restricted to one independent upstream; remove card override resolution and RPCs, refuse card variants in shared operations, retain the import-line merge. Tests cover baseline guards/equivalence, card re-import merging own edits with no followers and no fork changes, pinned revisions in assembly/cast/search, existing fork-and-swap behavior, draft movement and non-card following.
5. **Library and editor surfaces.** Fork dialog, Forks tree, Compare with parent, Mark as a fork of… / Unlink, the provenance lines, badges. Tests: e2e for each surface; screenshots at 1440 and 390 px on the realistic data with forks made in the walkthrough.

Message-following card changes (§6) are built with the agent's card rewriting, not here.
