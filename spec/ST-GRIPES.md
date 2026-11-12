# ST gripes: the checklist

**Status**: Draft, 2026-10-14. Step 1 of the afternoon schedule in PLAN.md, and the checklist the next redesign round works from (WORKFLOW process step 1). F12 binding controls are built (U09, 2026-10-28; ARCHITECTURE.md §15), superseding that gap.

**How it was built.**
- **The owner's words** come from three places:
  - the 41 messages the owner typed in the planning conversation of 2026-10-09 (`76def34e-….jsonl`, read with the Read tool, only `type: user` entries of human origin; subagent reports and tool results skipped)
  - DESIGN.md §2, §3, §4, §5.5, §6.2, §7.4, §8 and §10
  - the owner's verdict of 2026-10-14 in PLAN.md
- **Each status** comes from reading `packages/client/src` (routes, the shell, the chat page, its header, messages, composer, side panel and its tabs, the home grid, card and group pages, the editors) and ARCHITECTURE.md at commit 21ff8ed.
- **No walkthrough yet.** This is **not** yet the walkthrough on the realistic data with screenshots that process step 2 asks for. A status says whether a surface exists and what the code does. It doesn't say the surface is usable. "Has" items still need that walkthrough before they count as done.

**Sources.**
- **P hh:mm**: the owner's planning message of 2026-10-09 at that time (UTC).
- **V**: the owner's verdict of 2026-10-14 (PLAN.md).
- **D §n**: DESIGN.md, with the item's mark ([D], [P], [L]).
- **PLAN f/u**: a PLAN.md follow-up.

**Statuses.**
- **has**: a surface exists, named in the table.
- **partial**: something exists, and the table says what's missing.
- **missing**: nothing exists.
- **(later)**: deferred in DESIGN or waiting on agentic mode. These items are ranked last.

---

## 1. Chat list and home

| # | Owner's words | Source | Status | Where / what's missing |
|---|---|---|---|---|
| A1 | "You can *only have 1 chat with 1 character at a time*" | P 13:58, D §2.1 [D] | has | Card page `/cards/$entityId`: Continue, New chat, and all its chats as peers |
| A2 | "you click on a character in your character grid, and immediately jump into the conversation" | P 14:09, D §2.1 [D] | has | Home grid `/`: a click continues the latest chat or opens the pending chat; definitions in the Cast tab |
| A3 | "There's no way to even peek a character without doing this" | P 14:09, D §2.1 [D] | has | Inspect on each tile → card page with its definition |
| A4 | Opening a card must not create a chat | D §2.1 [D] | has | `/cards/$entityId/chat` is a pending chat, saved on the first send |
| A5 | "that marks it as 'just opened' which swaps their order in the search results" | P 13:09, D §2.1 [P] | has | Home sort "Recent" and the chat list both go by last message |
| A6 | "filter cards by 'never used' (something really basic which ST somehow cannot do)" | P 15:58, D §2.1 [D] | has | Home grid: "Never used N" filter |
| A7 | The chat list "dumps a full list of what looks like individual branches of chats … titles like Karen - 2026-05-11@07h51m55s691ms" | V | has | ST branch files import into one chat's graph; readable names with start dates (`chatName`) |
| A8 | Group chats' "name is the name of the first character"; editable titles | P 13:58, D §2.1 [P] | has | Editable header title; Rename group on its page updates all its chats. Renaming one chat explains its move to a tile under the new name (R4-D) |
| A9 | "their thumbnail is a 2x2 with the first 4 … (which isn't a bad idea in itself)" | P 13:58, D §2.1 [P] | has | `GroupFaces` collage on group tiles; `AvatarStack` in the header and chat list |

## 2. Chat view and messages

| # | Owner's words | Source | Status | Where / what's missing |
|---|---|---|---|---|
| B1 | No way to "tell which card, chat or branch you're looking at, even worse for groupchats" | V | has | `ChatHeader`: the cast's faces, the chat name, start date, "Branch k of n" menu |
| B2 | "no way to inspect or edit a card from the chat" | V | has | Cast tab: Show card (definition inline), Edit (this chat only or everywhere) |
| B3 | "chat settings are a modal (ST uses a side panel beside the chat)" | V | has | Side panel: Cast, This chat, Lorebooks, Notes, Summaries; a sheet on phones; the tab is in the URL |
| B4 | "you cannot read card defs of group members while generation is going on" | P 15:58, D §10.1 [D] | has | Nothing locks during generation; Cast tab works while replies stream |
| B5 | "Nothing about the current view is reflected in the URL. Refresh gets you back to the same page" | P 15:58, D §10.1 [D] | has | `/chats/$id?slot=&leaf=&panel=`; Copy link on each message |
| B6 | "Two tabs of ST conflict" | P 15:58, D §10.1 [D] | has | Each write carries a version check; tabs work side by side |
| B7 | "if a swipe fails, it just disappears" | P 15:47, D §3.1 [D] | has | A failed version gets a "failed" badge and its error class and message; refusals get "Retry with…" |
| B8 | Imported chats show "every message as not in context with no reason" | V, D §5.5 [D] | has | Hidden / Summarized / Out of context marks with reasons in tooltips; a history divider with the budget |
| B9 | "being able to see the reasoning/agentic steps and intermediate output (in any mode) live as they come should be default" | P 15:30, D §7.4 [D] | missing | Streamed reasoning isn't kept or shown (ARCHITECTURE §15: "Reasoning the model streams isn't kept") |
| B10 | Rollout steps "get compacted into something that expands when I click it" | P 15:19, D §7.4 [D] | missing (later) | Agentic mode isn't built |
| B11 | "if the LLM emits a variable, like {{user}}, it should *not be substituted*" | P 16:26, D §5.6 [D] | has | Model text renders verbatim; only template text (greetings) resolves |
| B12 | "I definitely want HTML rendering to be possible", recent and old messages shown differently | P 16:26, D §10.2 [D] | missing | Messages are sanitized Markdown; no sandboxed HTML, no rich and compact forms |
| B13 | Display regex as display rules; output substitution as an opt-in display rule | D §1.2 [P], §5.6 [D] | partial | Regex scripts are editable in the preset editor ("display only"). Nothing in the chat view applies them |
| B14 | "the ability to resume a stopped or broken agentic rollout mid-air, without sending another turn" | P 12:24, D §7.5 [D], §3.1 [P] | missing | A stopped or interrupted reply shows a badge; **no Continue** to extend it (ST's Continue) |
| B15 | "some kind of UX to 'ping' the user (not necessarily with sound but maybe also that)" | P 15:58, D §10.1 [D] | partial | Unseen badges in the chat list, tab title and favicon, optional system notification (Settings → Notifications). No sound; no web push |
| B16 | "That literally just requires the agentic loop happen on the server" (a generation survives closing the tab) | P 12:22 | has | Generation runs on the server; the reply streams into whatever tab opens the chat |

## 3. Versions (swipes), edits and branches

| # | Owner's words | Source | Status | Where / what's missing |
|---|---|---|---|---|
| C1 | "I want to be able to swipe any message. Honestly, even past ones." | P 14:43, D §3.1 [D] | partial | Replies at any depth have Regenerate and `‹ n/m ›`. **Messages on your side (yours, or a model-written turn of a character you play) get no Regenerate or "generate another" arrow** (`Message.tsx`: `model = side === "assistant"`); only Write your own version or Edit |
| C2 | "swipe a previous message *without* affecting what is causally after it" | P 15:01, D §3.1 [D] | has | Regenerate or select a version in place; the continuation stays |
| C3 | "generate an extra sacrificial swipe that gets internally 'edited' away" | P 15:01, D §3.1 [D] | has | ⋯ → Write your own version |
| C4 | "saving an edit of an LLM-generated message saves the new version as a new 'swipe'" | P 15:01, D §3.1 [D] | has | Edit of a generated version adds an "edited" version; your own versions amend |
| C5 | "it would be nice to have a convenient scratch pad for this internally, instead of using notepad" | P 15:01, D §3.1 [D] | has | Write your own version keeps the version shown above it, with Add selection to your version and Add to your version; snippets add to it too; Add as a new version (built 2026-11-06, ARCHITECTURE §12) |
| C6 | "generate 10, 20, even 50 versions of it" | P 15:01, D §3.1 [P] | partial | The version menu lists every version with a two-line preview. No star, hide, or side-by-side compare; 50 versions is a long radio list |
| C7 | "press the button again while a swipe is genning"; "the generation stop button belongs on the swipe" | P 16:05, D §3.1 [D] | has | "Generate another version" works while one generates; Stop is on the version's header |
| C8 | "generating with different models and upstreams at the same time is a must" | P 16:05, D §3.1 [D] | partial | Different chats can use different models (This chat → Model). Within a chat, another model only via "Retry with…" on a refusal; **no per-swipe model choice** |
| C9 | "protection against accidentally deleting text … chrome's built-in undo … doesn't help if you refreshed" | P 15:01, D §6.2 [D] | partial | Composer: server draft plus "Earlier text" history. Message and summary editors keep server drafts but have **no history to restore from** (PLAN f/u) |
| C10 | "This makes me branch at the latest message every time I want to edit the author's note, as a checkpoint" | P 13:23, D §3.4 [D] | has | Notes, cast, model, preset and layout changes are state events "from the latest message on, on this branch" |
| C11 | A branch is an explicit fork, never a side effect of swiping | D §3.2 [D] | has | ⋯ → Branch from here; branch arrows on the forking message; header branch menu |
| C12 | "if you want to consult an old branch … it means opening it, copying parts, and then going back" | P 15:58, D §10.1 [D] | has | A branch has a URL (`?leaf=`); open it in another tab |
| C13 | Branches are deletable like messages and swipes | D §6.2 [D] | has | Header branch menu names/renames each shown branch and deletes it to the bin with Undo (R4-D) |
| C14 | Deleting a single swipe is the normal, most available delete | D §6.2 [D] | has | Trash icon = Delete version; ⋯ → Delete message (all versions); toast to the bin |
| C15 | "two parallel forking and merging chat threads … send a message to both at the same time" | P 16:05, D §3.3 [D] | missing (later) | Architecture only; the UX comes later |

## 4. Composer and speakers

| # | Owner's words | Source | Status | Where / what's missing |
|---|---|---|---|---|
| D1 | "the UI inexplicably doesn't actually tell you what persona is currently selected" | P 14:43, D §2.2 [D] | has | Speaker pill at the composer's left with avatar and name |
| D2 | "If you have more than one persona in a chat, switching between them is extremely miserable" | P 14:43, D §2.2 [D] | has | Switcher (Members / Personas / All cards) plus up to 3 recent speakers, one tap each |
| D3 | "personas, members, and other cards would be tabs … It would remember the last one you picked" | P 16:10, D §2.2 [D] | has | Switcher tabs; the last tab is remembered |
| D4 | "I want to be able to use a *card* as my *persona* … impersonate any card in my chat any turn" | P 14:43, D §2.2 [D] | has | All cards tab, Cast → Write as; a card not in the chat joins it |
| D5 | "I want the harness to be able to write for 'my' persona because I might not be playing it" | P 14:43, D §2.2 [D] | has | Generate with your speaker selected: a real generation of their turn |
| D6 | Impersonation: "there's no natural way to 'swipe'" | P 14:43, D §2.2 [P] | partial | Same cause as C1: the impersonated turn has no Regenerate or arrows on the message; only the composer's "Regenerate the latest reply" at the tip |
| D7 | "add a summary of what the next turn should do … I have to remove it next turn" | P 14:43, D §2.2 [P] | has | Generate with text = one-turn direction, shown as "Direction:" on the reply |
| D8 | "realizing when the avatar shows up next to the message, that I got the wrong persona" | P 14:43, D §2.2 [D] | partial | The speaker shows, but **the choice isn't kept**: reopening or reloading the chat resets it to the first card you play (`speaker.ts`, memory only), the kind of silent reset the owner called a "rugpull" |
| D9 | Sending while a reply generates queues | D §2.2 [D] | has | Queued list above the composer; edit or withdraw |
| D10 | "The composer belongs to a branch"; a half-typed message waits months | D §6.2 [D] | has | Composer drafts per branch tip, on the server |
| D11 | Attach images by drag and drop, paste, a picker; "find the right button in a submenu" is the anti-pattern | D §10.2a [D] | missing | The composer has no attachment control (the server stores version attachments) |
| D12 | Cache-warmth indicator near the composer with a countdown that can be turned off | P 16:08, D §5.5 [D] | has | `CacheIndicator` above the composer: warm/cold/rewrite, countdown, Hide countdown |

## 5. Group chats

| # | Owner's words | Source | Status | Where / what's missing |
|---|---|---|---|---|
| E1 | "we won't have 'group chats', we'll have chats with any number of cards" | P 12:53, D §2.1 [D] | has | Cast → Add character; the switcher's All cards adds a card too |
| E2 | Groups are made by "promoting it' into a groupchat which copies it and changes it irreversibly" | P 13:58 | has | Adding a character joins from the latest message on; no copy |
| E3 | "One of my biggest gripes with ST is its handling of group chats, and personas in relation to them" | P 12:53 | partial | Group tiles on home, group page, New chat for a group (R2-A/B). Gaps are E4, E5, A8 and D8 |
| E4 | Who replies next (ST's group reply order and per-member trigger) | P 12:53, PLAN f/u (R2-B) | partial | **Send always gets the first present character you don't play** (`replySpeaker` in `cast.ts`); plain Generate with your persona selected writes your persona. Another character needs Cast → Speak now, or switching the speaker first. No turn order, no "next speaker" choice at the composer |
| E5 | A new group chat starts with each member's greeting, as ST does | PLAN f/u (R2-B) | has | Every member greets in order, with random initial choices as in ST and independent alternate greeting controls; previews survive the first send (R4-D) |
| E6 | "kind of like how chars can be muted in group convos in ST" | P 13:42, D §3.5 [D] | has | Cast → Present switch per member (state event, per branch) |
| E7 | Presence set by tool, decision model, or `send_message` argument | P 13:42, D §3.5 [D] | missing (later) | Manual only |
| E8 | "it also concatenates cards *by field* rather than making them sequential" | P 13:36, D §5.2 [D] | has | This chat → Card layout: all cards in labelled blocks, or speaker's card last |
| E9 | "we might want to deliberately alternate user-assistant turns in the chat history" | P 14:43, D §5.4 [P] | has | This chat → Roles: by writer, alternating, by perspective |
| E10 | One agent per character, seeing only the periods it was present | P 13:36, D §7.1 [D] | missing (later) | Plain generation only |

## 6. Cards, variants and personas

| # | Owner's words | Source | Status | Where / what's missing |
|---|---|---|---|---|
| F1 | "a different chat premise needs some changes, and I can't break it for existing chats. My only option is to duplicate it" | P 13:09, D §4 [D] | has | Cast → Edit → Only in this chat (a chat override, from the latest message on) |
| F2 | "you cannot even rename a card during duplication, or add a subtitle to it" | P 13:09, D §4 [D] | has | Editor → Make a variant (label and subtitle); Rename |
| F3 | "name == name in chat, which means you can't just name a card Stacy V2" | P 13:09, D §4 [P] | has | Library label and subtitle apart from the in-chat name; the card page says "In chats as …" |
| F4 | "it's genuinely difficult to tell which is which" (duplicates) | P 13:09, D §4 [D] | partial | Variants are listed only in the editor's header. The home grid has one tile per character and the card page lists no variants or which chats use which |
| F5 | Chats point to a variant | D §4 [P] | partial | The Cast tab says when a chat uses a variant, but there's no control to switch a member to another variant; Edit offers only "this chat" or "everywhere" |
| F6 | "Users expect that editing a card will change it everywhere … the UI must be designed to make it clear" | P 13:23, D §4 [D] | has | Edit dialog: Only in this chat / Everywhere (used by N chats); editor header "used by N chats" |
| F7 | "cards often need to change (in a non-additive way) as the story progresses" | P 13:23, D §4 [D] | has | As F1: this chat's own version, from the latest message on, on this branch |
| F8 | "I would treat them as 'cards in a special folder'" | P 16:05, D §2.2 [D] | has | Library → Persona switch per card; switcher's Personas tab |
| F9 | "when it becomes a persona, the image is usually unrecognizably blurry" | P 14:43, D §1.4 [P] | has | Imported personas keep their original avatar; any card is a persona by the switch |
| F10 | "My persona list has become extremely bloated from having single-chat specific personas that are copies of their card(s)" | P 14:43 | has | Cast → I play them, on any member; no copy needed |
| F11 | "{{user}} in greetings in ST often sticks so if you open a card and then change persona, it actually keeps the old name" | P 14:12, D §5.6 [D] | has | Greetings resolve against the state at their position until a message follows (`TemplateText`) |
| F12 | "having control over these variables, being able to override them and keep them fixed" | P 14:43, D §5.3 [D] | has | This chat → Prompt names shows resolved `{{user}}` and `{{char}}`; pin the current value or an override, or unpin to follow the cast/personas (U09) |
| F13 | "There isn't even a way to search (never mind search and replace) within chats or presets or cards" | P 13:23, D §6.2 [D] | has | Editor → Search: plain or regex, replace, across all fields of one card or preset. Library → Search and replace: every card, lorebook, preset and note at once, one undoable replace (2026-11-12, ARCHITECTURE §14.6). Message text across all chats from the left panel (§12) |
| F14 | "UI gripe #1, it appears to be designed to confuse you in how and when edits are saved" | P 13:23, D §6.2 [D] | has | Editors keep drafts per field; Save (n) makes a revision; a status line says "Everything is saved" or "n fields have changes" |

## 7. Notes (author's notes, character notes)

| # | Owner's words | Source | Status | Where / what's missing |
|---|---|---|---|---|
| G1 | "something like author's notes, but multiple, and per-character" | P 13:23, D §4.1 [D] | has | Notes tab: the chat's notes, then each character's; New note |
| G2 | "possible to have at the end as a tail or earlier" | P 13:23, D §4.1 [D] | has | Note placement: in the chat at a depth, at the end, or a section |
| G3 | "it can't automatically only show on that char's turn (for group chats)" | P 13:23, D §4.1 [D] | missing | Note conditions aren't built (`docs/note.ts`: "Other owners and conditions arrive with the assembler") |
| G4 | "you can't stash it anywhere if it needs to be off or changed" | P 13:23, D §4.1 [D] | has | A switch per note, from the latest message on, on this branch |
| G5 | Outfits "should travel with it between chats, but not apply to other chats automatically" | P 13:23, D §4.1 [D] | has | Card-owned notes; only a card's first note is on by default |
| G6 | Extended prompts "which may not be intended to export" | P 13:09, D §4.1 [D] | has | Note editor: "Exported with the card" |
| G7 | "I use ANs constantly, in every chat" | P 12:53 | has | Notes tab → New note (depth 4, system, like ST's AN). Two clicks from the chat; walkthrough needed |

## 8. Lorebooks

| # | Owner's words | Source | Status | Where / what's missing |
|---|---|---|---|---|
| H1 | "every library lorebook gets a switch" | V | has | Lorebooks tab: only those attached and the members' own, plus Add |
| H2 | A card's lorebook used automatically; each chat can turn it off | D §1.3 [D] | has | Lorebooks tab switch per card lorebook |
| H3 | Lorebooks layered and editable like cards and presets | D §4 [P] | missing | "Lorebooks can't be edited here yet" (EditorPage) |
| H4 | "Jev can decide things like whether a lorebook is included" | P 12:53, D §1.3 [D] | missing (later) | Keyword activation only |

## 9. Presets, connections and settings

| # | Owner's words | Source | Status | Where / what's missing |
|---|---|---|---|---|
| I1 | "the preset dropdown says 'The default preset' instead of the current one" | V | has | This chat → Preset: the name in effect and where it comes from |
| I2 | "the preset isn't truly global, but it's not clear what context it belongs to" | P 15:30, D §6.1 [D] | has | Chat / connection / your default / ST's built-in, said in This chat |
| I3 | "presets are inexplicably tied to connection profiles"; "a connection has a field for 'preset override'" | P 15:47, D §9 [D] | partial | Decoupled. The override is honored and named in This chat, but **no control sets it** (the connection screens only pass it through) |
| I4 | "Importing a new version of the same preset means having to edit these things each time" | P 13:23, D §4 [D] | has | Editor → "Review the update" with merge and conflict resolver |
| I5 | "ST's internal editing is awful" | P 13:23 | has | Preset editor: prompt list, switches, reordering, search and replace, history. Not walked through |
| I6 | Toggling preset prompts for this chat (ST: one click in its panel) | D §3.4 [P] "preset switches and toggles" | partial | A prompt's switch is only in the preset editor, and saving changes the preset everywhere. No per-chat toggle |
| I7 | "having a preset switch for different cards … 'you can impersonate' for a narrator card" | P 14:09, D §6.3 [P] | missing | No per-card preset overlays |
| I8 | Connections, not profiles; "we'll just have every URL overrideable" | P 15:47, P 16:16, D §9 [D] | has | Settings → Connections: one kind per connection, Base URL on every kind |
| I9 | "ST doesn't fetch model lists from 'native' providers … doesn't allow editing the list" | P 15:47, D §9 [D] | has | Connection → models: refresh from upstream, add and edit models |
| I10 | "Separate users. Even ST has that" | P 17:24, D §10.1 [D] | has | Settings → Users (admin) |

## 10. Context, inspector and summaries

| # | Owner's words | Source | Status | Where / what's missing |
|---|---|---|---|---|
| J1 | "showing the entire chat as it was written as a single stream is misleading to what is actually being sent" | P 15:06, D §8 [D] | has | LCM boundary divider, coverage rail, Summaries tab, the history divider |
| J2 | "an inspector that also lets you see the exact assembled context for *that specific run*" | P 15:19, D §7.4 [D] | has | ⋯ → Context it was generated from (`/chats/$id/context/$versionId`) |
| J3 | The exact assembled request before sending ("the request preview says so") | D §8 [P], §1.2 [P] | partial | Only past runs. This chat shows the next reply's model, preset and budget, but nothing shows the next request's content |
| J4 | "an indicator near the composer that shows if a model's cache is likely warm" | P 16:08, D §5.5 [D] | has | D12; plus "Cache rewrite" when an edit changed the prefix |
| J5 | Hidden run from message 0: "propose to unhide them" | P 17:19, D §1.4 [D] | has | Enable summaries dialog offers keeping the imported summary or unhiding |
| J6 | The manual workflow: "a script that hides messages 0 to N … I always have the summaries in context" | P 13:04, D §8 [D] | has | Summaries (LCM) per chat, summarizing through the chat's preset; Summaries tab to read and edit |

## 11. Phones

| # | Owner's words | Source | Status | Where / what's missing |
|---|---|---|---|---|
| K1 | "it must also work well from phones (although we don't need to get the responsive UI work perfectly from day 1" | P 12:19, D §10.1 [D] | partial | Phone bar, Chats page, the panel as a sheet, tap for message actions, swipe gesture between versions. Never used on a phone by the owner; no web push |

## 12. Other

| # | Owner's words | Source | Status | Where / what's missing |
|---|---|---|---|---|
| L1 | "We should allow for any number of chats to be running gens at any time" | P 15:58, D §10.1 [D] | has | Generation per chat on the server; open another chat meanwhile |
| L2 | "Search and replace for example: replacing a character name because I want to change it" (whole chats, summaries included) | P 16:26, D §10.3 [D] | missing | Chat search finds titles and character names only; no search in messages; no chat-wide replace or changeset |
| L3 | Agentic chat edits: "You should be able to inspect and revert the changes" | P 16:43, D §10.3 [D] | missing (later) | |
| L4 | Agent mode with "the UX distinction obvious while keeping the UI relatively unified" | P 15:30, D §7.7 [D] | missing (later) | |
| L5 | "use the agent to modify/import presets and configurations" | P 13:04, D §12 [L] | missing (later) | |
| L6 | "take an ST folder, find the chats, and have them and their cards all seamlessly be added" | P 12:19, D §1.4 [D] | has | Import → SillyTavern (folder scan, report, chats to link) |
| L7 | "detect empty chats that only have the greeting and zero user turns during import, and not import them" | P 15:58, D §1.4 [D] | has | Skipped and counted in the import report |

---

## Counts

111 items in total:

| Status | Items |
|---|---|
| has | 73 |
| partial | 21 |
| missing | 17, of which 8 are "(later)" |

## Gap list, ranked by how often daily RP hits it

The ranking assumes the owner's own use: only group chats, often directing and writing as several characters, 10–50 versions on a turn they dwell on, edits to most replies, and an author's note in every chat. "(later)" items come last, unranked.

1. **E4: who replies next in a group.** Every turn of every group chat. Send always gets the first character; replying as anyone else means Cast → Speak now.
   - *Build:* a "Reply from" picker beside Generate (the cast's faces, last used first), with a per-chat default order (list order, or round-robin skipping absent members). Send uses that order. Plain Generate with your persona selected keeps its current meaning, but the button says so.
2. **D8: the speaker choice resets on reopen.** Every session in a chat with two personas, which is how the owner plays. It produces the wrong-persona send the owner complained about.
   - *Build:* keep the composer's speaker per branch tip with the composer's draft (server-side), and restore it on open.
3. **C1 / D6: no swipe on turns you play.** It hits whenever the model writes "your" character, which the owner does often ("I often want my character written for").
   - *Build:* derive "can regenerate" from the version's writer (any model-written version) and "can generate another" from the slot, so Regenerate and the arrows show on every message. A user-written slot gets "Generate a version" in ⋯.
4. **C5: the scratchpad.** Every turn the owner dwells on.
   - *Build:* a scratchpad editor per slot (the `scratchpad` draft target already exists). "Add selection to scratchpad" in a version's text selection menu. "Commit as a new version" uses `WriteVersion`.
5. **C6: a version picker for dozens.** It hits on the same turns as C5.
   - *Build:* replace the radio menu with a version list in a popover or the side panel: compact previews, star, hide, filter to starred, and pick two to compare side by side (the editor's diff view).
6. **B14: Continue a reply.** It hits on stopped, cut-off or too-short replies (ST's Continue, used daily).
   - *Build:* "Continue" on a stopped, interrupted or complete reply. It generates a new version, the old text plus a continuation through prefill where the provider supports it, with "otherwise unavailable" said where it doesn't (DESIGN §7.5 policies).
7. **G3: a note only on its character's turn.** It hits on every per-character note (outfits) in group chats.
   - *Build:* add a condition field to notes (always, on this character's turn, while present) in the note editor and the assembler, and show it in the Notes tab row.
8. **I6: toggle preset prompts for this chat.** It hits whenever a prompt is switched mid-chat (ST: one click).
   - *Build:* a "Prompts" section in This chat listing the preset's prompts with switches. Each switch writes a per-chat `preset.toggle` state event (from the latest message on, on this branch), and a cache-rewrite warning shows when the prompt is above the tail.
9. **B9: live reasoning.** It hits on every reply from a reasoning model.
   - *Build:* keep streamed reasoning on the version, rendered as a collapsible block above the text: open while streaming, collapsed when done, with the sticky per-user preference DESIGN §7.4 describes.
10. **C8: a model per swipe.** It hits when comparing models on a turn.
    - *Build:* a model choice on "Generate another version" (long-press or ⋯ → "Regenerate with…", the same picker as "Retry with…"), recorded on the version and shown in its header.
11. **A8: rename chats and groups.** It hits once per chat, and the group list stays ambiguous until it's done.
    - *Build:* a `RenameChat` op plus an editable title in the header and on the group page. A group keeps its name across chats with the same cast.
12. **F12: pin `{{user}}` and `{{char}}`.** It hits in group chats with directing instructions.
    - *Build:* show both bindings' current values in This chat, each with an override field (state events). Their effect shows in the next-request preview (J3).
13. **F4 / F5: variants.** They hit when reusing characters across premises.
    - *Build:* the card page lists the character's variants and the chats using each. Cast → member menu → "Use variant…" writes a card binding from the latest message on.
14. **D11: attach images.** Rare in RP (owner), required for card-making chats.
    - *Build:* a paperclip in the composer, drag and drop and paste onto the composer. Thumbnails go on the version, and a warning shows when the model has no vision.
15. **E5: group greetings.** It hits once per new group chat.
    - *Build:* `StartChat` adds each member's greeting in turn, with a picker per greeting as for one card.
16. **J3: the next-request preview.** It hits when debugging a preset or a note's placement.
    - *Build:* "Preview next request" in This chat opens the inspector view over `GetNextContext`'s assembly, unsent.
17. **L2: search in chats, and chat-wide replace.** It hits when finding an old scene or renaming a character.
    - *Build:*
      - a "Search this chat" box (FTS5 over the path) with results that jump to the message
      - then a replace that writes one changeset of new versions and summary revisions, revertible as a whole or per message
18. **C9: history in message editors.** It hits rarely, but losing text is the worst failure.
    - *Build:* the composer's "Earlier text" popover on the message and summary editors (needs `RestoreMessageDraft`).
19. **C13: branch names and Delete branch.** It hits when tidying a chat with many forks.
    - *Build:* a name field per fork in the header's branch menu, and "Delete this branch" there (`DeleteBranch` exists).
20. **I3: preset override on a connection.** It hits once per connection.
    - *Build:* a preset select on the connection page.
21. **F13: search across library entries.** It hits when a rename spans cards or several presets. **Built 2026-11-12** (ARCHITECTURE §14.6 "Across the library").
    - *Build:* a library-wide search page over card, preset and note text, with replace by entry through each editor's drafts.
22. **B13: display regex.** It hits for presets that rely on display scripts.
    - *Build:* apply `markdown_only` scripts at render, client-side in the Markdown pipeline, with an "as sent / as shown" toggle on a message.
23. **B12: HTML messages.** It hits for HTML "games" cards.
    - *Build:* render a message's HTML in a sandboxed iframe on a separate origin, recent messages only, with the rest as text.
24. **I7: per-card preset overlays.** It hits for narrator cards.
    - *Build:* an "Overlays" section on a card: prompt toggles applied while it speaks.
25. **H3: the lorebook editor.** It hits rarely; imported books already work.
    - *Build:* an entry list with keys, content and switches on the existing editor store.
26. **B15: notification sound.** Rare.
    - *Build:* a sound switch in Settings → Notifications.
27. **K1: phones.** The owner doesn't use the app on a phone yet.
    - *Build:* walk through at phone width on the realistic data, then add web push.

**(later), unranked:** B10 rollout steps, C15 threads, E7 automatic presence, E10 one agent per character, H4 decision models for lore, L3 agentic chat edits, L4 workshop mode, L5 agent-driven configuration.
