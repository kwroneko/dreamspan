# Character context: four independent choices for how characters are kept apart

**Status**: Partially implemented: §1's shared-context settings and internal default planner are built (chatsettings, 2026-11-06) and obsolete as implementation proposals; see ARCHITECTURE §16. Separate contexts and the remaining proposals stay unbuilt. Proposed, revised 2026-11-06 after the owner's corrections (job `chardefs`, design only, no code). Everything here is **[P]** unless it cites a **[D]** or is marked **Open**. It is a delta from master `a53d198f` (ARCHITECTURE §3.8 "Participation requires an authored version", §12 "Next" and "The Cast tab", §15 "Card definitions", "With the definitions", "Replacements", "Cache breakpoints", §16 "Agent rollouts" and "Decision models"; spec/AGENTIC.md; spec/CHAT-MERGE.md), from reference-harness `latest` (`9b385944`) and from SillyTavern's public source at `06bde939` (2026-09-14). Costs are calculations on synthetic sizes with the prices in pi-ai 1.0.3's bundled catalog (the app's own price source), not provider measurements. No chat logs or card definitions were read.

## 1. The default, and four independent choices

- **[D]** (owner, 2026-11-06) "The default would be as it stands, with every character at once. In most cases that's going to be the right choice. It costs the least and the LLM has full context of everything. It doesn't scale as well with too many characters and doesn't separate them too well, which is why *sometimes* you might want to separate them."
- **[D]** (owner, 2026-11-06) "the information asymmetry and diverging storyline stuff could very well work with non-agentic RP and non-agentic models, since it's not inherently about tool calling. Keep in mind I am still not sure agentic RP even works well at all."
- **[D]** (owner, 2026-11-06, relayed by the coordinator; still holds) The descriptions of several characters mix and influence each other. Some definitions must stay shared: physical descriptions are needed even when writing other characters' turns. Moving "internal" definitions into card notes at the end of the context, sent only for the current speaker, works in ordinary single-model chats too; its costs are recency (read late, they can override what the story changed) and caching.

So nothing here changes a chat by default: requests stay byte-identical to today (compatibility contract, DESIGN §1 [D]). **[P]** Instead of a list of modes, a chat has four choices, each independent of the others, each with today's behaviour as its default. Any combination works with a plain model; only choice 2 needs tool calling.

| Choice | Default | Other options | Section |
|---|---|---|---|
| **1. Context per speaker** | One shared context: every reply sees everything on the path | **Separate contexts**: each character's replies see only what that character was present for | §2 |
| **2. Tools** | None: one model writes the reply | **Agent tools**: the model can call tools (search, notes, leaving the scene…) while writing | §3 |
| **3. Card layout** | The preset's: every card where the preset puts it | **Card-swap**: the preset's definition positions hold only the speaker's card. **Own-turn notes** (with either): passages of a card sent only on its character's turns | §4 |
| **4. Turn picking** | Auto | **Auto helped by a decision model**; **No one** | §5 |

Examples: an ordinary group chat is 1 shared, 2 none, 3 preset, 4 Auto. A group where Wren mustn't know what Mira and Tobin said while she was out, on a local model with no tool calling, is 1 separate, 2 none. What used to be called "per-character agents" is 1 separate plus 2 agent tools: not a mode of its own. A **narrator** is a character in the cast, not a choice here (§6).

**The built modes go away as user-facing choices.**
- **[D]** (owner, 2026-11-06, relayed by the coordinator) "One model with tools writes every turn, with all cards loaded" is just the default.
- The built modes (AGENTIC §6, `orchestrationModes`) only combine choices 2 and 3: `plain` is no tools; `narrator` ("Narrator with tools") differs from `plain` only by tools and the agent instructions that come with them; `card-swap` is `narrator` plus a card layout. None of them is a different way of running a chat.
- **[P]** So This chat shows the four settings, not a Reply mode select. Tools are a per-chat setting (choice 2: off, or on with the Tools list under it, which already writes `agent.tools`); turning tools on brings the agent instructions and the `agent` strategy with it. Card-swap is a card-layout setting (choice 3), with or without tools. A separate context per character is choice 1. The word "narrator" leaves the settings: a narrator is a character (§6).
- **[P]** The `orchestrationModes` registry stays, internally, as the extension point for plugins. One built-in entry, `default`, turns the four settings into the reply's plan (strategy, tools, contract, card layout, the context to assemble). A plugin replaces or wraps it to plan replies differently, as it can replace any registered part. A plugin that wants its own user-facing option registers a This chat section for it (`chatSettingSections`), like any other setting.
- **Existing `orchestration.mode` state.** No migration, baseline only: nothing real is stored yet (dev and test data only). The `orchestration.mode` event kind is removed from `@rp/shared/state.ts`, and the settings are written as their own keys (§7). Dev and test databases are seeded again; there is no read path for old `orchestration.mode` events and no compatibility mapping. Tests that set a mode set the settings instead (`narrator` becomes tools on; `card-swap` becomes tools on with card-swap).

**reference-harness** isolates agents fully: each agent has its own workspace prompt (`src/workspace/prompt.ts:57–110`), its own timeline with siblings' messages as `user` rows (`spec/MULTI-AGENT-SUPPORT.md:143–148`, `:322–328`) and its own summaries, summarized natively or mirrored wholesale from one donor agent (`summaries_from`, §10b). It ties the separate context to the agent and has no shared definitions, which RP groups need. The deltas: separate contexts without agents (choice 1 alone), shared definitions within them (§2.4), own-turn notes for a shared context (§4.2), and summaries shared up to where contexts diverge, instead of all-or-nothing mirroring (§2.3).

## 2. Choice 1: context per speaker

With one shared context (the default), every reply is assembled from the whole path, as today. With **separate contexts**, each reply is assembled from what its speaker was present for. Nothing else changes: same preset, same model, same reply strategy. This works the same with or without tools.

- **[D]** (owner, 2026-11-06) On plain mode with scenes or labels: "What?". With one shared context there are no scenes, labels or views: the model sees everything.
- **[D]** (owner, 2026-11-06) Own-turn notes are independent of knowledge separation: "You can do the part of showing parts of character defs at the end only for some characters without any of this."

### 2.1 Who knows a message

- **[D]** (owner, 2026-11-06) "When a message is generated, a certain set of characters is present. That's what the presence marker originally referred to. Those characters can see the message. The story doesn't have to be branching, since a character could be 'gone' without their actions being narrated in a specific branch. If there are different branches of conversation, however, logically different characters may be part of them. A merged in chat only had those characters present."
- This matches DESIGN §7.1 [D] ("sees history only for the periods it was present") and §3.5 [D] (a character counts as in a chat only once a message or swipe was generated with it present).

So the knowers of a message are the characters present when its selected version was generated. That is already recorded: each version pins its cast (`versions.cast_json` plus its speaker, ARCHITECTURE §3.8 "Participation requires an authored version"). Branches need nothing more: each branch's versions record their own casts. A merged-in chat's messages are known to the characters present in the source when they were generated: **[P]** in a separate context, a merge join's section is filtered message by message by the source versions' own casts, not by the join version's cast (which is the destination's).

What presence can't express yet, **[P]** with the reason:
- **Gone but still in the cast.** The owner's case: a character is gone without that being narrated. Today a version's cast counts muted members, and the only other way out is leaving the cast, which also takes the card out of everyone else's shared definitions (a rewrite of every prefix) and out of the chat. So "gone" needs its own state: an **away** mark on a cast member, recorded in the version's cast snapshot so the message knows who was away. Away and Mute are separate marks, following from DESIGN §3.5 [D] (owner, 2026-10-26: muting means only that the character doesn't talk, "whether it's away or you're just having a long one-on-one with someone else while it stays in the scene"): Mute means "doesn't talk", presence means "is there and sees". A muted character still knows what's said; an away one doesn't, and isn't picked to reply either. Who sets away: §5. The snapshot is a list of ids today, so this changes its shape when built.
- **A message meant for one** (a whisper, a letter) while everyone is present. Later, only if wanted: an audience on that one version.
- Not needed: a "Tell" action. A character learns about a stretch in the story itself, in a message it is present for.

### 2.2 Gap lines

- **[D]** (owner, 2026-11-06) "Yes, but I am not sure this wording is always what we want. One important case: two entirely separate storylines, that are 1 on 1 chats, merge. What do we say then?"

**[D]** (owner, 2026-11-06, confirming the proposal below: "Ok") In a separate context, the messages its character wasn't present for are left out. A gap line replaces a stretch only where the character was present before it and after it, within its own storyline. Everything else is someone else's past, and nothing is said by default:
- before the character's first message in the chat (it hadn't arrived);
- a merged-in storyline the character was never part of;
- after its last message, when it's away at the tip (the line appears once it's back).

The wording is preset text (a utility prompt next to the merge framing, with the app's editable default) and uses macros: `{{absentCount}}` (messages left out), `{{absentNames}}` (the characters present in that stretch). Default: "[{{char}} wasn't present for {{absentCount}} messages here, in which {{absentNames}} took part.]" An optional **join line**, empty by default, is sent at a merge point when the merged storyline is new to the character: for example "[From here, {{char}}'s story continues together with {{mergedNames}}'s.]" Both are system messages without a name, as summaries and merge markers are.

Example: Mira, Tobin and Wren are present for messages 1–40; Wren is away for 41–54 and back at 55. Wren's replies see 1–40, then "[Wren wasn't present for 14 messages here, in which Mira and Tobin took part.]", then 55 onwards. Mira's replies see everything. Second example: a 1:1 chat with Mira is merged into a 1:1 chat with Tobin at message 80. Tobin's replies see his own 1–80 and nothing of Mira's chat: no gap line, because Tobin was never in it. With the join line set, they see "[From here, Tobin's story continues together with Mira's.]" at the merge point.

### 2.3 Summaries: parallel by default

- **[D]** (owner, 2026-11-06) "With per-character agents, context is different for different agents. You essentially have a parallel chat context for each of them. So each of them would get different summaries, if their chats diverge. This could be optimized in such a way that summaries are shared up to the point where there's a shared prefix. The idea of sharing a summary for everyone isn't stupid but the issue is that if this is fine then why separate the chats in the first place?"
- **[D]** (owner, 2026-11-06) "Parallel context for each agent is the obvious default…"

**Default, [P] mechanism.** Each context is summarized like a chat of its own. Up to the first message where two contexts differ, they hold the same messages, so they share the same summaries (one summary pass, one cached summary layer). Summary chunks are cut at that point (DESIGN §7.1 [P], "cut at presence boundaries"). After it, each context gets its own summaries of its own messages, stored with the context's character set in `summaries.audience_json` (in the baseline, unused). Contexts that rejoin later (everyone present again) still differ in what they hold before that point, so their summaries stay separate. Delta from reference-harness: its `summaries_from` mirrors one donor's whole tiling or none; here sharing stops exactly where the contexts diverge.

Cost: a summary pass per diverged context, on the chat's summary connection (summary requests already have consent). A context's cached prefix matches the shared one up to its first difference; after that it has its own cache. Sonnet 5.5, 4 characters, a gap in the recent window: about 1.95¢ per new reply while that context's cache is warm, 5.35¢ when it has expired (from the first draft's model). Bedrock also needs the exact-position repeat kept per context. And the cost lasts: once contexts have diverged, they stay separately summarized for the rest of the chat.

### 2.4 The alternative: a shared past (Open)

- **[D]** (owner, 2026-11-06) "Having common summaries, and diverging and converging recent history, however, isn't really that absurd. It would mean a common cache prefix for everyone, and giving common context for older history to every agent could lead to a more coherent narrative, while allowing short term information asymmetry… The issues here are two: this would need to be its own specific way of doing things that is different from the default, and the way it works is slightly arbitrary. Depending on context size, summary settings, the conversation, etc, the boundary between what has divergent storylines and the converged past is pretty arbitrary… One benefit is that it allows for temporary separate storylines to not make a chat more expensive forever. I also earlier mentioned this (merging summaries, but keeping recent chat separated) as a way to merge external chats in. I think it's not obvious how all of these options and alternative ways of doing things would be worked into a single coherent system/UI without becoming really hard to understand."

**Open.** The owner is unsure; the default stays parallel (§2.3). One **[P]** idea, to make the boundary non-arbitrary: tie it to an explicit story event, not to summary settings.
- **The event, a "rejoin point"**: a chat merge's join message (built, CHAT-MERGE), or a message the user marks with **Storylines rejoin here** (a state event at that position, undone like any).
- **Before it**: everything every involved context held before the rejoin point is summarized into one shared layer, with a section per storyline as the merge layout already does (CHAT-MERGE's per-line summary sections, the owner's multi-chatroom idea). The storylines' last messages before the point go in one framed section, verbatim up to a budget, as the merge's parallel span does. Everyone's context then starts the same: one cache prefix, one summary chain.
- **After it**: separate recent history continues, by presence, as in §2.1. Asymmetry is short-term again until the next rejoin point.
- **What the model sees**, example: Wren was away for 41–54 while Mira and Tobin talked; the user marks 60 "Storylines rejoin here". From the next summary pass on, every character's context starts with the shared summaries of 1–59, which include "Mira and Tobin, 41–54: …", so Wren now knows that past, as a summary. Messages from 60 on are separate again by presence.
- **Merging an external chat** is the same mechanism with the join as the rejoin point: the destination's and the source's pasts become one shared layer with a section per chat; after the join, each character's recent history is what it was present for. With one shared context (choice 1's default), it's exactly the built merge.
- **Cost**: diverged stretches stop costing extra at the next rejoin point, instead of for the rest of the chat.
- **What makes it Open**: it's a second way of handling separate contexts, with its own control, and the user has to understand when knowledge becomes shared. Not built until the owner decides.

### 2.5 What each speaker sees of the cards

In a separate context, a reply gets its own card and own-turn notes, and the other cast cards' shared text: their Description after any replacement note (§4.2), or the whole card if it hasn't been split. This follows from the 2026-11-06 [D] (§1): physical descriptions are needed even when writing other characters' turns, so some definitions sit in shared definitions. It refines DESIGN §7.1's "only its own card".

## 3. Choice 2: tools

None by default: the reply is written as today. With **agent tools**, the model may call the chat's tools while writing (AGENTIC §6; the Tools list in This chat writes `agent.tools`). Tools follow choice 1: in a separate context, `search_chat`, `read_messages`, `expand_summary` and `list_notes` never return what the speaker wasn't present for, nor other characters' own-turn notes. With tools, a character can leave the scene itself (`set_presence`, §5). Tools on is what the built `narrator` mode was (§1).

## 4. Choice 3: card layout

The preset's layout is the default: every cast card where the preset puts it, on every turn. Card-swap changes which cards fill the preset's definition positions. Own-turn notes work with either, and with either context choice.

### 4.1 Card-swap: rotation only

- **[D]** (owner, 2026-11-06) "Swap mode still shows the persona on ST. With this configuration as described the LLM would quite literally never see it. … If a user wants card defs to be shown at the end, this can be done by editing the prompt preset. It's the rotation that can't be expressed that way… Why do we have to go out of our way to seemingly override the user's preset choices."

**Target behaviour** (**built** by the `cardswap` job as the `cards.rotation` setting, ARCHITECTURE §16; the persona-turn [P] below is not built: a persona turn sends every card): card-swap is rotation only. The preset's card-definition positions hold only the current speaker's card, as in ST's "Swap character cards". Nothing moves to the tail. The persona and everything else are unchanged. Concretely:
- The per-field markers (`charDescription`, `charPersonality`, `scenario`, `dialogueExamples`, and `{{description}}`, `{{personality}}`, `{{scenario}}` in preset text) and the Definitions marker are filled from the speaker's card alone, still in its `<Name>…</Name>` wrapper (DESIGN §5.0 [D]). The other characters' cards are not sent at those positions.
- Card notes "With the definitions" follow their card: only the speaker's are sent there. The Own-turn notes marker is unaffected: it holds the speaker's own-turn notes with either layout.
- Unchanged: the persona's description at `personaDescription` or in Definitions; the speaker's system prompt and post-history overrides (as always); card notes at other positions (they follow their own conditions); lorebooks (the Lorebooks tab decides which books are in, as always); the chat's history, summaries and notes.
- A persona speaking (Write for, impersonation): the persona has no character card to rotate in. **[P]** The definition positions keep the last character card that spoke, so a persona turn doesn't change the prefix.

**What ST does** (public source, `06bde939`):
- `group_generation_mode` is `SWAP: 0`, `APPEND: 1`, `APPEND_DISABLED: 2` (`public/scripts/group-chats.js:129–133`), shown as "Swap character cards", "Join character cards (exclude muted)", "Join character cards (include muted)" (`public/index.html:6268–6272`). Swap is the default (`group-chats.js:1808`, `group?.generation_mode ?? group_generation_mode.SWAP`).
- In swap mode `getGroupCharacterCardsLazy` returns `null` (`group-chats.js:501`, `!group?.generation_mode`), so `getCharacterCardFieldsLazy` (`public/script.js:3402–3468`) fills description, personality, scenario (the chat's scenario override first) and example messages from the current speaker's card only. Join modes concatenate every member's fields with the join prefix and suffix (`group-chats.js:547–570`).
- The persona description is filled in every mode (`script.js:3412`, `power_user.persona_description`). The system prompt and post-history instructions are the speaker's in every mode (`script.js:3413–3421`).
- Character's Notes (`depth_prompt`): in swap mode `getGroupDepthPrompts` returns nothing (`group-chats.js:439–441`), so only the speaker's own note is sent (`script.js:4474–4486`). Join modes send every member's, muted ones left out unless speaking (`group-chats.js:454`).
- Character lorebooks are the speaker's in every mode (`getCharacterLore` reads `this_chid`, `public/scripts/world-info.js:4475–4491`); swap mode doesn't change them.

**A documented difference.** ST's swap mode also drops the other members' Character's Notes. Here an imported Character's Note is a card note that follows its own condition; the user gives it "on its card's turn" for ST's behaviour. **[P]** When the importer maps a swap-mode ST group (it doesn't map `generation_mode` today), the group's chats get card-swap and the imported Character's Notes of its members get that condition in those chats.

**Cache.** The start of the request then differs by speaker. That is the user's choice; the cache estimate shows it (§4.4). Moving the definitions to the tail is a preset edit, open to any chat.

### 4.2 Own-turn notes

**Words.** *Own-turn*: sent only when that character is the speaker. The UI says "only on <name>'s turns", because "private" already means "not exported" for notes (ARCHITECTURE §8).

- **[D]** (owner, 2026-11-06) "Card fields have nothing to do with this. You can't split this unless you do something like edit the card with an LLM. Usually 'description' contains everything. We could invent a concept of a card having a public and a private part of its def, but it would be non-standard. This requires the user to adapt the card either way."
- **[D]** (owner, 2026-11-06) "This was already decided. The only way to do it is notes. The other surface doesn't work. There's no public/private part in the spec. If we were to use card extensions, we'd use them to specify the card notes and their configuration, since that's actually general purpose." Own-turn card notes are the mechanism. There is no public/private card extension. Card notes already travel in `extensions.rp_harness.notes`.

#### Move to an own-turn note

On a selection in Description (or any card prompt field), one card save makes two card notes:
1. An **own-turn note** holding the passage, with the condition "on its card's turn".
2. A **replacement note** for that field: the field's text without the passage, sent in the field's place (`replaces: { kind: "card_field", field }`, built). The Description itself stays untouched, so an update of the card or a re-import still merges into it, and the field shows its As replaced / Original tabs, as any replaced field does.

Until the user does this, a card is entirely shared. Cost to the user: one selection and one click per passage.

**Where the own-turn note goes.**
- **[D]** (owner, 2026-11-06) "Why would this be predetermined? This is what the prompt preset is literally for." Own-turn notes are notes. They go where note positions and the preset put them. There is no fixed place for them.
- **[P]** The preset gets one more marker, **Own-turn notes**, in its prompt order like its other markers ("Chat history", "Newest message", "Definitions"). It holds the speaker's own-turn notes: card notes whose placement is "At the preset's Own-turn notes" and whose condition is due on this turn, in cast order, each in its card's `<Name>…</Name>` wrapper. Its row in the preset editor lists them, as the "With definitions" slot lists its notes. "Move to an own-turn note" gives the new note that placement, and doesn't ask.
- **Where the marker sits.** The built-in preset puts it at the start of the tail: after the chat history and the newest message, before the preset's tail prompts. Imported ST presets get it inserted at the same place (ST has no such marker), as "Newest message" is inserted after the history. A preset whose order leaves it out still sends these notes at the start of the tail, with an inspector note "Own-turn notes sent at the start of the tail: this preset has no Own-turn notes marker", so a moved passage is never silently lost. The user moves the marker in the preset editor to put every own-turn note elsewhere; a single note can still take any ordinary note position (depth N, the start or end of the tail, with the definitions) in its own editor.
- **Why the start of the tail by default.** The default is every character at once (§1), and its cached prefix must not change when the speaker does. At the start of the tail, the notes are written with each new reply and read back by its swipes, and everything before them is the same for every speaker (§4.4). Put "with the definitions", a speaker-dependent note would sit in the cached prefix and change it on every change of speaker. It also matches the owner's original idea: card notes at the end of the context that apply only for the current speaker (§1 [D]).
- What each place costs is information for the cache estimate, not a choice the app makes (§4.4). When the marker or a single note sits before the history, the start of the request differs by speaker: the card editor already warns for a conditioned note with the definitions ("its piece is volatile"), the preset editor shows the same warning at a marker placed before the history, and the cache estimate names the cost (§4.4).

**A chat that wants everything at once again** switches both notes off in that chat (Notes tab; card notes already have per-chat switches), and the original Description is sent. **[P]** The Notes tab shows the pair as "Moved from Description" with one switch for both, so the passage is never sent twice or not at all.

**What goes where**, as guidance in the move action's explanation and for Suggest a split's instruction: looks, public role and relationships everyone knows stay in the Description. Inner life, secrets and voice go to own-turn notes. Example messages carry the voice: kept, they mix voices in a group; moved into an own-turn note, they're only the speaker's. Lorebook entries can already be limited to a speaker (ARCHITECTURE §15 "speaker filters").

#### Suggest a split (later helper)

**Suggest a split…** in the card editor sends the card's prompt fields, only when pressed, to a model the user picks in that dialog (provider-send consent: nothing is sent otherwise, nothing runs in the background). It asks which passages are inner life and which others need. The result is a diff of the moves "Move to an own-turn note" would make, each passage with a tick; accepting makes the same card save. The request is a rollout with its ledger row, so it shows in Activity with its cost.

#### Recency

An own-turn note at the start of the tail (the default marker place) or in the chat is read after the story, so it can pull a character back to how the card described them: the card says Mira distrusts Tobin; 300 messages later she trusts him. Placed before the history, it's no worse than the card itself. Mitigations:
- **Framing text** in the note, prefilled by "Move to an own-turn note" and editable: "[Background on {{char}}, as the story began. Where the story since then shows {{char}} differently, the story wins.]" It's text in the note, not a hidden wrapper ("no hidden note kinds", DESIGN §4.1 [D]).
- **Current state over the card's text.** A change in the story is a revision of that note in this chat, by the user or by `edit_note` when the note is agent-editable (DESIGN §4.1a [D]). Revisions are chat state, so a swipe undoes them.
- **Later, opt-in:** the summary pass also proposes updated current-state notes (output tokens on the summary request, which already has consent).

### 4.3 Own-turn notes and ST

- **[D]** (owner, 2026-11-06) "This doesn't really solve the issue of interoperability. The user will be editing notes and not the card, so exporting it will show the original description. The UI probably will help make it clear enough so they're not surprised, but this isn't really 'solving' it. ST cards just don't have this functionality."

ST gets the original Description. An ST export writes the card's own fields, and ST has no notes, conditions or replacements, so ST sends the whole Description on every turn, with the moved passage still in it and without any edits made to the notes since. The notes travel in `extensions.rp_harness.notes` for this app only; ST ignores them. Re-importing the file into this app brings the notes back.

Export deltas (`importer/exporters.ts` `withNotes`), so the round trip into this app keeps the setup: export keeps the self-referring condition ("its card's turn", no library id needed) and the self-replacement target, which export drops today ("conditions stay behind"). It never picks an own-turn note or a replacement note as the note that becomes ST's `depth_prompt`, or ST would send the passage twice.

**[P] The export UI.** When the card has notes that replace its fields, every Export… menu (ARCHITECTURE §11.4 "Export with unsaved changes" lists them) shows a notice before the file is written, with the app's "?" help:
> "Mira's Description is replaced here by notes. SillyTavern will get the original Description, which still has every passage you moved, and none of your later note edits. The notes go in the file for this app."

Two buttons: **Export** and **Open the notes**. No option flattens the notes into the Description, because ST would then send every passage on every turn anyway; that is the original Description's behaviour. The card editor's Definition tab shows the same fact in its token line ("~1,000 every turn · ~2,000 only on Mira's turns · SillyTavern gets the original").

### 4.4 Costs, for the cache estimate

These figures are information: the cache estimate's next-reply warning uses the same arithmetic on the real request ("Mira's turn starts differently from Tobin's: ~36,400 tokens are written again when Mira's copy has expired, about 9¢ on this model").

**Sizes** (owner data shape, synthetic): preset prefix 5,000 tokens; 4 characters with cards of 3,000 each (1,000 shared, 2,000 in own-turn notes when adapted); summary layer 16,000; recent messages 16,000 (about 40 of 400); per reply, the newest message (400) and the preset's tail (1,000); 20 swipes per turn (owner: 20–50). Speaker-dependent rows assume the speaker last spoke 4 replies ago (3 messages, 1,200 tokens, are new to its copy) and that the preset's 5,000 tokens before the definitions stay shared and warm. Each cell is **¢ per new reply / per swipe / per turn (1 reply + 20 swipes)**. Prices ($ per million tokens input / cache read / cache write): Sonnet 5.5 2 / 0.20 / 2.50; Opus 5.5 4 / 0.20 / 5; Bedrock `us.` Sonnet 5.5 2.20 / 0.22 / 2.75; GPT-5.6 Terra 2 / 0.20 / 2.50; GPT-5.5 5 / 0.50 / none (writes at the input price). Direct OpenAI caching is automatic, with no markers.

| Layout | Sonnet 5.5 | Opus 5.5 | Bedrock Sonnet 5.5 | GPT-5.6 Terra | GPT-5.5 |
|---|---|---|---|---|---|
| Every card whole in the prefix (the default, no own-turn notes) | 1.33 / 1.01 / 21.5 | 1.68 / 1.01 / 21.8 | 1.46 / 1.11 / 23.6 | 1.33 / 1.01 / 21.5 | 3.15 / 2.52 / 53.5 |
| Own-turn notes at the marker's default place, the start of the tail | 1.67 / 0.89 / 19.4 | 2.52 / 0.89 / 20.3 | 1.84 / 0.98 / 21.4 | 1.67 / 0.89 / 19.4 | 3.75 / 2.22 / 48.2 |
| Own-turn notes 4 messages deep | 2.04 / 0.89 / 19.8 | 3.29 / 0.89 / 21.0 | 2.24 / 0.98 / 21.8 | 2.04 / 0.89 / 19.8 | 4.47 / 2.22 / 48.9 |
| Own-turn notes with the definitions, speaker's copy cached | 1.49 / 0.89 / 19.2 | 2.14 / 0.89 / 19.9 | 1.63 / 0.98 / 21.2 | 1.49 / 0.89 / 19.2 | 3.39 / 2.22 / 47.8 |
| Own-turn notes with the definitions, speaker's copy expired | 9.95 / 0.89 / 27.7 | 19.8 / 0.89 / 37.6 | 10.9 / 0.98 / 30.5 | 9.95 / 0.89 / 27.7 | 19.9 / 2.22 / 64.4 |
| Card-swap rotation, speaker's copy cached | 1.43 / 0.83 / 18.0 | 2.08 / 0.83 / 18.6 | 1.57 / 0.91 / 19.8 | 1.43 / 0.83 / 18.0 | 3.24 / 2.07 / 44.6 |
| Card-swap rotation, speaker's copy expired | 9.20 / 0.83 / 25.8 | 18.3 / 0.83 / 34.9 | 10.1 / 0.91 / 28.3 | 9.20 / 0.83 / 25.8 | 18.4 / 2.07 / 59.8 |

What the warning should say, from the table:
- **A speaker-dependent start** (the Own-turn notes marker or a single note placed before the history, card-swap) is cheap while each speaker's copy is warm, and costs 6–9× a cached reply when it has expired (5 minutes on Anthropic by default). With rotating speakers and 20–50 swipes per turn, the other speakers' copies often expire before their turn. The warning names the speaker and the tokens.
- **Own-turn notes at the start of the tail** (the built-in preset's marker place) never vary the start: they are written with each new reply (+0.34¢ on Sonnet 5.5) and read back by its swipes, so with the owner's swipe counts they cost less per turn than today. Removing the final checkpoint so the tail is never cached costs more (30.1¢ per turn on Sonnet 5.5), so the app keeps it.
- **4 messages deep** adds the four newest messages to what each reply writes; nothing extra when a note at that depth or deeper already exists.
- **Bedrock without lookback** (owner: Bedrock has no lookback): the "cached" rows need the exact-position repeat (`historyStart.state.cacheHistory`) kept per speaker for a speaker-dependent start; otherwise every change of speaker pays the "expired" row.
- **Local models** (llama.cpp, LM Studio, MLX reuse the longest common prefix with the previous prompt; no money, only time). Tokens re-read per new reply when the speaker changes: today 1,400; own-turn notes at the start of the tail 3,400; 4 deep 5,000; with the definitions 39,400; card-swap rotation 36,400 (at 500 / 2,000 tokens/s of prompt processing: 3 s / 0.7 s, 7 s / 1.7 s, 10 s / 2.5 s, 79 s / 20 s, 73 s / 18 s). Swipes re-read nothing.

## 5. Choice 4: turn picking

- **Auto** (default): today's reply order picks who answers (natural order: anyone named first, then by talkativeness). Muted and away characters aren't picked.
- **No one**: the next reply isn't automatic. Nothing answers what the user sends; to get a reply, the user presses ▶ (Speak now) on a card in the Cast list, or picks a character under Next for one reply. **[D]** (owner, 2026-11-06): it is "the same as setting everyone muted, except without having to do so". Built (nooneauto; DESIGN §2.3).
- **Auto helped by a decision model**: Auto, with one or both of two opt-in decision points (each switched on per decision connection; nothing is sent otherwise; each falls back to plain Auto).

- **[D]** (owner, 2026-11-06) "That's only true for agents. Non-agentic RP doesn't have tools… but making the auto turn picker smarter *is* useful… it isn't especially dangerous if that decision is wrong, but… the way it works in ST without any kind of real context feels stupid. Two characters cannot talk without a third one who left the scene 3 messages before not butting in. Perhaps the decision model should just choose who speaks next, although the 'who has left' decision and state is useful since it can be decided more 'locally' based on a specific message, at least in theory."

The two decision points:
1. **Who is in the scene** (`presence`, built). After each reply, a small model reads the last two messages and the names and decides, per character, whether it's still in the scene at the end of that message. Those it thinks have left are marked away (today it writes Mute; **[P]** it writes away once that mark exists, §2.1). It is local: it judges one message. Example: Wren says "I'll see you tomorrow" and walks out at 41; the point marks Wren away at 41, so Auto stops picking her while Mira and Tobin talk.
2. **Who replies next** (being added as an opt-in by a parallel build job). Before an automatic reply, a small model reads the recent messages and chooses the next speaker among the characters who are present and not muted. Example: Mira asks Tobin a question; it picks Tobin, where natural order might have rolled Wren.

**What away does depends on choice 1.**
- **One shared context:** away only affects turn picking. A wrong decision costs one unwanted or missing reply, which the user corrects by picking a speaker.
- **Separate contexts:** away also decides who sees what (§2.1): Wren's later replies won't see 41–54. **[P]** So a decision-set away must be visible and easy to undo. The timeline shows a thin marker row at that message, "Wren left · scene check" with Wren's face, its hover saying why ("A decision model judged that Wren left at the end of this message"), and **Undo** on it. Undo writes the user's presence event at that position, replacing the decision's, and the messages generated since are corrected to count Wren as present ("Wren was here for messages 42–47"). A user's Mute and a character's own `set_presence` call show the same row, labelled by who set it.
- **With tools** (choice 2), a character can leave as an action: its own reply calls `set_presence`, attached to that reply's version, so a swipe takes it back. This is the owner's original idea: "per-character agents can leave as an action that changes the state". Both ways produce the same away mark.

## 6. The narrator is a character

- **[D]** (owner, 2026-11-06) On whether "narrator mode" sees everything: "This is not even a question."
- **[D]** (owner, 2026-11-06) "What does that even mean? What mode? A narrator would be a *character* not a mode. An omniscient narrator would see every message and not have a presence value at all. The only issue is that it would need a way to render converging storylines in its context, and that may be difficult."

**[P]** **Narrator** is a role on a cast member (a switch on its Cast row, "Sees everything and is never in or out of the scene"). A narrator card has no presence value: it's never away, the scene check never asks about it, and with separate contexts (choice 1) its replies are assembled from everything on the path. With one shared context the role changes nothing about what it sees, since every reply already sees everything. Turn picking treats it as any character. The built mode called "narrator" is gone as a choice; it was tools on (§1).

**The open problem: one context for storylines that diverged and converged.** With separate contexts, the path can interleave two storylines: Mira and Tobin at the inn (41–54) while Wren is at the docks (her own messages, 43, 47, 50). Characters see only their own line; the narrator sees both and needs them presented so the story reads straight. Options (**Open**; [P] sketches):

| Option | What the narrator's context shows | Cache | Weakness |
|---|---|---|---|
| a. Interleaved, labelled | Path order, each run of messages headed by who's present ("[At the inn: Mira, Tobin]", "[At the docks: Wren]"), from the versions' recorded casts | Grows at the end like today | Frequent jumps between lines |
| b. Grouped by storyline in the recent window | The owner's multi-chatroom idea: one block per storyline, newest storyline last; older history in summaries with a section per storyline | A new message in an earlier block rewrites everything after it | Reorders the story's sequence; arbitrary when a line is short |
| c. The other line as a section at the point they rejoin | The merge's parallel-span layout (CHAT-MERGE, built for chat merges): the current line verbatim, the other line as one framed section where they converge | Stable until the next convergence | The owner's own verdict on that layout: "a huge interruption…uneven, context wise" |
| d. Summaries for the other lines | The narrator's current line verbatim; other lines only as their summaries | Cheap | The narrator loses recent detail of the other lines |

[P] lean, not a decision: a for lines interleaved within one path (it needs no new machinery), c for chat merges (already built). Left Open for the owner.

**Owner, 2026-11-08** (DESIGN §6): shown the proposal that, within a chat, diverged stretches appear as labelled sections per storyline ("Mira and Tobin, 41–54", "Wren, 41–54"), the way a chat merge shows two chats, he said: "Okay, although I feel like both aren't really solved or fully settled yet." **[P]** That is the working default; the question stays **Open**. The same day he decided that a chat merge can also leave the characters' timelines separate by origin (DESIGN, "Merging another chat into this one"; §2.1, §2.2).

## 7. Schema impact

- Own-turn notes and card-swap rotation: no table change. The note document's `Placement` (`@rp/shared/docs/note.ts`) gains one value, "at the preset's Own-turn notes", and the preset's order one marker identifier (`ownTurnNotes`); both are JSON documents, not SQL. Export carries the condition and the replacement target inside `extensions.rp_harness.notes`.
- The four choices [P]: branch-owned state keys in `@rp/shared/state.ts`, replacing `orchestration.mode` (removed, no migration, §1): `context.per_speaker` (`shared` | `separate`), `agent.enabled` (tools on or off; the existing `agent.tools` stays the list), `cards.rotation` (card-swap on or off), and the existing composer choice for turn picking (Auto, No one; decision points are per decision connection, as built). `output.contract` stays. The narrator role: a cast state event. State keys are TypeScript schemas, not SQL; the baseline is untouched.
- Separate contexts (later): `versions.cast_json` (built) gives the knowers. The away mark (§2.1) changes the cast snapshot's shape. `summaries.audience_json` (in the baseline) holds a context's character set. The exact-position repeat digest is kept per context (`cacheHistory[contextKey]`), in the snapshot only.
- **BASELINE unchanged** by this study.

## 8. What's left

### 8.1 Build plan

1. **Move to an own-turn note** (next; needs no decision). In the card editor's Definition tab (side panel and full editor), select a passage of Mira's Description and press the button in the field's strip. One save makes the own-turn note (condition "on Mira's turns", placement "At the preset's Own-turn notes", framing prefilled) and the replacement note. Also the **Own-turn notes** preset marker (§4.2): in the built-in preset at the start of the tail, inserted there in imported presets, movable in the preset editor. What the model sees, with the built-in preset: on every turn, Mira's Description without the passage, where it always was; on Mira's turns, the passage too, at the start of the tail. The start of the request doesn't change with the speaker. The token line shows "~1,000 every turn · ~2,000 only on Mira's turns". Includes the export deltas and the export notice (§4.3), the "Moved from Description" pair in the Notes tab, the inspector piece "Not sent: only on Mira's turns" on other turns (DESIGN §7.4 [D]), and a test that an unadapted card's requests are byte-identical.
2. **Card-swap rotation** (the `cardswap` job, in progress). With card-swap on, a reply by Tobin sends Tobin's card at the preset's definition positions and no other character's; the persona is still there. The next reply by Mira sends Mira's card there instead. [P] for that job: build the rotation as a card-layout setting usable without tools, not tied to the mode.
3. **The four settings in This chat** (after 2). The Reply mode select goes; This chat shows Context, Tools, Card layout and Next (the composer's existing turn picking, linked). The `orchestration.mode` key is removed and the registry keeps one internal `default` entry that plans from the settings (§1). Example: a `narrator` chat is now Tools on, with requests byte-identical to before; a `card-swap` chat is Tools on with Card layout card-swap, sending what the rotation of item 2 sends. Dev data is seeded again.
4. **The cache estimate names a speaker-dependent start** (with 1 or 2). Before a reply whose start differs from the last speaker's, the warning by the composer says which speaker and how many tokens are written again if that speaker's copy has expired (§4.4).
5. **Separate contexts** (later; choice 1). Each reply is assembled from what its speaker was present for (§2.1), with gap lines (§2.2), parallel summaries (§2.3), the away mark and its timeline row with Undo (§5), and filtered tools when tools are on. Example: Wren, back at message 55, replies seeing 1–40, the gap line and 55 onwards, and her summaries cover only those. Works without tools.
6. **The Narrator role** (with 5). A Cast switch; a narrator's context is the whole path; its storyline rendering per §6's chosen option.
7. **Later**: Suggest a split (§4.2); state refresh on the summary pass (§4.2); mapping ST swap-mode groups on import (§4.1); one-message audiences (§2.1).

### 8.2 Decisions for the owner

1. **A shared past** (§2.4, Open). Whether separate contexts should also offer "Storylines rejoin here": everything before that message summarized once for everyone (one cache prefix, Wren learns the inn scene as a summary), separate recent history after it, and the same for merged chats. Default meanwhile: parallel contexts with their own summaries.
2. **How a narrator's context shows diverged storylines** (§6, Open). Options a–d; my lean is a (labelled runs in path order) within a chat and c (the merge's section) for merged chats. Owner, 2026-11-08: labelled sections per storyline is OK as the working default, but "both aren't really solved or fully settled yet"; still Open.

Turn picking with decision models (§5) is written as proposed, not listed: both points are opt-in, and the only proposal is that, with separate contexts, a decision-set away shows on the timeline with Undo.

## 9. Build units: separate contexts

Job `contexts` (2026-11-12): the build plan for §8.1 items 5 and 6, as deltas from master `21c7fb3d`. Each unit is sized for one agent session, ships with its tests, moves its text into ARCHITECTURE and marks what it built here. Every change to what is stored comes first (C1, C2), so the data shape settles before anything reads it, even where the UI comes later. Parallel threads in one chat (another job's delta on this spec) can reuse C1's per-message record: a thread is a set of characters present, and everyone else is away for its messages.

**reference-harness.** It has no presence-limited view inside one timeline: each agent account keeps its own timeline, with siblings' messages as `user` rows (`spec/MULTI-AGENT-SUPPORT.md` §6), and channel visibility (`spec/CHANNEL-VISIBILITY.md`) fences whole channels with a viewer check at query time. The deltas: one shared timeline whose versions record who was there (C1, C2); the viewer check applied per message at assembly and in the tools (C3, C5), as reference-harness applies its per-channel check in `search_messages`; and summaries shared up to the point where views diverge, instead of `summaries_from`'s whole-tiling mirror, which reference-harness needs because two accounts' chunk boundaries never align (§10b, "independent-range matching"). Here both views are cut from the same messages, so they can be cut at the same place (C7).

### 9.1 What is stored (C1, C2)

- **Each version's record of who was present.** `version_texts.cast_json` (built: the cast connected when it was written, muted members included, plus its speaker) is unchanged, so participation (DESIGN §3.5 [D]) reads as before. **New `version_texts.presence_json`**: a JSON object `{ "away"?: [card ids], "narrators"?: [card ids] }`, NULL when nobody in the cast was away and none was a narrator (every chat today). The **knowers** of a version are its cast and speaker, less those away; a narrator sees everything anyway. A speaker always knows its own message. Copies (amends, duplicates, fork copies, history edits, ST re-import copies) carry it as they carry `cast_json`. It is not frozen: C9's Undo may correct it.
- **The away mark.** State key `away.set { entity, away, source? }` (`source: "decision"` when the scene check set it), positional like `presence.set`, folded into `ChatState.away`. It is separate from Mute (`presence.set`, `ChatState.absent`): DESIGN §3.5 [D], §2.1 [P]. A join clears it and a swap moves it, as for Mute.
- **The narrator role.** State key `cast.role { entity, role: "narrator" | null }`, positional, folded into `ChatState.roles` (DESIGN §7.1 [D] "a narrator would be a *character*"; its form [P]). A narrator is never recorded as away.
- **The context setting.** State key `context.per_speaker`, `"shared"` or `"separate"`, positional like `agent.enabled`; absent is shared (§1 [D]: today's behaviour is the default).
- **Merged messages' knowers.** New `chat_merge_messages.knowers_json`: the JSON array of the card ids who knew that source message in the source (its version's knowers), written with the merge; NULL for summary rows (known to the whole source cast). The merge's rows stay frozen.
- **Per-context summaries.** `summaries.audience_json` (in the baseline, unused) gets its meaning: NULL is a summary of the whole path (shared context, narrators); otherwise the sorted card ids whose separate view it summarizes, the characters who held exactly its inputs over its range. **New `summarization_jobs.audience_json`** means the same, and the live-segment unique index includes it, so two contexts can summarize the same range at once.
- **Gap-line text.** Preset `utility_prompts.absent_gap_prompt` and `absent_join_prompt`, optional (absent: the app's defaults, §2.2). They're JSON in the preset document, not SQL. ST exports leave them out.
- **Snapshot.** `inputs.presence` (`{ away, narrators }`, only when not empty) and `inputs.view` (`{ viewer, mode }`, only in separate contexts), so `StartRollout` records the presence the reply was assembled with and a rebuild filters as the original did.

### 9.2 Units

| # | Unit | Depends on | Files | Tests | baseline.ts | Implements |
|---|---|---|---|---|---|---|
| C1 | **Stored shape**: the three state keys and their fold; `presence_json` (column, view, insert/update triggers, copies); `chat_merge_messages.knowers_json`; `summarization_jobs.audience_json` and its index; the two utility prompts with their defaults; `@rp/shared/knowledge.ts`, the pure knowers rule shared by assembly, tools and later the client | — | `@rp/shared/{state,knowledge}.ts`, `docs/preset.ts`, `db/baseline.ts`, the recorded schema fixture, the ST preset exporter | Fold: away and Mute independent, a join clears away, a swap moves it; ids declared for every new key (`stateKeys.test.ts` oracle); the knowers rule over cast, speaker, away and narrators; schema: copies carry `presence_json`, merge rows frozen; ST export leaves the prompts out | **changed** | §2.1 away [P], §6 role [P], §7, §2.2 preset text [D] |
| C2 | **Recording on generation**: `StartRollout` writes `presence_json` from the snapshot; human writes (append, own version, insert Write and Duplicate, greetings) record it at their position (`presenceAt` beside `castAt`); a merge writes each source message's knowers | C1 | `db/{participation,generationWrites,graphWrites,writes,insertWrites,merges}.ts`, `assembler/stages.ts` (the cast stage's `away` and `narrators`, snapshot `inputs.presence`) | Through the mock provider: a reply written while Wren is away records her; a swipe records its own; Mute alone records nothing; a narrator is never recorded away; a human message records the away set at its position; merged rows carry their source knowers; requests and snapshots of chats without away or roles stay byte-identical | no | §2.1 [D]: the knowers are who was present at generation |
| C3 | **Per-speaker context filter**: a registered `knowledge` stage before `history` that sets the history's view from `context.per_speaker` through a `contextViews` registry (built-ins `shared` and `separate`, an open id resolved at use); `history` hides what the view hides before it counts the budget; a narrator, a persona or no speaker gets the whole path; the LCM layer is withheld (with an issue) where the speaker's view diverged, until C7; a merge join's section only for characters of its source cast, until C6 | C2 | `assembler/{stages,knowledge,pipeline,types}.ts`, `db/assemblySources.ts` (knowers per history window, pinned) | Shared context: every existing generation and ST-harness test unchanged, plus explicit byte-identity of requests and snapshots with the setting absent and `shared`; separate: Wren's reply lacks 41–54, Mira's has them; the budget filled with known messages only; a rebuild reproduces it; scale at the owner's shape (3,000-message path, 300 forks, 30 swipes) | no | §2 [D] separate contexts, §6 [D] the narrator sees everything, causal order |
| C4 | **Gap lines**: a registered `gap-lines` stage after `merge-layout`. A stretch the speaker missed between two it was present for (or before its own reply) becomes one system message without a name: the preset's `absent_gap_prompt` with `{{absentCount}}`, `{{absentNames}}`, `{{char}}`. Nothing before its first message or for a storyline it was never in; the join line at a merge point new to it | C3 | `assembler/{gapLines,stages}.ts`, `@rp/shared/knowledge.ts` | §2.2's two examples exactly; a stretch cut by the budget; the inspector source `context/gap`; regex scripts run on it; the cached prefix stays stable as the chat grows | no | §2.2 [D] |
| C5 | **Tools hide what the speaker missed**: `search_chat`, `read_messages`, `expand_summary` and `search_summaries` read the speaker's view; `SearchChat` filters in SQL by `version_participants` and `presence_json`; `list_notes` leaves out other characters' own-turn notes | C3 | `agent/tools/{history,notes}.ts`, `db/agentReads.ts`, `db/ops.ts` | Wren's search never finds 41–54; `read_messages` skips them with the numbering unchanged; summaries only of her view; scale: `agentSearchScale` with a viewer, same bound | no | §3 [P], causal order |
| C6 | **Merged chats filtered by who was there**: in a separate context, a join's section is rendered per viewer from `chat_merge_messages.knowers_json`; an empty section sends nothing; gap-line rules across the join; the server half of the merge that keeps timelines separate by origin (DESIGN §3.3 [D] 2026-11-08) | C3, C4 | `assembler/merges.ts`, `db/merges.ts`, `db/assemblySources.ts` | §2.2's second example (Tobin sees nothing of Mira's chat); a character in both chats sees what it knew in the source; shared context byte-identical | no | §2.1 [P] a join's section filtered by the source casts, DESIGN §3.3 [D] 2026-11-08 |
| C7 | **Summaries per diverged context**: planning per view (the characters with identical knowledge), chunks cut where views diverge, NULL-audience summaries shared up to there, own summaries with `audience_json` after it, condensation within an audience, coverage by viewer, freshness when a correction changes the knowers; Bedrock's exact-position repeat per view (`cacheHistory[view]`) | C3 | `db/lcm*.ts`, `lcm/*`, `assembler/lcm.ts` | A three-character chat diverging at 41: one shared summary of 1–40, then one per view; no summary text from 41–54 in Wren's context; views that rejoin stay separate (§2.3 [D]); scale at the owner's shape | no (C1 did it) | §2.3 [D], DESIGN §7.1 [P] cut at presence boundaries |
| C8 | **Away producers and turn picking**: the scene check writes `away.set` (`source: "decision"`), `set_presence` writes away; Auto and Who replies next skip away characters as they skip muted ones; narrators are never asked about or sent away; `GetCast` carries `away` and `roles` | C1 | `decision/points/{presence,next}.ts`, `agent/tools/presence.ts`, `api/chatSetup.ts`, the client composer's `planReply` | The built decision and tool tests moved to away; Auto never picks an away card; a muted card that isn't away still knows (C3); shared context: only the mark's name changes | no | §5 [P] |
| C9 | **Undo of a decision-set away**: the user's presence event at that position replaces the decision's, and the versions generated since are corrected to count the character present (`CorrectPresence`, one writer transaction) | C8 | `db/writes.ts`, `db/ops.ts` | After Undo, Wren's next reply sees 42–47; other forks showing those messages see the same correction | no | §5 [P] |

Client units, for the UI job after the server units (each with e2e at 1440 and 390, light and dark, and the layout audit on the surfaces touched):

| # | Unit | Depends on | Implements |
|---|---|---|---|
| CU1 | This chat's **Context** setting: the existing `settings.context` section (`SharedContextSetting`) becomes a choice, "One shared context" or "Separate contexts", each explained on hover | C3 | §2 |
| CU2 | **Cast tab**: an Away mark per character beside Mute, and the **Narrator** switch ("Sees everything and is never in or out of the scene"); a narrator's row has no Away mark | C8 | §2.1, §6 |
| CU3 | **Timeline away rows**: "Wren left · scene check" at the message, with Undo, labelled by who set it (the user, a character's tool, the scene check) | C9 | §5 |
| CU4 | **Preset editor**: the gap line and the join line among the utility prompts, beside the merge framing | C4 | §2.2 |
| CU5 | **Inspector**: the gap line as its own labelled part; "Not sent: Wren wasn't present" for messages left out | C4 | DESIGN §7.4 [D] |

Order: C1, C2, then C3. After C3, C4, C5 and C7 can run in parallel; C8 needs only C1. C6 after C4; C9 after C8. CU1 after C3, CU2 after C8, CU3 after C9, CU4 and CU5 after C4.

### 9.3 Blocked on Open questions

None of the units waits for these; these parts do:
1. **How a narrator's context shows storylines that split and rejoined** (§6, Open). Blocked: any narrator context other than the whole path in order. Until answered, a narrator's reply sees the whole path exactly as a shared context does, with no storyline labels (C3). The owner has to say which of §6's options a–d, or another, the narrator gets. Example: Mira and Tobin talk at the inn (41–54) while Wren is at the docks (43, 47 and 50 are hers). Does the narrator read 41–54 in their order with each run headed "[At the inn: Mira, Tobin]" or "[At the docks: Wren]" (a), the two storylines as two blocks (b), Wren's line as one section where they meet again (c), or Wren's line only as its summary (d)?
2. **"Storylines rejoin here", a shared past** (§2.4, Open). Blocked: any marker or merge option that turns diverged pasts into one shared summary layer. Until answered, contexts that diverged stay separately summarized for the rest of the chat (C7, the §2.3 [D] default). The owner has to say whether separate contexts should offer it at all. Example: Wren was away for 41–54, and the user marks message 60 "Storylines rejoin here". From the next summary pass, should every character's context start with one shared summary of 1–59, so Wren now knows the inn scene as a summary, or should Wren never learn it unless the story tells her?
