# Where the build copied ST instead of the design

**Status**: Audit and proposal, 2026-10-16. Everything under "Corrections" is **Proposed**; nothing here is Decided until the owner confirms it.

## Why this exists

The owner, 2026-10-16: "it also clearly has adopted too many things from ST that go against the actual design. The objective was not to clone ST, ST fucking sucks." They won't use the app until it is clearly better than ST, because once they do, wiping the data folder and re-importing stops being an option.

**How it happened.** After the 2026-10-14 "unusable" verdict, the process said "ST's reachability is the minimum". Rounds R2–R5 then took [ST-COMPARISON.md](ST-COMPARISON.md) (a list of places that are "worse than ST") as their to-do list, and several units copied ST's concepts to close a gap instead of building the design's answer to it. ST is a floor for what you can do and how quickly you can reach it. It is never a source of concepts, structure or labels.

Method: two read-only code audits (chat side; library, settings and context side) against [DESIGN.md](DESIGN.md), [OVERVIEW.md](OVERVIEW.md) and the owner's planning messages of 2026-10-09. The deepest claims were spot-checked in code.

## Findings, deepest first

### Context assembly

1. **ST-compatible assembly is the hidden default for every one-character chat.** `modeOf` (`server/src/assembler/stages.ts`) picks ST mode whenever a chat has one character, no layout set and by-writer roles. In that mode cards are concatenated by field, lore goes to ST's positions above the history, and there's no tail directive. Adding a second character switches the whole layout, so the next send rewrites the cached prompt. The This chat tab meanwhile shows "All cards together" as selected; only the run inspector says "SillyTavern-compatible". Contradicts §5.2 [D] (labelled blocks by default), §1.3 [P] (lore never above the history) and §5.3 [P]. It also breaks "nothing changes silently".
2. **The tail directive is ST's group nudge.** It reuses the preset's `group_nudge_prompt` and `impersonation_prompt`, so with no nudge in the preset there's no directive, and it never names who not to write for. Contradicts §5.3 [P].
3. **Every layout gets ST's empty author's note at depth 4**, and notes are ordered by ST's extension-prompt rank in every layout, not only in ST mode.
4. **Two silent drops in our own layouts.** A card's system prompt and post-history instructions are sent only in ST mode, though the editor says "used where the preset allows them". Card modules can be edited, with a placement, but the assembler never reads them, so they are never sent.
5. **Lorebook activation is a port of ST's World Info engine**: scan depth, recursion, delays, inclusion groups, probability, budgets, with defaults that "follow a fresh ST install". Imported books must work, so keyword matching as the fallback is fine. Missing: retention until the next compaction boundary (§1.3 [P]; the block is re-evaluated every turn, so it changes every turn), and the decision-model and agent-lookup sources (§1.3 [D]/[P]).

### Notes

6. **A card's first note is ST's Character's Note and is on in every chat.** "First" means the lowest entity id, so the first note a user writes on a native card turns itself on everywhere. Contradicts §4.1 [D]: notes travel with the character "but **not activated in other chats automatically**". Only an imported `depth_prompt` should behave like this, and only because the compatibility contract requires it.
7. **Notes are ST's author's note with extra owners.** They have an `author_note` kind and "top/bottom of the author's note" placements; the only condition is ST's `note_interval`; owners are only card and chat (no persona, no global); new notes default to ST's depth 4. The UI says "A note here is like ST's author's note." The design's conditions ("only on that character's turn", while present, decision model) aren't built (§4.1 [D]/[P]). A depth-0 tail is the design's default home for changing information (§5.5 [D]).

### Chats, groups and the composer

8. **"Groups" are back as a concept.** `/groups/$chatId` and `/groups/$chatId/new`, group tiles with "Group · N" badges on the home grid, a Groups filter, a group page with "Rename group", and the RPCs `ListChatGroups`, `ListGroupChats` and `RenameGroup`. A group is "the chats with the same title and the same cast", so the title carries an identity: renaming one chat moves it out of its group (the rename dialog warns about this), and Rename group rewrites every chat's title. R2-A built it "because ST shows them there". Contradicts §2.1 [D] and the owner's words: "we won't have 'group chats', we'll have chats with any number of cards". No group table exists, so this is reversible.
9. **Home is ST's character grid, and chats start from a card or a group.** `/` is "Characters"; the sidebar's New chat goes there. A chat with several cards can only start from an existing group (in practice an imported one) or by adding cast members one by one afterwards. §2.1 [P] makes the chat list the home screen (also on phones) plus a library. §2.1 [D] keeps one click from the grid into a conversation, so the grid itself is fine; making it the home screen is the ST choice.
10. **Every member greets, with a random greeting, "as ST starts a group chat"**, and each greeting becomes a stored message. Nothing in the design asks for this. §2.1 [P] shows the greeting, with alternates selectable.
11. **ST's group reply order.** "Reply from", "Next in turn: X, after Y", "Back to turn order" (a round-robin over join order), and an empty Send triggers a reply "as an empty send does in ST". The design's composer has two actions: Send as X and Generate X (§2.2 [P]). Who runs on a turn belongs to orchestration modes and decision models (§7.1, §7.6), not a turn-order widget.
12. **Generate X was split back into ST's reply versus impersonate.** ST-COMPARISON called the design's behaviour a bug ("Plain Generate writes the selected persona"), and R2-B relabelled it. The design: "Impersonation is just Generate for a character you play" (§2.2 [P]).
13. **Names.** Imported chats keep ST's file name as their title; native chats are titled "Karen, 16 Oct" or "Karen & Persona". §2.1 [P]: "never just the first character's name". A persona has no card page ("It may be a persona"), against §2.2 [D] (a persona is a card in a folder). Presence is "ST's mute": cards stay in the context. §3.5 [D] allows this for manual presence, but the switch reads "Present" whatever its state.

### Presets and the library

14. **The app default is "SillyTavern's default preset"**, and the scope chain is role → chat → connection → user → built-in. The chat-kind level, card overlays (§6.3) and the composer strip showing the active preset and its source (§6.1 [P]) are missing.
15. **Presets and lorebooks have no chat layer.** Editing from a chat changes them everywhere, as in ST, and there are no per-chat prompt toggles. §4 [P]: the same three layers for cards, presets and lorebooks. Lorebook entries can't be edited at all yet.
16. **Variants are listed flat**, one row each, not grouped under one character (§4 [P]). Promoting a chat override to a variant has a server operation but no button.

## What already follows the design

Speaker always visible, with Members / Personas / All cards tabs, recent speakers and joining on pick; composer text with Generate as a one-turn direction; queued sends; a composer per branch; versions on every message, "Write your own version", failed generations as versions, explicit branches; chat state as events on the graph; stable `{{char}}`/`{{user}}` bindings (in our layouts); card page with Continue, New chat and all chats as peers; pending chats; Never used; recents by last message; card edits from a chat scoped "Only in this chat" or "Everywhere (used by N)"; connections without profiles, a base URL on every kind; server drafts, revisions, History, three-way merge on re-import; the ST import mapping itself.

## Corrections (Proposed)

A correction round, built and walked through on the realistic synthetic data before anything else:

1. **Assembly.** Make the layout always explicit and shown: ST-compatible becomes one named layout, the default for chats imported from ST (§8.1 [O] proposes "an imported chat sends what ST sent") and never picked silently by cast size. New chats use the design's labelled blocks. The tail directive names the speaker and who not to write for on its own, using the preset's prompts only when they exist. No phantom author's note outside ST mode. Send card system prompts and post-history instructions in our layouts (where the preset's markers allow them), and send card modules at their placement.
2. **Notes as the design's object.** Owners: card, chat, persona, global. Conditions: always, on this character's turn, while this character is present (decision model later). A card's notes are off in other chats unless imported from `depth_prompt`. New notes default to the tail. Stash = off without loss (already true). No "author's note" kind or ST labels in the UI; imported author's notes become ordinary chat notes at their depth.
3. **Chats, not groups.** Remove group tiles, group pages and the three group RPCs. Home is the chat list, recent first by last message, each chat with its cast collage; the character grid moves to the library and keeps one click into a conversation. New chat picks any number of cards up front. Titles are generated from the chat (not the first character's name) and renaming never changes anything else.
4. **Composer.** Send as X and Generate X only. Remove the turn-order widget and the empty-Send reply; choosing who replies is choosing the speaker. Greetings: the pending chat shows the chosen card's greeting with alternates selectable, not every member at random.
5. **Presets.** The composer strip shows the active preset and where it comes from. Per-chat prompt toggles as state events (the chat layer for presets). Rename "SillyTavern's default preset" to the app default.
6. **Lorebooks.** Keep keyword matching as the fallback; keep the tail block's entries until the next compaction boundary so it stops changing every turn; entry editing.
7. **Library.** Variants grouped under one character; a Promote button for chat overrides.
8. **Strings.** No "ST's …" in user-visible text except in import reports and the ST-compatible layout's own description.

**ST-COMPARISON items not to build as written:** #2 (ST's Natural/Pooled/Auto group modes; orchestration modes replace them), #14 (group names), #15 (every member greets), #23–#24 (move messages, range delete; keep only if the owner wants them), #27 (ST extension actions, out of scope per §1.5). #7 becomes the notes work above, not a lighter single author's note.

## Decisions for the owner

- **Home screen:** the chat list (DESIGN §2.1 [P], recommended) or the character grid.
- **Groups:** remove the concept (recommended), or keep a saved cast as a shortcut for starting chats with the same characters.
- **Imported chats' layout:** ST-compatible by default, so an imported chat sends what ST sent (recommended), or the design's layout from the first send.
