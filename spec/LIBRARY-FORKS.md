# One fork model for the library

**Status**: Obsolete: implemented 2026-11-06 (libfork); ARCHITECTURE §3.9 ("The model", "Forks") documents what was built. Kept as the design record. Originally Proposed, 2026-11-06 (libfork), from schemaforecast §2.6. The owner's decisions it rests on are DESIGN §4 **[D]** 2026-11-01 ("Explicit merges for every library fork"), the owner's 2026-11-06 instruction quoted below, and DESIGN §4 **[D]** 2026-11-06 ("A fork's History is a git branch's log"), which replaced §4 change 1 as first built; everything else is **[P]**. Delta from master df2cdffa (ARCHITECTURE §3.9, §14.6).

Owner, 2026-11-06: "If it doesn't make a product difference, we shouldn't have two models, but make sure the unified one is the best option."

## 1. What exists today

Two shapes carry the same meaning since forkmerge (every fork is a git-like branch; nothing flows without an explicit merge):

- **Cards (A, since c70a812c "Card forks, unit 1").** A fork is a new entity. `entities.forked_from_entity_id`, `forked_from_revision_id`, `forked_in_chat_id`, `forked_at` record its parent. The fork has one `upstream` ref and its own revisions (history starts at the fork: first revision `parents: []`, `origin_ref {"forked": <rev>}`, "Forked from …"), its own tags, archive and bin state, chats, notes. Merge source: its own import line once it has one, else the parent's head; base `coalesce(ref.merge_base_revision_id, entity.forked_from_revision_id)`. Family: `cardFamily`, a recursive walk over `entities_forked_from`.
- **Presets, lorebooks, notes (B, from the first schema).** A fork ("variant") is a second ref of the same entity: `entity_refs.ref_kind = 'variant'`, `follows_ref_id` (now only an ancestry edge), `merge_base_revision_id`, `forked_from_revision_id`. A third kind, `chat_override` (`entity_refs.chat_id`), is a one-chat copy. All refs share the entity's revisions, tags, archive state and bin state. Merge source: the followed ref's head. Family: a recursive query over every one of the user's refs.

Code paths that exist twice because of it: fork (`ForkRef`/`ForkWithDrafts` vs `ForkCard`), merge source (`follows_ref_id` vs `forked_from_entity_id` in `refSelect`, `getSource`, `recordMerge`), family (`genealogy`'s two branches), the card-only `card_ref_insert`/`card_ref_update` triggers, and `ref_kind`/`chat_id` filters in about forty queries (assembly, state refs, lorebook settings, shell, bin, imports).

## 2. Is there a product difference the owner relies on?

Checked against the code and the UI, surface by surface:

| Surface | Cards (A) | Presets/lorebooks (B) | Relied on? |
|---|---|---|---|
| Library list | one row per fork | one row per variant, "variant" badge | Same rows either way; the badge stays (derived from having a parent). |
| "N forks"/family | Forks tree (`CardFamily`), `CardFamilyIndex` badges | "Variants:" line in the editor (every ref of the entity), Family dialog | Both stay; computed from the entity relation. |
| Chats bound to a fork | by entity id (cast, presence, `card.binding`) | by ref id (`preset.binding`, `lorebook.attach`, a preset's `lorebooks`, a connection's preset lock, the account default) | Ref ids keep working: a fork still has one ref with its own id. |
| Re-import following upstream | the original's import line; a fork's own first import takes over | the upstream ref's import line; variants refuse imports | Same: forks get no `source_path`, so ST re-imports and "Update from file…" reach only the original. |
| Merges | `ForkMergeStatus`/`PreviewForkMerge`/`CommitForkMerge`/`UndoForkMerge` | the same operations | The same operations, one source rule. |
| Archive | per fork | **per entity: archiving a variant archives the original and every sibling** | Not relied on: it is a defect (presets' Archive button in the library and both pickers). |
| Bin | per fork | **per entity: deleting a variant note bins the original too** | Not reachable today (notes have no variant UI; presets/lorebooks have no delete), but the same defect. |
| Tags/folders | copied at the fork, then independent | shared by all variants | Not visible: presets and lorebooks have no folder UI; the persona folder is cards'. |
| Search | per ref/entity | per ref | No difference. |
| Card identity in casts/presence | the entity | n/a | Must stay entity-based: a card fork is a different character in a cast. This rules out B for cards. |
| Chat overrides | refused for cards | `chat_override` refs | **Dead**: no RPC creates one (`CreateChatOverride` is not exposed), DESIGN §6.1 rejected per-chat preset changes, §4 replaced them for cards with fork-and-swap. |
| History | starts at the fork | the variant's first-parent line includes the parent's revisions before the fork | **Visible**, see §4: now every kind's runs on through the parent's (owner [D], 2026-11-06). |

So: no difference the owner relies on, two defects in B (archive, bin), and one visible difference (history) that the unification must pick a side of.

## 3. Options

- **(A) Every fork its own entity** (the card model for every kind). `entity_refs` is the entity's one head pointer: its id, head, merge base, import source, label and row version. Lineage lives on `entities`.
- **(B) Every fork a ref of one entity** (the preset model for every kind). Cards would need their identity to move from entity to ref: casts, presence, `card_chat_membership`, `version_participants`, speakers, notes' `owner.card`, `card.swap`, the shell's card queries. Archive, bin and tags would have to move to refs to fix the defects above. It is the largest change, the riskiest, and it makes every card query join through refs.
- **(C1) Fold refs into entities.** As (A), then drop `entity_refs` and use the entity id everywhere. The ref id is in URLs (`/library/$refId`), drafts (`target_id`), state events, preset documents' `lorebooks`, connections' preset lock, `library_merges`; changing them all buys nothing the user sees, and keeps the hot head row (moved by every save) apart from the entity row read by every list anyway. Rejected for now; (A) leaves it possible later as a pure rename.
- **(C2) (A) with cross-entity revision parents**, so a fork's first revision names the parent's revision and its History walks into the parent's. Keeps B's history for presets, but changes cards' (pre-fork revisions would appear in a card fork's History), and makes History, Restore and revision messages act on another entity's revisions. First rejected (§4) for that last point; the owner then decided History should do exactly this for every kind, cards included (DESIGN §4 [D] 2026-11-06), and the objection was the wrong one: Restore of an inherited revision restores *into the fork*, as a new revision of the fork, so it never acts on the parent. Built on (A) without the cross-entity parent: the fork's first revision keeps `parents: []`, and History follows the entity's `forked_from_revision_id` from there (§4, change 1).

**Chosen: (A).** Why:
- **Product:** keeps every behaviour the owner sees, and fixes the two defects: archive and bin act on the fork alone, as they already do for cards. Cards are unchanged.
- **Query cost at the owner's scale** (hundreds of forks, many of them chat forks of cards): the family is one indexed recursive walk (`entities_forked_from`) for every kind, replacing the non-card genealogy's scan over every ref the user has, each with a correlated `library_merges` subquery. A fork's entity holds only its own revisions, so the per-row import-line lookups in `refSelect` walk a short list instead of the whole family's. No query gains a join.
- **Simplicity:** one fork path (shared steps used by `ForkCard` and `ForkRef`), one merge source rule, one family read, no `ref_kind`, `follows_ref_id`, `chat_id` or ref-level `forked_from_revision_id`, and the card-only ref triggers become one `UNIQUE (entity_id)`.
- **Plugins:** a plugin-registered kind (regex sets, quick-reply sets, PLUGINS §8) gets forks, merges (its `library.merge` policy), family, archive and bin from the same path, with nothing kind-specific to choose.
- **Migration risk:** today it is a baseline edit. Later it would mean splitting entities: rewriting revisions' `entity_id`, tags, drafts' bases and merge records under real data. Doing it now is the cheap moment.

## 4. Visible behaviour changes

1. **A fork's History is a git branch's log** (owner, DESIGN §4 **[D]** 2026-11-06), for every kind, cards included (whose forks' History started at the fork before): the fork's own revisions, a "Forked here from <original>" line linking to the original, then the original's revisions down from the one the fork copied, each marked "From <original>"; a fork of a fork runs on through every fork back to the first original. Revisions the original made after the fork aren't listed. Numbers run on across the fork (a fork of a revision 3 starts at revision 4), in History, the editor's "changed since revision N" and the card's Replace dialog alike. The first build (one "Forked from …" revision, the rest left in the parent's History) drew the owner's "???".
   - **Restore** of an inherited revision makes a new revision of the fork with that revision's content; the original never changes. What the fork step itself changed stays the fork's: the top-level fields the fork's first revision set differently from the revision it copied (a card fork's name, nickname and version; a copied note's card and condition), at every fork crossed. **[P]** So a card fork can't be restored into its parent's names, and a copied note can't come back owned by the parent's card.
   - **Revision messages** of inherited revisions are the original's: they show on the fork, edited only in the original's History. **[P]**
   - **Paging** ("Earlier revisions") runs across fork points.
2. **Archiving a preset fork archives only that fork** (it archived the original and every sibling). Clearly better: it's what the button says.
3. **A note fork's bin entry is that note alone** (not reachable from the UI today).
4. **Chat overrides are gone**: no UI made them; the "edited for this chat" badge and the "Only <chat> uses this version" line in the editor go with them.
5. **A card fork's copies of its notes can merge the original notes' later changes**: each copy is now a fork of its note, so its editor's merge notice shows when the original note has new revisions. Before, the copies were new notes with no parent and nothing to merge.

Kept as they are, on purpose:
- "Update available" in the library list keeps its current rule: for a preset or lorebook fork it also lights when the parent has new revisions (it did, through `follows_ref_id`); for a card fork only for its own imports. **[P]** Card forks for a chat are many, and their editors already show the parent's new revisions in the merge notice.
- "Make a variant" keeps its name and dialog for presets and lorebooks (DESIGN §6.2a [D]); "Fork card" for cards. Tags are copied at the fork, as cards' are.
- "Update from file…" stays offered only on entries that aren't forks, and the HTTP import route still refuses a new file version for a preset or lorebook fork (409, as it refused a variant). The writer itself takes an import into any entry, which a card fork already needs ("Import a new version…", its note with it): that import line then becomes the fork's merge source.
- "Mark as a fork of…"/"Unlink" stays a card action (`SetCardParent`).

## 5. Schema (baseline.ts; BASELINE CHANGED)

- `entities` keeps `forked_from_entity_id`, `forked_from_revision_id`, `forked_in_chat_id`, `forked_at`, now for every kind (the `entities_fork_parent` triggers already require the same owner and kind).
- `entity_refs` loses `ref_kind`, `follows_ref_id`, `forked_from_revision_id` and `chat_id`, their checks, indexes (`entity_refs_chat`, `entity_refs_follows`, `entity_refs_fork_revision`) and triggers (`card_ref_insert`, `card_ref_update`, `entity_refs_chat_fixed`, `entity_refs_chat_owner*`), and gains `UNIQUE` on `entity_id`. `merge_base_revision_id` stays (it may name a parent's revision) and becomes `ON DELETE SET NULL`, so purging a parent never fails on a fork's merge base.
- `library_merges`: `ref_id` is the fork's one ref, `source_ref_id` the parent's; `theirs_revision_id` becomes nullable `ON DELETE SET NULL`, so a fork's merge records survive its parent's purge (the parent's revisions are another entity's now).

## 6. Code

- `refSelect` (library.ts): `parent_ref_id` is the parent entity's ref when the entity has a parent and no import line of its own (every kind); `followed_head` is the own latest import, else the parent's head; the merge base is `coalesce(r.merge_base_revision_id, e.forked_from_revision_id)`. `LibraryRef` drops `refKind`, `followsRefId`, `chatId` and gains `parentEntityId`.
- `ForkRef`/`ForkWithDrafts` make a new entity through the step `ForkCard` uses (`forkEntity`: entity, first revision, ref, lineage, tags); `ForkWithDrafts` moves the unsaved fields as before, their base moved to the fork's first revision when it was the revision copied. `CreateChatOverride`, `PromoteOverride` and `ListChatOverrides` are removed.
- `LibraryGenealogy` reads one family for every kind (`libraryFamily`, generalising `cardFamily`); members drop `refKind`. The editor's `variants` are the family's live and archived members.
- Lorebooks' ST source name (used to recognise a card's linked book) is read from the nearest ancestor with a `source_path`, as a variant read its upstream's.
- Every `ref_kind = 'upstream'` filter and `chat_id` clause on refs goes; client checks of `refKind` become `parentEntityId`.
