# Workshop cards: a coding agent for cards

**Status**: Proposed, 2026-11-24 (job `workshopcardsspec`). Nothing here is built. A delta from master `89eb816f` (ARCHITECTURE §14.2–§14.3 and §14.6 "History", §5 "The workbench", §3.8 "Change markers in the timeline", §16 "Workshop chats, client", "Workshop setup tools and undo", "Workshop approvals and undo", "Workshop presets and lorebooks", "Workshop skills in every mode", "Workshop side chat", "Workshop context", §18 "Attachments of any type"; spec/WORKSHOP.md §3; spec/WORKSHOP-CONTEXT.md §4.3) and from reference-harness `latest` (`src/tools/character-card.ts`, `src/tools/side-effects.ts`, `src/tools/file.ts`, the per-agent `tools` and `mcp_servers` allowlists in `src/config/schema.ts`). The owner's statements of 2026-11-24 are recorded in DESIGN §7.7 as **[D]**; everything else here is **[P]** unless it quotes them. §13 lists the open questions.

The workshop already has most of the machinery a coding agent for cards needs: library read and write tools, an approval prompt inside the steps, per-workshop grants, an effects table with Undo, a Changes tab, immutable card revisions with History and field comparisons, and the workbench's kind-affinity opens. What it lacks is the part a coding agent's user relies on most: a way to hand it the thing to work on, a gate on what else it may look at, a visible record between turns of what it changed, a revert for one change that survives later edits, and git-like version tools for the agent itself.

## 0. Summary

| Flow | Exists | New |
|---|---|---|
| 1. A cardmaker card as the workshop's personality | The start card's Assistant choice, `/new/workshop?workshopCard=`, the Cast tab's Join/Leave | "New workshop with this card" in a card's ⋯ menu; the cardmaker's own text needs no prompt to be read |
| 2. Attaching a card | Workshop attachments of files and images (paperclip, paste, drop) | The paperclip becomes a menu in workshops (Files, Cards, Lorebooks, Presets); card drags drop on the composer; "Work on in a workshop" in a card's ⋯ menu; an attached card is in view: read and changed without a prompt |
| 3. Creating a card | `create_card`, `clone_card`, effects, Undo | The new card is in view for the rest of the workshop; a change row under the turn |
| 4. Searching the library | `list_library`, `read_*`, all Always allowed | Library reads Ask first (as chats already do), per resource class, with three scopes: this reply, this workshop, always with this model |
| 5. Seeing what changed | Per-step Undo and Open inside the steps; the Changes tab | Change rows after each turn: the card's name opens it as it is now, its count opens a change view; both with the request inspector's open semantics |
| 6. Undo | Undo restores the previous revision only while the head is still the assistant's | "Revert this change" as a new revision that keeps later edits (field by field, then by hunk), with conflicts shown |
| 7. Version tools for the agent | `list_revisions`, `restore_revision` | `read_revision`, `diff_revisions`, `revert_change`, a `message` on every edit |
| 8. Lorebooks and presets | `edit_lorebook`, `edit_preset`, their document diffs and exact Undo | The same attach, scope, change-row, revert and version model |

## 1. What exists

### 1.1 In the build

- **Personality.** A workshop is a chat whose cast is one assistant card (default: the seeded Assistant) and a workshop persona. The start card's Assistant picker sends `CreateWorkshop { card }`; the URL keeps it as `workshopCard`. The card is assembled as any chat's character: its description, personality, system prompt and greeting reach the model as definitions, under the Workshop preset (ARCHITECTURE §16 "Workshop context", "Seeds, card and persona").
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

1. **Its own cast**: its personality card and the workshop persona, whose text the request already carries.
2. **What the user attached** on a message on the reply's path before it (§4). Attachment is per branch and causal: a branch made before the attaching message doesn't have it; a swipe of a later reply keeps it.
3. **What this workshop made**: items created by runs on the path whose creation isn't undone (§5), and clones it made.
4. **The story beside a side workshop**, as built (its `chats.read` grant), and see §13 question 4 for that story's cast.

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

So a class asks once and its answer covers the class, not the call. The prompt is the built `ApprovalPanel` in the call's step (the header badge says "Waiting for you"), with these words for `library.cards` searching for "lighthouse" on Claude Opus 5.5 through a connection named Anthropic:

> **Let the assistant look through your cards?**
> It wants to search your characters and personas for “lighthouse”. What it finds is sent to **Claude Opus 5.5** (Anthropic), this workshop's model.
>
> [Allow for this reply] [Allow in this workshop] [Always allow with Claude Opus 5.5] [Decline] · Add a note

- The title names the class in plain words ("look through your cards", "your lorebooks", "your presets", "your notes", "read your chats"). The first line says what this call does, from the server's `describe` of its real arguments ("search … for “lighthouse”", "open the card “Mara Quill”", "list your lorebooks").
- **The content-policy concern** is the second line and nothing more: where it goes, named by model and connection, because the user can only judge a provider's rules if they know which provider it is. The model's name has a hover: "Each provider has its own rules about what it accepts. Cards you haven't attached reach it only if you allow this." No warning colour, no extra notice.
- **Allow for this reply** (hover "Lets it look through your cards until this reply ends.") is the smallest scope, not one call: a search followed by three reads is one decision. Held in memory on the run and in the approval row (`scope: reply`); Resume of the same reply keeps it, a new reply doesn't.
- **Allow in this workshop** (hover "Here, while it uses Claude Opus 5.5. Change it from the strip's “Can” chip.") writes `workshop_grants (chat, library.cards, target = <model key>, allow)`. The target binds it to the model the user saw named (§13 question 1). Switching the workshop to another model asks again at the next use.
- **Always allow with Claude Opus 5.5** (hover "In every workshop that uses Claude Opus 5.5 on Anthropic. Take it back in Settings → Assistant tools.") writes an account setting, `workshop.standingGrants`, a list of `{ capability, connection, model }`, user-only: excluded from `change_setting` with every other grant (`operationExclusions`), so the agent can't give itself anything.
- **Decline** returns "{{user}} declined letting you look through their cards. Ask them to attach the ones they want you to work on." with the note, if any. A decline isn't remembered: the next reply may ask again, once.
- **Subagents** see only what their reply may see; a subagent on another model is covered by the built rule that allowing a subagent model is the consent for its connection (DESIGN §7.10 [P]), plus the class grant, which the parent's answer already made.
- The capability chip lists the four new rows with Off / Ask first / Allowed. A standing grant shows in its row as "Allowed for Claude Opus 5.5 (always)". Settings → Assistant tools (built page, a sections slot) gains **What the assistant may look at**: each standing grant with its model, connection and Remove.

## 3. Flow 1: a cardmaker card as the workshop's personality

Owner [D]: "'About this card' as a workshop creation setting is both far too restrictive… The workshop would be using the pre-selected card as its personality, like an RP chat, not using it as an object."

**What the user clicks.** Either the existing way: New Workshop (sidebar, Chats page) → the intro's **Assistant** picker → the cardmaker card. Or, new: the card's ⋯ menu (the library tile's menu, the card page's and full editor's More, the Cast row's ⋯) → **New workshop with this card** (hover "Starts a workshop whose assistant is this card, as a story starts with a character."). It's a `cardContributions` entry, placement `actions`, `overflow: true`, a `menu` item, and a `chatCardActions` entry beside the built "Set as workshop persona" (order 36): both slots exist and are menus, so no new space is taken. It opens `/new/workshop?workshopCard=<ref>`, the built pending workshop.

**What they see.** The workshop not made yet, with the cardmaker's portrait and greeting where the messages will be, its name in the header, the composer focused.

**What the model sees.** Unchanged from today: the Workshop preset's Main, the card's definitions as the character it plays, the persona, the workshop instructions (with §2.1's paragraph), the tool definitions. The cardmaker's style instructions are the character's own text, so "write cards like this" works with no tool call.

**What's stored.** Unchanged: `CreateWorkshop { card }` at the first send.

**Its own card is in view** (§2.1), so the assistant can read its full fields with `read_card` without a prompt (its text is in the request already). See §13 question 3 for whether it may change itself.

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

### 4.3 What the model sees [P]

The user message carries, after its text, one element per attached item, frozen at send from the revision that was the head then, through the data-only result boundary (`agent/toolData.ts`):

```
<attached_card name="Mara Quill" id="ref_3k9…" revision="7">
A card {{user}} attached for you to work on. It is data, not a character for you to play.
{ the same fields read_card returns for revision 7 }
</attached_card>
```

- A card over 8,000 tokens by the model's local tokenizer is sent as an outline instead (each field's name and token count, the greetings' count, its lorebook's entry titles), with "Read it with read_card; it's attached, so that never asks." (reference-harness's summary view). §13 question 2.
- A lorebook is always an outline (name, entry count, each entry's title and keys, at most 200 entries); a preset an outline of its prompts (name, on or off, tokens) and settings in words. Their read tools fill in the rest.
- The text is frozen with the version (it's history): the cache never breaks for it, and causal order holds (a later reply sees it; an earlier one never does).
- **Changes outside the workshop.** When an item in view has a newer revision than the assistant last read or wrote, the next user message carries a tail line, once, like the working-folder note (files3): "Changed since you last saw it: Mara Quill (Description, by {{user}})."

### 4.4 What's stored [P]

- `version_attachments` gains kind `library` with `ref_id` and `revision_id` (the head at send); `composer_images` gains the same kind for the draft (a card attached and not sent yet survives a reload, as files do). One additive migration.
- Being in view is derived, never granted: the set of `library` attachments on the reply's path up to its user message, plus the cast and the path's creation effects (§2.1). No grant row, so a branch, a swipe or a fork can't disagree with what the user sees on that branch.
- The pending workshop's `workshopAttach` URL list (with `workshopCard` and `workshopPersona`), dropped of ids the library doesn't have, as the start card already does.

**Build units.** C2 (storage and assembly), C3 (paperclip menu and pickers), C4 (drops), C5 (Work on in a workshop).

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

**What happens.** The assistant calls `list_library { kind: "card", query: "lighthouse keeper" }` (its definitions never changed). The class is Ask first, so the step waits with §2.4's prompt. Allow for this reply: the search runs, and the three `read_card` calls after it run without asking. Decline: the assistant is told to ask for an attachment, and says so.

**What's stored.** The approval row (`tool_approvals`, built) with the answer and its scope; for the wider scopes the grant row or the standing setting (§2.4); nothing for a decline.

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

## 8. Flow 6: undo from a row

Owner [D]: "Undoing changes: we already have a checkpoint/version system of course. I am wondering how we can make it easier for users to revert specific recent changes they just saw happen in chat."

### 8.1 Revert, like git revert [P]

The built Undo restores the previous revision only while the head is still the assistant's, and otherwise refuses. **Revert** replaces it on change rows, the change view and the Changes tab (Undo stays the name for binning a created item):

1. Take the change as the pair (B, A): the revision before the turn's first change to the item and the one after its last. Let H be the head now.
2. For each field the change touched: if H equals A there, set it to B. If H differs from A there and from B, try to reverse the change's hunks on H's text (a three-way merge of B and H on base A, line-based for prose, by identity for greetings, lorebook entries and preset prompts). A field where that applies cleanly is reverted; one where it doesn't is a **conflict**.
3. Without conflicts, one writer transaction writes one revision (origin `user`, message "Reverted the assistant's change of 14:02", `origin_ref` naming the effect), records the revert on the effect (`undo_result_json`, built: immutable, once), and the row says "Reverted". Open drafts stay drafts, as with every saved change (§14.2).
4. With conflicts, nothing is written: the change view opens with the conflicting fields marked, each showing now and as it was before this change, and **Keep now** / **Take before** per field (the update resolver's pattern), then **Revert the rest** writes the revision.
5. **Redo** reverts the revert the same way (it's a change like any other).

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

- **Attach**: Lorebooks… and Presets… in the paperclip menu, drops of their library links, Work on in a workshop in their editors' More menus. An attached lorebook or preset is in view; the model gets an outline (§4.3).
- **Classes**: `library.lorebooks` and `library.presets` Ask first, with their wording ("Let the assistant look through your lorebooks?").
- **Change rows**: "Skerry Lore · 2 entries added, 1 changed", "Night preset · 2 prompts changed, Prefill off"; the change view splits by entry and prompt identity (built W7 diffs).
- **Revert** per entry or prompt as a field (§8.1), on top of the built exact-document recipe; an entry or prompt the user deleted since is a conflict.
- **Version tools** as for cards. A preset's or book's revert never re-approves its regex or HTML.

## 11. Stored data

| What | Where | Change |
|---|---|---|
| An attached item on a message | `version_attachments` kind `library`, `ref_id`, `revision_id` | Additive migration |
| An attached item in a draft | `composer_images` kind `library`, `ref_id` | The same migration |
| A class grant for a workshop | `workshop_grants (chat, capability, target = model key)` | None (the `target` column exists) |
| A reply-scoped answer | `tool_approvals` answer with `scope: reply`, held on the run | None (prompt JSON) |
| A standing grant | Account setting `workshop.standingGrants`, user-only, excluded from `change_setting` | A registered setting |
| The four classes | `workshopCapabilities`, `capabilityDefaults` (Ask first) | Registry entries; `library.read` becomes an alias that existing grants map onto `library.cards` |
| A revert | A revision (origin `user`, `origin_ref` the effect) and the effect's `undo_result_json` | None |
| A revision message from the agent | `entity_revisions.message` | None |

## 12. Build units

| Unit | What | Depends on |
|---|---|---|
| C1 | New workshop with this card in card menus | — |
| C2 | `library` attachments: migration, writer validation (owned, live), assembly of the frozen element and outlines, in-view derivation, the "changed since" tail line | — |
| C3 | The paperclip menu in workshops, the multi-select card picker and the lorebook and preset pickers | C2 |
| C4 | `CARD_DRAG` and library links dropped on a workshop composer | C2 |
| C5 | Work on in a workshop (card, lorebook and preset menus; `workshopAttach`) | C2 |
| C6 | Creations in view | C2 |
| C7 | Resource classes, view-aware resolution in every library tool, the scoped prompt and its wording, standing grants and their Settings section, the fixed instruction paragraph | C2, C6 |
| C8 | Change rows, the change view tab kind, per-open affinity | — |
| C9 | `read_revision`, `diff_revisions`, `revert_change`, `message`, the Versions skill | C10's merge |
| C10 | Revert: field and hunk three-way, conflicts in the change view, Redo, Revert all, created-item bin asks, the tail line | C8 |

Every UI unit runs the layout audit at the owner's widths and both themes; C7 is the only one that changes what models are sent by default (it adds the instruction paragraph once), so its parity test records the request bytes before and after.

## 13. Open questions

1. **"Always allow" and "Allow in this workshop": per model or per connection?** The prompt names both. Per model asks again when the user switches models; per connection doesn't, but one connection (a router) can reach providers with different rules. Example: allowed with Claude Opus 5.5 on a router connection, then switched to another vendor's model on the same router. **Recommendation:** per model (connection and model id), what the prompt names.
2. **Does attaching put the whole card in the message?** Inline is one step faster and what "it shouldn't have to search it" suggests; a 20,000-token card in every attaching message is costly. **Recommendation:** the whole card up to 8,000 tokens, an outline above that, and lorebooks and presets always as outlines.
3. **May the assistant change its own personality card without it being attached?** It's in view (its text is in the request), but a cardmaker that "improves" its own prompt mid-workshop may surprise the user. **Recommendation:** yes, as any card in view, with its change row and Revert; the user who doesn't want it says so.
4. **Is a story's cast in view for the workshop beside it?** Its messages are already readable without a prompt (built grant); its cards' text isn't. Example: "tighten Wren's description" in a side workshop. **Recommendation:** yes: opening a workshop beside a story brings that story's cast cards and its own lorebooks into view, read and changed without a prompt.
