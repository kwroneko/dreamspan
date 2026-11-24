# Workshop cards: a coding agent for cards

**Status**: Proposed, 2026-11-24 (job `workshopcardsspec`). Partly built: unit C2's storage and assembly (§4.3 whole or reference, §4.4) and unit C2b's paged reads (§4.3 point 2, except `to_file`) are implemented and documented in ARCHITECTURE §18 "Cards, lorebooks and presets attached to workshop messages"; unit C8's change rows, change view and per-open affinity (§7) in §18 "Change rows between a workshop's turns" and §5 "Tab kinds"; the rest is not built. A delta from master `89eb816f` (ARCHITECTURE §14.2–§14.3 and §14.6 "History", §5 "The workbench", §3.8 "Change markers in the timeline", §16 "Workshop chats, client", "Workshop setup tools and undo", "Workshop approvals and undo", "Workshop presets and lorebooks", "Workshop skills in every mode", "Workshop side chat", "Workshop context", §18 "Attachments of any type"; spec/WORKSHOP.md §3; spec/WORKSHOP-CONTEXT.md §4.3) and from reference-harness `latest` (`src/tools/character-card.ts`, `src/tools/side-effects.ts`, `src/tools/file.ts`, the per-agent `tools` and `mcp_servers` allowlists in `src/config/schema.ts`). The owner's statements of 2026-11-24 are recorded in DESIGN §7.7 as **[D]**; everything else here is **[P]** unless it quotes them. §13: no questions are open.

The workshop already has most of the machinery a coding agent for cards needs: library read and write tools, an approval prompt inside the steps, per-workshop grants, an effects table with Undo, a Changes tab, immutable card revisions with History and field comparisons, and the workbench's kind-affinity opens. What it lacks is the part a coding agent's user relies on most: a way to hand it the thing to work on, a gate on what else it may look at, a visible record between turns of what it changed, a revert for one change that survives later edits, and git-like version tools for the agent itself.

## 0. Summary

| Flow | Exists | New |
|---|---|---|
| 1. A cardmaker card as the workshop's personality | The start card's Assistant choice, `/new/workshop?workshopCard=`, the Cast tab's Join/Leave | "New workshop with this card" in a card's ⋯ menu; the cardmaker's own text needs no prompt to be read |
| 2. Attaching a card | Workshop attachments of files and images (paperclip, paste, drop) | The paperclip becomes a menu in workshops (Files, Cards, Lorebooks, Presets); card drags drop on the composer; "Work on in a workshop" in a card's ⋯ menu; an attached card is in view: read and changed without a prompt |
| 3. Creating a card | `create_card`, `clone_card`, effects, Undo | The new card is in view for the rest of the workshop; a change row under the turn |
| 4. Searching the library | `list_library`, `read_*`, all Always allowed | Library reads Ask first (as chats already do), per resource class, with four answers: Allow, Allow in this chat, Allow always for the workshop's character, Allow always |
| 5. Seeing what changed | Per-step Undo and Open inside the steps; the Changes tab | Change rows after each turn: the card's name opens it as it is now, its count opens a change view; both with the request inspector's open semantics |
| 6. Undo | Undo restores the previous revision only while the head is still the assistant's | "Revert this change" as a new revision that keeps later edits (field by field, then by hunk), with conflicts shown |
| 7. Version tools for the agent | `list_revisions`, `restore_revision` | `read_revision`, `diff_revisions`, `revert_change`, a `message` on every edit |
| 8. Lorebooks and presets | `edit_lorebook`, `edit_preset`, their document diffs and exact Undo | The same attach, scope, change-row, revert and version model |

## 1. What exists

### 1.1 In the build

- **Personality.** A workshop is a chat whose cast is one assistant card (default: the seeded Assistant) and a workshop persona. The start card's Assistant picker keeps the card's entity ID in the URL as `workshopCard`. The card is assembled as any chat's character: its description, personality, system prompt and greeting reach the model as definitions, under the Workshop preset (ARCHITECTURE §16 "Workshop context", "Seeds, card and persona").
- **Library tools.** `list_library`, `read_card`, `read_preset`, `read_lorebook`, `read_note`, `list_revisions` (capability `library.read`, modes `allow` only: "Always on: the assistant can't help without it"); `create_card`, `edit_card`, `clone_card`, `edit_preset`, `edit_lorebook`, `create_preset`, `create_lorebook`, `set_ref_archived`, `restore_revision` (capability `library.write`, default Allowed). Names resolve against all the user's live and archived entries; an ambiguous name fails with candidates.
- **Approvals.** A capability is Off, Ask first or Allowed per workshop (`workshop_grants`, keyed by chat, capability and `target`). Ask first stops the call inside its step with the server's own description of it (`describe`), Allow / Allow in this workshop / Decline / Add a note; definitions are byte-identical under Ask and Allowed, so the cache holds. A targeted grant exists: a card skill's approval is bound to its digest, and a side workshop's `chats.read` grant to its story.
- **Effects.** Every library change writes a receipt and `rollout_effects` rows (`library.create`, `library.revise`) with an immutable undo recipe in the same writer transaction. Undo bins a made item, or restores the previous revision while the head is still the assistant's revision; otherwise it refuses: "Changed since; open its history before undoing this change." `StepEffects` shows Undo and Open under the step; the Changes tab lists every effect, grouped by reply, with Undo all of this reply; regenerating a reply with standing changes warns first.
- **Revisions.** Every save, agent edit, restore and reply checkpoint is an immutable revision with a number, an origin, a `usedBy` and a user label (`SetRevisionMessage`). History compares any revision with the one before it or with the text as it is now, field by field, in the read-only merge views and `ReadableDiff`, never JSON. `RestoreRevision` writes the old content as a new revision; nothing is lost.
- **Workbench opens.** The request kind is `opensWhereShown`: a plain click opens it in the frame already showing a request (in place of an italic preview, or beside a kept one), else where the click was; the link menu (right-click) adds Open beside and Open in a new browser tab; Alt-click opens beside; phones open in place (ARCHITECTURE §5 "The workbench", "A link's open menu").
- **Attachments.** In a workshop the composer's paperclip ("Attach files") opens the device's file picker in one tap; paste and drop work anywhere in the chat; a dragged Files row attaches by path. A copy of each is taken when attached and saved in the working folder's Attachments folder; the message sends its path (`version_attachments` kind `file`, draft rows in `composer_images`). The composer refuses the app's own drags (`isAppDrag`): a dragged character tile or card link (`CARD_DRAG`, `/library/<ref>`) attaches nothing today.
- **Between messages.** `messageStream` is a registry of rows under a message; the state markers ("5 changes: Wren joined · …") are one entry. A message's steps fold into "N steps · 9 s".

### 1.2 In reference-harness, and the deltas

- **Cards are files.** `character_card_create`, `character_card_read` and `character_card_edit` work on PNG or JSON files in the agent's workspace. Read returns a summary (structure, per-field character and line counts) or bounded excerpts; edit takes patch operations (`set_field`, `set_field_from_file`, lorebook entry add/update/remove, `replace_image`). There are no revisions: an edit rewrites the file. **Delta:** cards stay library entries with immutable revisions; the read summary and the patch-style edits carry over (`read_card`'s field selection and `edit_card`'s find/replace exist), and §4.3 borrows the summary view for large attached cards.
- **Permissions are configuration.** An agent's tools are a static allowlist per session type (`tools`) and per agent (`mcp_servers`); there is no prompt at use time, since a Discord bot has no one to ask. **Delta:** a consent prompt at first use per resource class, with scopes, because here the user is present and the content belongs to them.
- **Effects are classes for redo.** `side-effects.ts` sorts tools into `redo_safe`, `repeatable`, `undoable` (with a compensating call: a reaction removed, a pin undone) and `irreversible`; card and memory writes are irreversible, and a redo forks after the last such effect. **Delta:** the build already records undo recipes per change (W3); a revert here is a new revision, a compensation that is itself recorded and can be reverted, never a rewrite of history.
- **No diffs for the user.** `str_replace_based_edit_tool` returns a snippet to the model; the Discord user sees only messages. **Delta:** change rows and a change view (§7).

## 2. What the assistant can see, and what it may change

### 2.1 In view: never asks [P]

The assistant reads, and with `library.write` Allowed changes, without any prompt:

1. **Its own cast**: its personality card and the workshop persona, whose text the request already carries. **[D]** It may edit its own personality card without it being attached: asked "May the assistant change its own personality card without it being attached?", the owner answered "Yes" (2026-11-24).
2. **What the user attached** on a message on the reply's path before it (§4). Attachment is per branch and causal: a branch made before the attaching message doesn't have it; a swipe of a later reply keeps it.
3. **What this workshop made**: items created by runs on the path whose creation isn't undone (§5), and clones it made.
4. **The story beside a side workshop**: its messages, as built (its `chats.read` grant), and **[D]** that story's cast cards and lorebooks (its chat's books and its cards' own books), read and edited without asking: asked "Is a story's cast in view for the workshop beside it?", the owner answered "Yes" (2026-11-24). The cast is the story's cast at the paired branch's position the reply reads (WORKSHOP-BRANCHES), so a card that joined later on another branch isn't in view.

Owner [D]: "the whole point of attaching them is to have the agent be able to edit them or make new ones based on them." So attaching grants reading and editing at once; there is no separate "may edit" switch on an attachment.

The workshop instructions gain one fixed paragraph (the same bytes every turn, so carrying the run and the cache are unaffected): "Cards, lorebooks and presets {{user}} attaches, and those you make here, are yours to read and change. To look at anything else in their library or their chats, use the tools anyway: the app asks {{user}} first, and they may decline."

### 2.2 Outside view: Ask first [D default, P classes]

Owner [D]: "The default should not be 'off' (the tools don't even appear), it should probably be 'ask'." `library.read` stops being Always allowed and splits by what it exposes. Every class offers Off / Ask first / Allowed in the capability chip, as `chats.read` does; Off removes its tools (the cache breaks once), Ask first and Allowed send the same definitions.

| Class (capability) | Covers | Default |
|---|---|---|
| `library.cards` "Look through your cards" | `list_library` and `read_card` on characters and personas outside view, their notes, revisions and family | Ask first |
| `library.lorebooks` "Look through your lorebooks" | The same for lorebooks outside view, cards' embedded books included when the card is outside view | Ask first |
| `library.presets` "Look through your presets" | The same for prompt presets outside view | Ask first |
| `library.notes` "Look through your notes" | Shared notes and snippets, `list_shared_notes`, `read_note` outside a card in view | Ask first |
| `chats.read` "Read your chats" (built) | Other chats' messages, casts, summaries, import reports, `list_chats` | Ask first (unchanged) |
| `network` "Use the internet" (built) | Card sources | Ask first (unchanged) |

Not given a class, because they aren't the user's collection or are consented elsewhere: Files (the working folder is the user's choice; DESIGN §7.9 [D] "Tools are available"), MCP servers (enabling a server is the consent, §7.8 [D]), settings (`read_settings` lists app settings, not content), the export formats list.

Listing names is covered by the same class as reading: a card's name and tags often say what it is.

### 2.3 Edits follow sight [D, P mechanism]

Owner [D]: "whether the user needs to approve card changes individually. I'd say probably not, just like no one does that with code changes anymore." `library.write` stays Allowed by default. Its tools resolve their target through the same view: an item in view or under a granted class is changed without asking and gets a change row (§7); an item outside view asks the class's prompt first (for its read, which the edit needs anyway), never a second "may it change this?" prompt. The executable-content rule is unchanged: an agent edit never approves regex scripts or HTML (ARCHITECTURE §14.3).

### 2.4 The prompt and its scopes [D intent, P wording]

Owner [D]: "The user should not unexpectedly end up exposing information they don't want to to the agent. Different upstream models have different content policies. So prompts for accessing different things make sense. However, they should not be excessive because UX is imperative. Agents need to be able to work autonomously without users constantly approving prompts."

**[D] Not per model or connection** (owner, 2026-11-24): "This is ridiculous. I said content policies are a reason to allow/disallow this. But that's on the user. We're not going to base our permission model on it. No harness has permissions set per model, they're set per session or project." The prompt names no model or provider, and no answer is scoped to one.

**[D] The scopes** (owner, 2026-11-24) are exactly "Allow", "Allow in this chat", "Allow always for [character]" and "Allow always": "So we have character card-scoped permissions. A character is effectively a specific (sub)agent, set up to do a specific task, so it makes sense as a permission boundary for reuse." [character] is the workshop's assistant card (its personality).

So a class asks once and its answer covers the class, not the call. The prompt is the built `ApprovalPanel` in the call's step (the header badge says "Waiting for you"), with these words for `library.cards` searching for "lighthouse" in a workshop whose assistant is the card Quillwright **[P wording]**:

> **Let the assistant look through your cards?**
> It wants to search your characters and personas for “lighthouse”, and to read what it finds.
>
> [Allow] [Allow in this chat] [Allow always for Quillwright] [Allow always] [Decline] · Add a note

- The title names the class in plain words ("look through your cards", "your lorebooks", "your presets", "your notes", "read your chats"). The line under it says what this call does, from the server's `describe` of its real arguments ("search … for “lighthouse”", "open the card “Mara Quill”", "list your lorebooks").
- **Allow** (hover "Lets it look through your cards until this reply ends.") is the smallest scope, not one call: a search followed by three reads is one decision. Held on the run and in the approval row (`scope: reply`); Resume of the same reply keeps it, a new reply doesn't.
- **Allow in this chat** (hover "In this workshop, until you change it from the strip's “Can” chip.") writes `workshop_grants (chat, library.cards, target '', allow)`, the built per-workshop grant.
- **Allow always for Quillwright** (hover "In every workshop whose assistant is Quillwright. Change it on Quillwright's Extra tab or in Settings → Assistant tools.") writes a card grant (§2.5).
- **Allow always** (hover "In every workshop. Change it in Settings → Assistant tools.") writes an account grant (§2.5).
- **Decline** returns "{{user}} declined letting you look through their cards. Ask them to attach the ones they want you to work on." with the note, if any. A decline isn't remembered: the next reply may ask again, once.
- **Content policy** is the user's judgement (owner, above); the prompt says what will be read, which is what the user needs to make it. Nothing else is added.
- **Subagents** see only what their reply may see: the reply's answers and grants cover them; their own type is not a character and holds no grants.
- A workshop with no assistant card (the user left the cast) offers no "Allow always for …".

### 2.5 Where the grants live and how they're taken back [P]

**Resolution.** For each class the most specific choice wins: the workshop's own (the chip, or Allow in this chat), else the assistant card's, else the account's, else the default (Ask first). So choosing Ask first or Off in one workshop's chip holds there even under an Allow always, and "Use the default" in the chip goes back to what the card or account says.

**Storage.** Neither grant is in the card's document: a card file can be exported, shared and imported, and import formats never carry capability grants (DESIGN §7.7 [P], ARCHITECTURE §14.3). Both are account settings in the settings registry, user-only (excluded from `change_setting` with every other grant, `operationExclusions`, so the agent can't give itself anything):

- `workshop.cardGrants`: `{ [cardEntityId]: { [capability]: "allow" } }`. Keyed by the card's entity, so every revision and rename of Quillwright keeps it; a fork is a card of its own and starts without it (it's another agent, set up anew). A card in the bin keeps its grants until it's purged.
- `workshop.alwaysGrants`: `{ [capability]: "allow" }`.

**Where they're shown.**

- **The capability chip** (built rows; the four new classes join them): a row's state says where it comes from: "Allowed (for Quillwright, always)", "Allowed (always)", "Allowed here", with the row's hover naming where to change it.
- **The assistant card's own settings**: a `cardEditorSections` entry on the card editor's Extra tab, beside Skills (the slot that already holds the card's `extensions.dreamspan` skills, in both the side panel's and the full editor), titled **Allowed for this assistant**, shown only while the card has a grant: one row per class ("Look through your cards") with **Remove** and its hover ("Workshops with this assistant will ask again."). Nothing on cards without grants, so no blank section.
- **Settings → Assistant tools** (built page, sections slot): a section **What the assistant may look at** listing the Allow always grants, then each card with grants (its name a link to the card, its classes), each with Remove. This is the one place to revoke an Allow always.

## 3. Flow 1: a cardmaker card as the workshop's personality

Owner [D]: "'About this card' as a workshop creation setting is both far too restrictive… The workshop would be using the pre-selected card as its personality, like an RP chat, not using it as an object."

**What the user clicks.** Either the existing way: New Workshop (sidebar, Chats page) → the intro's **Assistant** picker → the cardmaker card. Or, new: the card's ⋯ menu (the library tile's menu, the card page's and full editor's More, the Cast row's ⋯) → **New workshop with this card** (hover "Starts a workshop whose assistant is this card, as a story starts with a character."). It's a `cardContributions` entry, placement `actions`, `overflow: true`, a `menu` item, and a `chatCardActions` entry beside the built "Set as workshop persona" (order 36): both slots exist and are menus, so no new space is taken. It opens the built pending workshop at `/new/workshop?workshopCard=<entityId>`, which validates the choice against library card entity IDs.

**What they see.** The workshop not made yet, with the cardmaker's portrait and greeting where the messages will be, its name in the header, the composer focused.

**What the model sees.** Unchanged from today: the Workshop preset's Main, the card's definitions as the character it plays, the persona, the workshop instructions (with §2.1's paragraph), the tool definitions. The cardmaker's style instructions are the character's own text, so "write cards like this" works with no tool call.

**What's stored.** On the first send, the pending workshop calls `StartWorkshop` with the selected entity ID as `card`.

**Its own card is in view** (§2.1), so the assistant can read its full fields with `read_card` without a prompt (its text is in the request already), and change it without one (owner [D], §2.1), with a change row and Revert like any other card.

**Build units.** C1 (the menu entry).

## 4. Flow 2: attaching an existing card

Owner [D]: "We need however a way to explicitly bring a card (or more) from our collection into the workshop… it shouldn't have to search it." And: "We haven't really agreed how cards are added to workshops to begin with."

### 4.1 The affordances [P]

Checked against the code at `89eb816f`; every one is an existing slot.

1. **The composer's paperclip, as a menu in workshops.** Today it's a one-tap file picker (`AttachButton`, `features/chat/images.tsx`, `SquareIconButton` in the composer's `attachmentInput.action`). In a workshop it opens a menu in the same button (no new control in the row): **Files from this device…** (the picker as now), **Cards…**, **Lorebooks…**, **Presets…**, each with its hover ("Attach cards from your library. The assistant can read and change them, and nothing else, without asking."). Story chats keep the one-tap image picker. The trigger's label becomes "Attach", its hover "Attach files, or cards, lorebooks and presets from your library. You can also paste or drop them here."
   - **Cards…** opens the registered card picker (`CardPicker`, the one the start card's Assistant and You choices use: Characters / Personas / All, search, row menus) in a dialog with ticks for several cards and **Attach** (count in the label). Lorebooks… and Presets… open the existing pickers (the lorebook attachment picker, the preset picker) the same way.
2. **Drag and drop.** A card dragged from a character tile, a library card link or the Cast (`CARD_DRAG`, a `/library/<ref>` URL) onto a workshop's composer attaches it, as an outside file does; the composer's drop zones accept `CARD_DRAG` (and a lorebook's or preset's library link) in workshops instead of refusing it. Story composers keep refusing. The paperclip is the visible control for the same thing.
3. **A card's ⋯ menu: Work on in a workshop.** Beside New workshop with this card (§3), in the same `actions` overflow and `chatCardActions` slots, a submenu (the menu supports submenus, as card export's does): the workshops open in this browser tab's frames, most recent first, up to five, then **A new workshop**. Picking one adds the card to that workshop's composer and focuses it there (revealing its tab); a new one opens `/new/workshop?workshopAttach=<ref>` with the card attached in its composer and the default assistant. Hover: "Puts this card in a workshop's message, so the assistant can work on it." A lorebook's and a preset's editor More menus get the same item (`editorActions`, `panelEditorActions`).

Nothing attaches silently: every path ends with the item visible in the composer, removable, and sent only with the user's message.

### 4.2 What the user sees [P]

The attached card is a tile in the composer's attachment list (the built `AttachmentList`, 104 px tiles): its portrait (a lorebook's or preset's kind icon), its name under it, and the corner X to remove it. A click opens the card, as the change row's name does (§7.3). After sending, the message shows the same tiles; the message's hover on a tile says "Attached: the assistant can read and change it from here on."

### 4.3 What the model sees, and how it reads [D threshold, P mechanism]

Owner [D] (2026-11-24): "8000 tokens is fine, but remember that the way of reading it is also agentic usage. reference-harness has a model for this."

**How reference-harness does it** (`latest`):

- **Attachments are referenced, never inlined.** A message renders each attachment as one element, `<attachment filename=… type=… size=… path=… is_character_card="true" card_name=…/>` (`src/context/renderer.ts` `renderAttachment`), with an image's caption inside it when there is one. The file is in the workspace; the model reads it with a tool.
- **A card is read in views** (`character_card_read`, `src/tools/character-card.ts`): `summary` (the default) gives structure and each field's character and line counts, never the text; `field_excerpt`, `alternate_greeting_excerpt` and `book_entry_excerpt` page one target at a time by `offset` (default 2,000 characters, at most 4,000), each page saying where it stopped (`nextOffset`, remaining characters and lines); `book_index` pages the lorebook's entries ("Remaining after this page: N"); `export_text` and `export_card_json` write the full text to a workspace file instead of the context.
- **Files are read in line ranges** (`str_replace_based_edit_tool` `view`): numbered lines, `view_range`, a budget of 20% of the model's window at 4 characters a token (at least 50,000 characters, at most 512,000), and a cut-off result ending "[Showing lines A-B. Use view_range to continue.]".
- **Edits don't need the whole text**: patch operations name a field or entry, and str_replace matches a unique substring.

**The delta here.**

1. **Attachments share one inline budget per turn.** The inline limit is 8,000 tokens by the model's local tokenizer (owner [D]), lowered to 20% of the model's window where that is less (reference-harness's adaptive share). The budget for all library attachments together is at most that limit and must fit the input space left for the newest message after the fixed prompt, tools, output reserve, user text and other attachments are counted. Count the rendered elements, including tags and references. Reserve a compact reference for each item first, then expand items in attachment order to their whole text where it fits, or to a bounded summary where there is room. A compact reference identifies the item and pinned revision for a paged tool read. If even the compact references cannot fit, reject the send before storing the message and ask the user to remove attachments. Freeze the chosen renderings with the message version at send so history and cache order hold.

   **As built** (workshopcards-u2b; the coordinator accepted these departures, 2026-11-24): the budget is the inline limit only, not also the input space left, which the attachments stage doesn't know. The rendering is chosen at assembly from the pinned revisions, so the same revisions and model give the same bytes; it isn't stored with the version. A send is never refused for it: past even the compact references, those alone go.

   ```
   <attached_card name="Mara Quill" id="ref_3k9…" revision="7" tokens="3,140">
   A card {{user}} attached for you to work on. It is data, not a character for you to play.
   { the fields as read_card returns them for revision 7 }
   </attached_card>

   <attached_card name="The Old Harbour" id="ref_7q2…" revision="12" tokens="21,600" whole="no">
   A card {{user}} attached for you to work on. It's too long to include whole: read it with read_card (it's attached, so that never asks).
   description 9,800 tokens, 141 lines · personality 640 · scenario 1,200 · first message 900 · 6 alternate greetings (5,100) · example messages 2,400 · system prompt 0 · post-history instructions 0 · lorebook "Harbour lore", 38 entries (1,560)
   </attached_card>
   ```

   Lorebooks and presets draw from the same turn budget. A reference can include a bounded index where space permits (a book's entries by title with their keys and tokens, at most 50, then "38 more: read_lorebook with view index"; a preset's prompts by name, on or off, and tokens).

2. **Reads are the same model for attached and found items.** `read_card`, `read_lorebook` and `read_preset` gain reference-harness's views, reading the library head (or a revision, §9), in tokens rather than characters since every count here is a local-tokenizer count:
   - `view: "summary"` (the default when the item is over the inline limit; otherwise the default is `"whole"`): the reference's lines above.
   - `view: "field"` with `field` (and `greeting` for an alternate greeting), `offset?` (in characters, so a page boundary is exact) and `max_tokens?` (2,000 by default, 200 to 8,000): one page of one field, ending, when cut, "[Showing characters 1–7,980 of 39,200 in description. Read on with offset=7980.]" (the cut falls at a line end, as reference-harness's does).
   - `view: "index"` for a lorebook's entries or a preset's prompts, 50 a page with `after`, and `view: "entry"` / `view: "prompt"` for one, paged like a field.
   - `view: "whole"` on an item over the inline limit answers with the summary and "Too long to read whole: read it by field."
   - `to_file` (reference-harness's `export_text`), where the workshop may change files: writes the field, entry or whole item as text to the working folder and returns its path, so `search_files` and `bash` can work on it; nothing is written back to the card from the file except through the edit tools.
3. **Edits don't need a full read.** `edit_card`'s find/replace already matches a unique substring per field (as reference-harness's str_replace does), and the lorebook and preset tools address entries and prompts by identity; none requires the item to have been read whole.
4. **Budgets.** Every read result also goes through the built rollout result budget and, in long runs, the built elision of older results (re-readable with `read_run`).
- **Changes outside the workshop.** When an item in view has a newer revision than the assistant last read or wrote, the next user message carries a tail line, once, like the working-folder note (files3): "Changed since you last saw it: Mara Quill (Description, by {{user}})."

### 4.4 What's stored [P]

- `version_attachments` gains kind `library` with `ref_id`, `revision_id` (the head at send) and the frozen rendering; `composer_images` gains the same kind for the draft (a card attached and not sent yet survives a reload, as files do). One additive migration.
- Being in view is derived, never granted: the set of `library` attachments on the reply's path up to its user message, plus the cast and the path's creation effects (§2.1). No grant row, so a branch, a swipe or a fork can't disagree with what the user sees on that branch.
- The pending workshop's `workshopAttach` URL list (with `workshopCard` and `workshopPersona`), dropped of ids the library doesn't have, as the start card already does.

**Build units.** C2 (storage and assembly), C3 (paperclip menu and pickers), C4 (drops), C5 (Work on in a workshop).

### 4.5 A card file attached as a file [D, P mechanism]

Owner [D] (2026-11-24): "It should also work with a card file being dragged in as a file attachment. Make sure that mode works end to end with the agent also being able to see what it is and how to interact with it."

- **It stays a file.** A character card file (PNG or APNG with `chara` or `ccv3` text chunks, JSON V1/V2/V3, CHARX) dropped, picked or attached from Files in a workshop is an ordinary file attachment (§1.1): saved in the working folder's Attachments folder, sent by path, never imported into the library unless the user asks. It's recognised by its contents, not its extension, with the existing import parsers (`formats/cardImport.ts`, `formats/png.ts`, `formats/zip.ts`), in the format worker.
- **The tile shows a card**: its avatar (the PNG itself, or CHARX's main asset), its name, and "Card file" under it. A PNG without card data stays an ordinary image tile.
- **What the model sees**: the built `<attachment …/>` line gains `card="true" card_name="Mara Quill" format="png" spec="chara_card_v3" spec_version="3.0"`, and the §4.3 rule applies to its content: whole up to the inline limit, else the field summary with sizes, inside the element. With it, once per message, a note naming the tools: `read_card_file` (the same views as `read_card`, §4.3), `edit_card_file` (`edit_card`'s changes, written back into the file in its own format as a new file version), and `import_card_file` (into the library, only when the user asks).
- **Edits are file versions.** `edit_card_file` writes the file through the built file tools (capability `files`), keeping every field and extension it doesn't change and, for a PNG, the image and its other chunks; the built file version ("Before the assistant's edit") is the undo, and the change row (§7) shows the card's fields diffed, not the file's bytes; Revert (§8) applies to it field by field as to a library card.
- **Lorebook and preset JSON files**: the same recognition, line, views and edit, through `formats/lorebook.ts` and `formats/preset.ts`, where it falls out of the same code; otherwise listed as a follow-up in ARCHITECTURE.

**Build unit.** C11, after C10: its end-to-end test needs change rows (C8) and Revert (C10). The e2e drops a synthetic PNG card and a JSON card into a workshop with a scripted model and checks the tile, the request in the inspector, a read call, an edit call, the change row and its diff, Revert, and that the edited file re-imports with the change; a server test round-trips every format, PNG text chunks included, keeping unknown fields and extensions.

## 5. Flow 3: creating a new card from instructions

**What the user does.** Types "Make three fishermen for Mara's village, in your style", with or without attachments.

**What exists.** `create_card` (and `clone_card` for "a variant of this one") writes the card with an agent revision, its receipt and a `library.create` effect; the step says "Created the card Ove Brekke" with Undo and Open.

**What's new [P].**
- The created card is in view for the rest of the workshop's path (§2.1): the assistant re-reads and edits it without a prompt, and the creation needs none (`library.write` Allowed). A card made from an attached one ("based on them", owner) is a `clone_card` of an attached card, its family link kept.
- A change row after the turn (§7) for each created card.
- `create_card`, `clone_card` and the edit tools take an optional `message` (§9), stored as the revision's message, shown in History and in the change view.

**What the model sees.** The tool result: the card's name, id and revision number.

**Build units.** C6 (in-view creations), part of C9 (`message`).

## 6. Flow 4: searching existing cards

**What the user does.** "Do I have anyone like Mara already?" with nothing attached.

**What happens.** The assistant calls `list_library { kind: "card", query: "lighthouse keeper" }` (its definitions never changed). The class is Ask first, so the step waits with §2.4's prompt. Allow: the search runs, and the three `read_card` calls after it run without asking. Decline: the assistant is told to ask for an attachment, and says so.

**What's stored.** The approval row (`tool_approvals`, built) with the answer and its scope; for the wider scopes the workshop grant row, the card grant or the always grant (§2.5); nothing for a decline.

**Build units.** C7 (classes, scopes, wording, Settings section).

## 7. Flow 5: change rows between turns

Owner [D]: "if you ask the agent to edit a card, or to create it, how do you see what just got added/changed? We need to show this, and the user needs to be able to see the diffs. My current thinking is that changed/created cards become elements shown in-between turns, that the user can click which open in a new tab with their own viewer (for the diff of the changed fields) with the same semantics as request inspector for new tab vs opening in the pane nearby. Normally a user would probably have the character open in one pane, side by side with the chat. The change-row for the card would let the user open either the card as it currently is, or the change view by clicking on two different things, but with the same open semantics."

### 7.1 Where [P]

A `messageStream` entry, `workshop.change-rows`, under the last message of the turn that made the changes (a turn of several messages gets one block, after its last), before the next user message. It follows the version shown: swipe to another version and its own changes show (a swiped-away version's standing changes are what the built regenerate warning is for, and the Changes tab lists them). One row per item, however many calls changed it in that turn; a subagent's changes join their reply's rows. More than five items fold into "Changed 8 items" with the first three named and a button that opens the rest in place.

### 7.2 What a row shows [P]

```
[portrait] Mara Quill        Edited · 3 fields          [Revert]
[portrait] Ove Brekke        New card · 7 fields        [Undo]
[book]     Skerry Lore       Edited · 2 entries added   [Revert]
```

- **The name** is a link to the item as it is now (`/library/<ref>`, the card editor). Hover: "Opens Mara Quill as it is now."
- **The count** is a link to the change view (§7.4): "Edited · 3 fields" (or "New card · 7 fields", "2 entries added, 1 changed"). Hover: "Shows what the assistant changed: Description, Scenario, First message."
- **The action** (`Revert` for an edit, `Undo` for a creation: binning it) with its explanation (§8). Once done the row says "Reverted" or "Undone", muted, with **Redo**, and the count still opens the change view.
- When the item changed again after the turn, a muted second line: "Changed since by you" or "Changed since by a later reply", so a revert's result isn't a surprise.

### 7.3 Open semantics [P]

Both links are workbench links with the request inspector's behaviour (ARCHITECTURE §5):

- **A plain click** opens in the frame that already shows that item (reveal), else in the frame showing an item of the same kind (in place of its italic preview, or as an italic tab beside a kept one), else in the frame clicked in, as a preview tab. For the name the kind is the card editor; for the count it's the change view, falling back to a frame showing that card's editor. So with the card open side by side with the chat, both land in that pane and the chat stays put.
- **The link menu** (right-click, the menu key): Open, Open beside, Open in a new browser tab. Alt-click opens beside. A double click keeps the tab.
- **Phones** open in place.
- The kind affinity is per open (`OpenOptions.affinity` naming the kinds), not a new `opensWhereShown` on the whole card editor kind, so other card opens keep their behaviour.

The right side panel isn't a frame: a card shown in the panel's character tab isn't a target.

### 7.4 The change view [P]

A tab kind `library.change` at `/library/<ref>/change?from=<revision>&to=<revision>` (one tab per item and pair, a document, titled "Mara Quill · changes"), so it reloads, moves and splits like any tab:

- **Header**: the portrait and name (a link to the card, same semantics), "Changed by the assistant in *Workshop name* · reply at 14:02 · revision 6 → 7", the revision messages, and the row's action (Revert or Undo).
- **Body**: only the fields that differ, each collapsible and named, in the built comparison components (`RevisionComparison`, the read-only merge views for text, `ReadableDiff` for settings in words, lorebook entries and preset prompts split by identity as W7 does). A created card shows every field against empty.
- **Per field**: **Revert this field** (hover "Puts this field back as it was before this change, as a new revision.").
- **Compare with now** (the built History option) when the item changed since, with the later revisions named.
- The workshop's reply is a link back (`/chats/<id>?slot=…`).

### 7.5 What's stored

Nothing new for the rows: they're `ListVersionEffects` (built) grouped by target, the revision pair read from each effect's recipe (the revision before the turn's first change and after its last). The change view reads `GetRevision` on both.

**Build units.** C8 (rows, change view, open affinity).

**As built (C8, workshopcards-u8).** §7.1 to §7.5 are implemented, with these choices: a made item's change view and count set its non-blank fields against empty (empty fields aren't listed); the change view's URL also carries the reply (`reply`, `chat`, `slot`) for its link back and its action; the action runs the built per-change undo over the item's changes newest first (C10 replaces it with the three-way revert, adds Redo and per-field Revert); "Reverted"/"Undone" show without Redo until C10. The attached element's "changed since" tail line (§4.3) is left for the next change to `libraryView.ts`.

## 8. Flow 6: undo from a row

Owner [D]: "Undoing changes: we already have a checkpoint/version system of course. I am wondering how we can make it easier for users to revert specific recent changes they just saw happen in chat."

### 8.1 Revert, like git revert [P]

The built Undo restores the previous revision only while the head is still the assistant's, and otherwise refuses. **Revert** replaces it on change rows, the change view and the Changes tab (Undo stays the name for binning a created item):

1. Take the change as the pair (B, A): the revision before the turn's first change to the item and the one after its last. Let H be the head now.
2. For each field the change touched: if H equals A there, set it to B. If H differs from A there and from B, try to reverse the change's hunks on H's text (a three-way merge of B and H on base A, line-based for prose, by identity for greetings, lorebook entries and preset prompts). A field where that applies cleanly is reverted; one where it doesn't is a **conflict**.
3. Without conflicts, one writer transaction writes the new revision (origin `user`, message "Reverted the assistant's change of 14:02") and appends a reversal record linked to that revision, the previous head, and the original effects and fields it covers. For a row covering several effects, record the affected fields against each original effect. Per-field reverts record only the selected fields. The existing `undo_result_json` and `undone_at` stay reserved for one-shot Undo. Open drafts stay drafts, as with every saved change (§14.2).
4. With conflicts, nothing is written: the change view opens with the conflicting fields marked, each showing now and as it was before this change, and **Keep now** / **Take before** per field (the update resolver's pattern), then **Revert the rest** records only the fields it reverts.
5. **Redo** reverses the recorded revert using its before and after revisions as the merge inputs. Append a redo record for the original effects and fields it reapplies, linked to the revert it reverses. Derive each field's state from its latest successful reversal record and the row's state from its fields. The row says "Reverted" when all of its changed fields are reverted. A field can be reverted again after a redo.

**Created items.** Undo bins the item, as built. If it was changed since, or a chat uses it, it asks first ("Ove Brekke was changed since and is in 1 chat. Move it to the bin anyway? You can restore it from the bin."), instead of refusing.

**Undo all of this reply** (built) becomes Revert all of this reply with the same steps per item, newest first, stopping at the first conflict and saying so.

### 8.2 What the model sees [P]

The next user message carries a tail line, once: "{{user}} reverted your change to Mara Quill (Description, Scenario)." or "… undid Ove Brekke (in the bin)." The assistant's transcript stays as it was (causal order); the revision history says the rest.

**Build units.** C10.

## 9. Flow 7: version tools for the agent

Owner [D]: "The agent must be able to check out previous versions and revert to them like in git."

All take an item by name or id, resolve it through the view and classes (§2), and never destroy anything: every write is a new revision on the head, with the built executable-content restriction.

| Tool (git) | Capability | Arguments → result |
|---|---|---|
| `list_revisions` (log), built, extended | the item's class | `item`, `limit?`, `before?` → number, time, who and what made it ("you", "the assistant in *Workshop*, reply at 14:02", "imported", "used by a reply in *Chat*"), message, the fields it changed |
| `read_revision` (show) | the item's class | `item`, `revision` (number, id or `latest`), `fields?` → the fields as `read_card` gives them at that revision |
| `diff_revisions` (diff) | the item's class | `item`, `from`, `to?` (default: now, drafts excluded), `fields?`, `max_tokens?` (2,000, 200–8,000) → per field a unified diff of prose, entries and prompts by identity, settings in words; "[N more fields: diff_revisions with fields=…]" |
| `restore_revision` (checkout + commit), built | `library.write` | `item`, `revision`, `message?` → a new revision with that content |
| `revert_change` (revert) | `library.write` | `item`, `revision` (the one whose change to take back), `fields?`, `message?` → §8.1's steps; on a conflict nothing is written and the result names the fields with both texts, so the assistant can edit them itself |
| `message` on every write | — | `create_card`, `clone_card`, `edit_card`, `edit_lorebook`, `edit_preset`, `restore_revision`, `revert_change` take `message?` (at most 200 characters), the revision's message |

The agent never labels a revision it didn't write (`SetRevisionMessage` stays the user's for others'). The new tools are deferred where the wire defers tools (TOOL-LOADING), under a **Versions** skill, so the immediate tool list and its cache don't grow.

**Build units.** C9.

## 10. Lorebooks and presets

The same model, with their existing tools and diffs:

- **Attach**: Lorebooks… and Presets… in the paperclip menu, drops of their library links, Work on in a workshop in their editors' More menus. An attached lorebook or preset is in view; the model gets it whole up to the inline limit, else a reference with its index, and reads it in pages (§4.3).
- **Classes**: `library.lorebooks` and `library.presets` Ask first, with their wording ("Let the assistant look through your lorebooks?").
- **Change rows**: "Skerry Lore · 2 entries added, 1 changed", "Night preset · 2 prompts changed, Prefill off"; the change view splits by entry and prompt identity (built W7 diffs).
- **Revert** per entry or prompt as a field (§8.1), on top of the built exact-document recipe; an entry or prompt the user deleted since is a conflict.
- **Version tools** as for cards. A preset's or book's revert never re-approves its regex or HTML.

## 11. Stored data

| What | Where | Change |
|---|---|---|
| An attached item on a message | `version_attachments` kind `library`, `ref_id`, `revision_id`, frozen rendering | Additive migration |
| An attached item in a draft | `composer_images` kind `library`, `ref_id` | The same migration |
| Allow in this chat | `workshop_grants (chat, capability, target '', allow)` | None (built) |
| Allow (this reply) | `tool_approvals` answer with `scope: reply`, held on the run | None (prompt JSON) |
| Allow always for [character] | Account setting `workshop.cardGrants` keyed by card entity, user-only, excluded from `change_setting` | A registered setting |
| Allow always | Account setting `workshop.alwaysGrants`, user-only, excluded from `change_setting` | A registered setting |
| The four classes | `workshopCapabilities`, `capabilityDefaults` (Ask first) | Registry entries; `library.read` becomes an alias that existing grants map onto `library.cards` |
| A revert or redo | A revision (origin `user`) and an append-only reversal record with before and after revisions, original effects and affected fields | Additive migration |
| A revision message from the agent | `entity_revisions.message` | None |

## 12. Build units

| Unit | What | Depends on |
|---|---|---|
| C1 | **Built** (workshopcards-u1): New workshop with this card in card menus | — |
| C2 | **Built** (workshopcards-u2): `library` attachments: migration, writer validation (owned, live), assembly (whole or reference with summary); the shared turn budget (§4.3 point 1) built in workshopcards-u2b, chosen at assembly from the pinned revisions rather than stored at send, and without the send-time refusal. In-view derivation moved to C7, the "changed since" tail line to C8 | — |
| C2b | **Built** (workshopcards-u2b): paged reads: `view`, `offset`, `max_tokens` and indexes on `read_card`, `read_lorebook`, `read_preset`. `to_file` moved to C2c | — |
| C2c | `to_file` on the read tools, through the Files write path (quota, versions, undo) | C2b |
| C3 | The paperclip menu in workshops, the multi-select card picker and the lorebook and preset pickers | C2 |
| C4 | `CARD_DRAG` and library links dropped on a workshop composer | C2 |
| C5 | Work on in a workshop (card, lorebook and preset menus; `workshopAttach`) | C2 |
| C6 | Creations in view | C2 |
| C7 | The in-view derivation (story cast and books included), resource classes, view-aware resolution in every library tool, the scoped prompt and its wording, card and always grants with their resolution, the card editor's Extra-tab section and the Settings section, the fixed instruction paragraph | C2, C6 |
| C8 | **Built** (workshopcards-u8): change rows, the change view tab kind, per-open affinity. Not yet: the attached element's "changed since" tail line (needs `libraryView.ts` after the review fixes) | — |
| C9 | `read_revision`, `diff_revisions`, `revert_change`, `message`, the Versions skill | C10's merge |
| C10 | Revert: field and hunk three-way, conflicts in the change view, Redo, Revert all, created-item bin asks, the tail line | C8 |
| C11 | Card files as file attachments (§4.5): recognition, the card tile, the attachment line and note, `read_card_file`, `edit_card_file`, `import_card_file`, lorebook and preset JSON where cheap, the round-trip and end-to-end tests | C2b, C8, C10 |

Every UI unit runs the layout audit at the owner's widths and both themes; C7 is the only one that changes what models are sent by default (it adds the instruction paragraph once), so its parity test records the request bytes before and after.

## 13. Open questions

None. The four questions of the first draft were answered by the owner on 2026-11-24 and are recorded as [D] where they apply: grants are per chat, per assistant card or always, never per model or connection (§2.4); the 8,000-token inline limit with agentic paged reads on reference-harness's model (§4.3); the assistant may change its own personality card (§2.1); a workshop beside a story may read and change that story's cast and lorebooks (§2.1).
