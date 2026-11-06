# Character context: own-turn notes, card-swap rotation, knowledge from presence

**Status**: Proposed, revised 2026-11-06 after the owner's corrections (job `chardefs`, design only, no code). Everything here is **[P]** unless it cites a **[D]** or is marked **Open**. It is a delta from master `a53d198f` (ARCHITECTURE §3.8 "Participation requires an authored version", §15 "Card definitions", "With the definitions", "Replacements", "Cache breakpoints", §16 "Agent rollouts" and "Decision models"; spec/AGENTIC.md; spec/CHAT-MERGE.md), from reference-harness `latest` (`9b385944`) and from SillyTavern's public source at `06bde939` (2026-09-14). Costs are calculations on synthetic sizes with the prices in pi-ai 1.0.3's bundled catalog (the app's own price source), not provider measurements. No chat logs or card definitions were read.

## 1. What this is for, and when

- **[D]** (owner, 2026-11-06) "The default would be as it stands, with every character at once. In most cases that's going to be the right choice. It costs the least and the LLM has full context of everything. It doesn't scale as well with too many characters and doesn't separate them too well, which is why *sometimes* you might want to separate them."

So nothing in this spec changes a chat by default. Every cast card's definitions stay where the preset puts them, on every turn, and requests stay byte-identical to today (compatibility contract, DESIGN §1 [D]). The rest is for the chats where the user wants characters kept apart:

| The user wants | Use | What changes in the request |
|---|---|---|
| One character's inner life (secrets, voice) not to colour the others' turns, in an ordinary chat | **Own-turn notes** on that card (§2) | That passage is sent only on its character's turns, where the preset's Own-turn notes marker is (the start of the tail in the built-in preset) |
| ST's "Swap character cards": only the speaker's card in the definitions | **Card-swap** (§4) | The preset's definition positions hold only the speaker's card |
| Characters who don't know what happened while they were away | **Per-character agents** (§5), the optional Phase 7 mode | Each agent sees only the messages its character was present for |

These are independent. Own-turn notes work in every mode. Knowledge separation exists only for per-character agents.

- **[D]** (owner, 2026-11-06, relayed by the coordinator; still holds) The value of an agent per character is mainly that each has its own definitions, and the descriptions of several characters mix and influence each other. Some definitions must stay shared: physical descriptions are needed even when writing other characters' turns. Moving "internal" definitions into card notes at the end of the context, sent only for the current speaker, works in ordinary single-model chats too; its costs are recency (read late, they can override what the story changed) and caching.

**What is built today.** In `plain` and `narrator` modes every cast card's definitions are in the prefix. `card-swap` (`cardsAtTail`) takes the speaker's card out of the definitions and sends it as a system message just before the end of the request; §4 replaces that. A card's system prompt and post-history instructions already apply only on its turn (they replace Main and post-history, as in ST, unless the prompt forbids overrides). Card notes can already replace their own card's fields (`replaces: { kind: "card_field", field }`, ARCHITECTURE §15 "Replacements") and carry the condition "on its card's turn".

**reference-harness** isolates agents fully: each agent has its own workspace prompt (`src/workspace/prompt.ts:57–110`), its own timeline with siblings' messages as `user` rows (`spec/MULTI-AGENT-SUPPORT.md:143–148`, `:322–328`) and its own summaries, either summarized natively or mirrored wholesale from one donor agent (`summaries_from`, §10b). It has no shared definitions, which RP groups need for physical descriptions. The deltas here: own-turn notes in a shared prompt for single-model chats (§2), and per-character agents whose summaries are shared up to where their views diverge, instead of all-or-nothing mirroring (§5.3).

## 2. Own-turn notes

**Words.** *Own-turn*: sent only when that character is the speaker. The UI says "only on <name>'s turns", because "private" already means "not exported" for notes (ARCHITECTURE §8).

- **[D]** (owner, 2026-11-06) "Card fields have nothing to do with this. You can't split this unless you do something like edit the card with an LLM. Usually 'description' contains everything. We could invent a concept of a card having a public and a private part of its def, but it would be non-standard. This requires the user to adapt the card either way."
- **[D]** (owner, 2026-11-06) "This was already decided. The only way to do it is notes. The other surface doesn't work. There's no public/private part in the spec. If we were to use card extensions, we'd use them to specify the card notes and their configuration, since that's actually general purpose." Own-turn card notes are the mechanism. There is no public/private card extension. Card notes already travel in `extensions.rp_harness.notes`.

### 2.1 Move to an own-turn note

On a selection in Description (or any card prompt field), one card save makes two card notes:
1. An **own-turn note** holding the passage, with the condition "on its card's turn".
2. A **replacement note** for that field: the field's text without the passage, sent in the field's place (`replaces: { kind: "card_field", field }`, built). The Description itself stays untouched, so an update of the card or a re-import still merges into it, and the field shows its As replaced / Original tabs, as any replaced field does.

Until the user does this, a card is entirely shared. Cost to the user: one selection and one click per passage.

**Where the own-turn note goes.**
- **[D]** (owner, 2026-11-06) "Why would this be predetermined? This is what the prompt preset is literally for." Own-turn notes are notes. They go where note positions and the preset put them. There is no fixed place for them.
- **[P]** The preset gets one more marker, **Own-turn notes**, in its prompt order like its other markers ("Chat history", "Newest message", "Definitions"). It holds the speaker's own-turn notes: card notes whose placement is "At the preset's Own-turn notes" and whose condition is due on this turn, in cast order, each in its card's `<Name>…</Name>` wrapper. Its row in the preset editor lists them, as the "With definitions" slot lists its notes. "Move to an own-turn note" gives the new note that placement, and doesn't ask.
- **Where the marker sits.** The built-in preset puts it at the start of the tail: after the chat history and the newest message, before the preset's tail prompts. Imported ST presets get it inserted at the same place (ST has no such marker), as "Newest message" is inserted after the history. A preset whose order leaves it out still sends these notes at the start of the tail, with an inspector note "Own-turn notes sent at the start of the tail: this preset has no Own-turn notes marker", so a moved passage is never silently lost. The user moves the marker in the preset editor to put every own-turn note elsewhere; a single note can still take any ordinary note position (depth N, the start or end of the tail, with the definitions) in its own editor.
- **Why the start of the tail by default.** The default layout is every character at once (§1), and its cached prefix must not change when the speaker does. At the start of the tail, the notes are written with each new reply and read back by its swipes, and everything before them is the same for every speaker (§4.1). Put "with the definitions", a speaker-dependent note would sit in the cached prefix and change it on every change of speaker. It also matches the owner's original idea: card notes at the end of the context that apply only for the current speaker (§1 [D]).
- What each place costs is information for the cache estimate, not a choice the app makes (§4.1). When the marker or a single note sits before the history, the start of the request differs by speaker: the card editor already warns for a conditioned note with the definitions ("its piece is volatile"), the preset editor shows the same warning at a marker placed before the history, and the cache estimate names the cost (§4.1).

**A chat that wants everything at once again** switches both notes off in that chat (Notes tab; card notes already have per-chat switches), and the original Description is sent. **[P]** The Notes tab shows the pair as "Moved from Description" with one switch for both, so the passage is never sent twice or not at all.

**What goes where**, as guidance in the move action's explanation and for §2.2's instruction: looks, public role and relationships everyone knows stay in the Description. Inner life, secrets and voice go to own-turn notes. Example messages carry the voice: kept, they mix voices in a group; moved into an own-turn note, they're only the speaker's. Lorebook entries can already be limited to a speaker (ARCHITECTURE §15 "speaker filters").

### 2.2 Suggest a split (later helper)

**Suggest a split…** in the card editor sends the card's prompt fields, only when pressed, to a model the user picks in that dialog (provider-send consent: nothing is sent otherwise, nothing runs in the background). It asks which passages are inner life and which others need. The result is a diff of the moves §2.1 would make, each passage with a tick; accepting makes the same card save. The request is a rollout with its ledger row, so it shows in Activity with its cost.

### 2.3 Recency

An own-turn note at the start of the tail (the default marker place) or in the chat is read after the story, so it can pull a character back to how the card described them: the card says Mira distrusts Tobin; 300 messages later she trusts him. Placed before the history, it's no worse than the card itself. Mitigations:
- **Framing text** in the note, prefilled by "Move to an own-turn note" and editable: "[Background on {{char}}, as the story began. Where the story since then shows {{char}} differently, the story wins.]" It's text in the note, not a hidden wrapper ("no hidden note kinds", DESIGN §4.1 [D]).
- **Current state over the card's text.** A change in the story is a revision of that note in this chat, by the user or by `edit_note` when the note is agent-editable (DESIGN §4.1a [D]). Revisions are chat state, so a swipe undoes them.
- **Later, opt-in:** the summary pass also proposes updated current-state notes (output tokens on the summary request, which already has consent).

## 3. ST interop

- **[D]** (owner, 2026-11-06) "This doesn't really solve the issue of interoperability. The user will be editing notes and not the card, so exporting it will show the original description. The UI probably will help make it clear enough so they're not surprised, but this isn't really 'solving' it. ST cards just don't have this functionality."

ST gets the original Description. An ST export writes the card's own fields, and ST has no notes, conditions or replacements, so ST sends the whole Description on every turn, with the moved passage still in it and without any edits made to the notes since. The notes travel in `extensions.rp_harness.notes` for this app only; ST ignores them. Re-importing the file into this app brings the notes back.

Export deltas (`importer/exporters.ts` `withNotes`), so the round trip into this app keeps the setup: export keeps the self-referring condition ("its card's turn", no library id needed) and the self-replacement target, which export drops today ("conditions stay behind"). It never picks an own-turn note or a replacement note as the note that becomes ST's `depth_prompt`, or ST would send the passage twice.

**[P] The export UI.** When the card has notes that replace its fields, every Export… menu (ARCHITECTURE §11.4 "Export with unsaved changes" lists them) shows a notice before the file is written, with the app's "?" help:
> "Mira's Description is replaced here by notes. SillyTavern will get the original Description, which still has every passage you moved, and none of your later note edits. The notes go in the file for this app."

Two buttons: **Export** and **Open the notes**. No option flattens the notes into the Description, because ST would then send every passage on every turn anyway; that is the original Description's behaviour. The card editor's Definition tab shows the same fact in its token line ("~1,000 every turn · ~2,000 only on Mira's turns · SillyTavern gets the original").

## 4. Card-swap: rotation only

- **[D]** (owner, 2026-11-06) "Swap mode still shows the persona on ST. With this configuration as described the LLM would quite literally never see it. … If a user wants card defs to be shown at the end, this can be done by editing the prompt preset. It's the rotation that can't be expressed that way… Why do we have to go out of our way to seemingly override the user's preset choices."

**Target behaviour** (the parallel `cardswap` job builds it): card-swap is rotation only. The preset's card-definition positions hold only the current speaker's card, as in ST's "Swap character cards". Nothing moves to the tail. The persona and everything else are unchanged. Concretely:
- The per-field markers (`charDescription`, `charPersonality`, `scenario`, `dialogueExamples`, and `{{description}}`, `{{personality}}`, `{{scenario}}` in preset text) and the Definitions marker are filled from the speaker's card alone, still in its `<Name>…</Name>` wrapper (DESIGN §5.0 [D]). The other characters' cards are not sent at those positions.
- Card notes "With the definitions" follow their card: only the speaker's are sent there. The Own-turn notes marker is unaffected: it holds the speaker's own-turn notes in every mode.
- Unchanged: the persona's description at `personaDescription` or in Definitions; the speaker's system prompt and post-history overrides (as in every mode); card notes at other positions (they follow their own conditions); lorebooks (the Lorebooks tab decides which books are in, as in every mode); the chat's history, summaries and notes.
- A persona speaking (Write for, impersonation): the persona has no character card to rotate in. **[P]** The definition positions keep the last character card that spoke, so a persona turn doesn't change the prefix.

**What ST does** (public source, `06bde939`):
- `group_generation_mode` is `SWAP: 0`, `APPEND: 1`, `APPEND_DISABLED: 2` (`public/scripts/group-chats.js:129–133`), shown as "Swap character cards", "Join character cards (exclude muted)", "Join character cards (include muted)" (`public/index.html:6268–6272`). Swap is the default (`group-chats.js:1808`, `group?.generation_mode ?? group_generation_mode.SWAP`).
- In swap mode `getGroupCharacterCardsLazy` returns `null` (`group-chats.js:501`, `!group?.generation_mode`), so `getCharacterCardFieldsLazy` (`public/script.js:3402–3468`) fills description, personality, scenario (the chat's scenario override first) and example messages from the current speaker's card only. Join modes concatenate every member's fields with the join prefix and suffix (`group-chats.js:547–570`).
- The persona description is filled in every mode (`script.js:3412`, `power_user.persona_description`). The system prompt and post-history instructions are the speaker's in every mode (`script.js:3413–3421`).
- Character's Notes (`depth_prompt`): in swap mode `getGroupDepthPrompts` returns nothing (`group-chats.js:439–441`), so only the speaker's own note is sent (`script.js:4474–4486`). Join modes send every member's, muted ones left out unless speaking (`group-chats.js:454`).
- Character lorebooks are the speaker's in every mode (`getCharacterLore` reads `this_chid`, `public/scripts/world-info.js:4475–4491`); swap mode doesn't change them.

**A documented difference.** ST's swap mode also drops the other members' Character's Notes. Here an imported Character's Note is a card note that follows its own condition; the user gives it "on its card's turn" for ST's behaviour. **[P]** When the importer maps a swap-mode ST group (it doesn't map `generation_mode` today), the group's chats get card-swap and the imported Character's Notes of its members get that condition in those chats.

**Cache.** The start of the request then differs by speaker. That is the user's choice; the cache estimate shows it (§4.1). Moving the definitions to the tail is a preset edit, open to any mode.

### 4.1 Costs, for the cache estimate

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

## 5. Per-character agents: knowledge from presence

Plain mode and narrator mode are one model with full context: everything on the path, every card. Knowledge separation exists only for per-character agents (the optional Phase 7 mode, AGENTIC §6).
- **[D]** (owner, 2026-11-06) On whether narrator mode sees everything: "This is not even a question." It does.
- **[D]** (owner, 2026-11-06) On plain mode with scenes or labels: "What?". Plain mode is one model with full context; there are no knowledge views in it.
- **[D]** (owner, 2026-11-06) Own-turn notes are independent of knowledge separation: "You can do the part of showing parts of character defs at the end only for some characters without any of this."

### 5.1 Who knows a message

- **[D]** (owner, 2026-11-06) "When a message is generated, a certain set of characters is present. That's what the presence marker originally referred to. Those characters can see the message. The story doesn't have to be branching, since a character could be 'gone' without their actions being narrated in a specific branch. If there are different branches of conversation, however, logically different characters may be part of them. A merged in chat only had those characters present."
- This matches DESIGN §7.1 [D] ("sees history only for the periods it was present") and §3.5 [D] (a character counts as in a chat only once a message or swipe was generated with it present).

So the knowers of a message are the characters present when its selected version was generated. That is already recorded: each version pins its cast (`versions.cast_json` plus its speaker, ARCHITECTURE §3.8 "Participation requires an authored version"). Branches need nothing more: each branch's versions record their own casts. A merged-in chat's messages are known to the characters present in the source when they were generated: **[P]** in an agent's view, a merge join's section is filtered message by message by the source versions' own casts, not by the join version's cast (which is the destination's).

What presence can't express yet, **[P]** with the reason:
- **Gone but still in the cast.** The owner's case: a character is gone without that being narrated. Today a version's cast counts muted members (Mute only stops a character talking, DESIGN §3.5 [D]; it may still be in the scene), and the only other way out is leaving the cast, which also takes the card out of the other agents' shared definitions (a rewrite of every prefix) and out of the chat. So "gone" needs its own state: an **away** mark on a cast member, recorded in the version's cast snapshot so the message knows who was away. Away and Mute are separate marks, following from DESIGN §3.5 [D] (owner, 2026-10-26: muting means only that the character doesn't talk, "whether it's away or you're just having a long one-on-one with someone else while it stays in the scene"): Mute means "doesn't talk", presence means "is there and sees". A muted character still knows what's said; an away one doesn't, and isn't picked to reply either. Who sets away is Open (§5.4). This needs a schema change (the snapshot is a list of ids today), made when the mode is built.
- **A message meant for one** (a whisper, a letter) while everyone is present. Later, only if wanted: an audience on that one version.
- Not needed: a "Tell" action. A character learns about a stretch in the story itself, in a message it is present for.

### 5.2 Gap lines

- **[D]** (owner, 2026-11-06) "Yes, but I am not sure this wording is always what we want. One important case: two entirely separate storylines, that are 1 on 1 chats, merge. What do we say then?"

**[P] Proposal, for the owner to confirm.** In an agent's view, the messages its character wasn't present for are left out. A gap line replaces a stretch only where the character was present before it and after it, within its own storyline. Everything else is someone else's past, and nothing is said by default:
- before the character's first message in the chat (it hadn't arrived);
- a merged-in storyline the character was never part of;
- after its last message, when it's away at the tip (the line appears once it's back).

The wording is preset text (a utility prompt next to the merge framing, with the app's editable default) and uses macros: `{{absentCount}}` (messages left out), `{{absentNames}}` (the characters present in that stretch). Default: "[{{char}} wasn't present for {{absentCount}} messages here, in which {{absentNames}} took part.]" An optional **join line**, empty by default, is sent at a merge point when the merged storyline is new to the character: for example "[From here, {{char}}'s story continues together with {{mergedNames}}'s.]" Both are system messages without a name, as summaries and merge markers are.

Example: Mira, Tobin and Wren are present for messages 1–40; Wren is away for 41–54 and back at 55. Wren's agent sees 1–40, then "[Wren wasn't present for 14 messages here, in which Mira and Tobin took part.]", then 55 onwards. Mira's agent sees everything. Second example: a 1:1 chat with Mira is merged into a 1:1 chat with Tobin at message 80. Tobin's agent sees its own 1–80 and nothing of Mira's chat: no gap line, because Tobin was never in it. With the join line set, it sees "[From here, Tobin's story continues together with Mira's.]" at the merge point.

### 5.3 Summaries per view

- **[D]** (owner, 2026-11-06) "With per-character agents, context is different for different agents. You essentially have a parallel chat context for each of them. So each of them would get different summaries, if their chats diverge. This could be optimized in such a way that summaries are shared up to the point where there's a shared prefix. The idea of sharing a summary for everyone isn't stupid but the issue is that if this is fine then why separate the chats in the first place?"

So there is no shared summary layer for everyone. **[P]** Each agent's view is summarized like a chat of its own: up to the first message where two views differ, they hold the same messages, so they share the same summaries (one summary pass, one cached summary layer). Summary chunks are cut at that point (DESIGN §7.1 [P], "cut at presence boundaries"). After it, each view gets its own summaries of its own messages, stored with the view's character set in `summaries.audience_json` (in the baseline, unused). Views that rejoin later (everyone present again) still differ in what they hold before that point, so their summaries stay separate. Delta from reference-harness: its `summaries_from` mirrors one donor's whole tiling or none; here sharing stops exactly where the views diverge.

Cost: a summary pass per diverged view, on the chat's summary connection (summary requests already have consent). A view's cached prefix matches the shared one up to its first difference; after that the agent has its own cache. Sonnet 5.5, 4 characters, a gap in the recent window: about 1.95¢ per new reply while the agent's own cache is warm, 5.35¢ when it has expired (from the first draft's model). Bedrock also needs the exact-position repeat kept per view.

### 5.4 Who marks a character gone (Open)

The built **presence** decision point ("Who is in the scene", opt-in per decision connection) runs after each reply in a chat with at least two characters the user doesn't play. It asks a small model, over the last two messages and the names, whether each character is still in the scene at the end of the latest message, and marks those it thinks are gone as away (today that is Mute: they aren't picked to reply). The owner said the idea was that "per-character agents can leave as an action that changes the state": the character's own agent decides to leave (the built `set_presence` tool is the closest thing). **Open**: which of these sets "away" for knowledge (§5.1), and whether the decision point stays, changes, or goes. Not decided here. (Settled: away is its own mark, not Mute, §5.1; the decision point's current use of Mute changes to away when that mark is built.)

### 5.5 What each agent sees

| | Definitions | History | Summaries |
|---|---|---|---|
| `plain` (default) | every card, as the preset puts them; own-turn notes only on their character's turn | everything on the path | the chat's |
| `narrator` | the same as `plain` | everything | the chat's |
| `card-swap` | the speaker's card at the definition positions (§4) | everything | the chat's |
| `per-character` | its own card and own-turn notes; the other cast cards' shared text (their Description after any replacement note; an unadapted card whole) | its view (§5.1), with gap lines (§5.2) | its view's (§5.3) |

The others' shared text follows from the 2026-11-06 [D] (§1): physical descriptions are needed even when writing other characters' turns, so some definitions sit in shared definitions. Tobin's agent therefore gets Mira's Description after her replacement note (her looks, not her moved secrets), and Mira's whole card if it hasn't been split. This refines DESIGN §7.1's "only its own card".

Tools follow the view: `search_chat`, `read_messages`, `expand_summary` and `list_notes` never return what the agent's character wasn't present for, nor other characters' own-turn notes.

## 6. Schema impact

- Own-turn notes and card-swap rotation: no table change. The note document's `Placement` (`@rp/shared/docs/note.ts`) gains one value, "at the preset's Own-turn notes", and the preset's order one marker identifier (`ownTurnNotes`); both are JSON documents, not SQL. Export carries the condition and the replacement target inside `extensions.rp_harness.notes`.
- Knowledge (per-character mode, later): `versions.cast_json` (built) gives the knowers. The away mark (§5.1) changes the cast snapshot's shape when it is built. `summaries.audience_json` (in the baseline) holds a view's character set. The exact-position repeat digest is kept per view (`cacheHistory[viewKey]`), in the snapshot only.
- **BASELINE unchanged** by this study.

## 7. What's left

### 7.1 Build plan

1. **Move to an own-turn note** (next; needs no decision). In the card editor's Definition tab (side panel and full editor), select a passage of Mira's Description and press the button in the field's strip. One save makes the own-turn note (condition "on Mira's turns", placement "At the preset's Own-turn notes", framing prefilled) and the replacement note. Also the **Own-turn notes** preset marker (§2.1): in the built-in preset at the start of the tail, inserted there in imported presets, movable in the preset editor. What the model sees, with the built-in preset: on every turn, Mira's Description without the passage, where it always was; on Mira's turns, the passage too, at the start of the tail. The start of the request no longer changes with the speaker. The token line shows "~1,000 every turn · ~2,000 only on Mira's turns". Includes the export deltas and the export notice (§3), the "Moved from Description" pair in the Notes tab, the inspector piece "Not sent: only on Mira's turns" on other turns (DESIGN §7.4 [D]), and a test that an unadapted card's requests are byte-identical.
2. **Card-swap rotation** (the `cardswap` job, in progress). With card-swap chosen, a reply by Tobin sends Tobin's card at the preset's definition positions and no other character's; the persona is still there. The next reply by Mira sends Mira's card there instead.
3. **The cache estimate names a speaker-dependent start** (with 1 or 2). Before a reply whose start differs from the last speaker's, the warning by the composer says which speaker and how many tokens are written again if that speaker's copy has expired (§4.1).
4. **Per-character agents** (Phase 7, optional; after AGENTIC's mode work). Each character's agent gets its view (§5.1), gap lines (§5.2), per-view summaries (§5.3) and filtered tools. Example: Wren's agent, back at message 55, sees 1–40, the gap line and 55 onwards, and its summaries cover only those.
5. **Later**: Suggest a split (§2.2); state refresh on the summary pass (§2.3); mapping ST swap-mode groups on import (§4); one-message audiences (§5.1).

### 7.2 Decisions for the owner

1. **Who marks a character gone, for what they know** (Open, §5.4). When Wren walks out at message 41 without saying so, something has to record that Wren is away, so Wren's agent later doesn't see 41–54. Either the presence decision point (after each reply, a small model reads the last two messages and marks Wren away), or Wren's own agent choosing to leave as an action (a tool call that sets Wren away), or both. "Away" itself is settled as a mark separate from Mute (§5.1).
2. **Gap lines** (§5.2, proposed). A line only where the character was present before and after a stretch of its own storyline; nothing said for a merged-in storyline it was never in, nor before it arrived; the wording is preset text with `{{absentCount}}` and `{{absentNames}}`, plus an optional join line at a merge point, empty by default. Confirm or change the rule and the default wording.
