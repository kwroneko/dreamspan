# Character context: shared and own-turn definitions, knowledge scopes

**Status**: Proposed, 2026-11-06 (job `chardefs`, design study, no code). Everything here is **[P]** unless it cites a **[D]**. It is a delta from master `df2cdffa` (ARCHITECTURE §15 "Card definitions", "Cache breakpoints", §16 "Agent rollouts"; spec/AGENTIC.md; spec/CHAT-MERGE.md) and from reference-harness `latest` (`9b385944`). Costs are calculations on synthetic sizes with the prices in pi-ai 1.0.3's bundled catalog (the app's own price source), not provider measurements. No chat logs or card definitions were read.

## 1. The problem (owner, 2026-11-06, relayed by the coordinator)

- **[D]** The main value of an agent per character is that each agent has its own definitions and only its own. Today every card's definitions are always in the context, for caching. So every agent knows everything about every character (no information asymmetry), and, worse, the descriptions mix and influence each other.
- **[D]** Chats don't work like real life: some context must be shared. Physical descriptions are needed even when writing other characters' turns, so some definitions sit in shared definitions.
- **[D]** A candidate: don't swap card definitions; move the "internal" ones into card notes at the end of the context that apply only for the current speaker. It works in ordinary single-model chats too, whatever merging or branching does. Its costs: (1) at the end, causally, they can override character changes that happened in the conversation, as the model reads it; (2) caching is reduced, and they would be constant cache writes.
- **[D]** Expiry of the whole chat's cache only becomes a problem when timelines diverge.
- **[D]** Knowledge scopes (decided earlier as a mechanism): each message has the set of characters who know it. Divergence and merges create stretches that only some know. Perma-merging stays (no carrying two timelines forever). Options include never converging, or converging at the summary layer. Blindness cuts both ways. It enables storylines that are otherwise impossible. It breaks a narrator-style model that lacks the information, and a character rejoining without context can make the model invent what's missing. This style also needs each agent to write only its own part, which conflicts with storytelling that isn't turn-based. It may be a tradeoff.
- **[D]** Already settled elsewhere: card definitions sit at the top of the context, and swapping them per turn busts the cache (§3.5, §5.2). Modes that move definitions into the tail and swap them per speaker are "later, not now; the layout must allow it" (§5.0). Cards are written as a premise for the start of the prompt (§4.1a).

**What is built today.** In `plain` and `narrator` modes, every cast card's definitions are in the prefix. `card-swap` (`cardsAtTail`, `assembler/stages.ts:1484`) takes the speaker's card out of the definitions and sends it before the end of the request. That makes the prefix depend on the speaker, so each change of speaker reads a different cached prefix, or rewrites everything after the definitions when that speaker's prefix has expired (§3, last rows). A card's system prompt and post-history instructions already apply only on that card's turn (they replace Main and post-history, as in ST). With overrides allowed, a group's Main therefore changes with the speaker. The built-in preset forbids this.

**reference-harness** isolates agents fully. Each agent has its own workspace prompt (`src/workspace/prompt.ts:57–110`), its own timeline with siblings' messages as `user` rows (`spec/MULTI-AGENT-SUPPORT.md:143–148`, `:322–328`), its own summaries (optional `summaries_from` mirroring, `:659–706`) and so its own cache prefix. There is no shared prompt part and no per-message audience. The per-agent tail goes after breakpoint (c) (`cache-breakpoints.ts:29–31`). The delta proposed here: **one shared prefix for all characters, and per-speaker text only after the history breakpoint.** reference-harness's model costs a full prefix per agent. RP groups also need the shared physical descriptions, which reference-harness has no place for.

## 2. How a card gets its shared and own-turn parts

**Words.** *Shared*: sent on every turn, in the cached prefix. *Own-turn*: sent only when that character is the speaker. In the UI it is "only on <name>'s turns", because "private" already means "not exported" for notes (ARCHITECTURE §8).

**[D]** (owner, 2026-11-06) "Card fields have nothing to do with this. You can't split this unless you do something like edit the card with an LLM. Usually 'description' contains everything. We could invent a concept of a card having a public and a private part of its def, but it would be non-standard. This requires the user to adapt the card either way." So the fields aren't the split. Every option below needs the user to adapt the card. Until they do, a card is entirely shared and requests are byte-identical to today (compatibility contract, DESIGN §1 [D]).

**(a) Own-turn card notes** (the owner's original idea). The user writes card notes, or moves passages into them, with the existing settings: condition "on its card's turn", place "start of the tail". The block in §3 is simply the speaker's own-turn notes, so it needs no new marker and no hidden wrapper ("no hidden note kinds", DESIGN §4.1 [D]): the framing of §4 is text in the note, prefilled by the action below and editable.
- **Move to an own-turn note**, on a selection in Description (or any card prompt field), in one card save: a new own-turn note holding the passage, plus a card note replacing Description with the text minus that passage. This is the note-replacement mechanism, already built for chat notes. DESIGN §4.2 [D] says every kind of note can replace prompts, including card notes; [P] this needs a card note that targets its own card's field. The Description itself stays untouched, so an update of the card or a re-import still merges into it, and the replacement note shows the conflict as any replaced field does (the As replaced / Original tabs).
- Round trip: an ST export keeps the full Description, so ST users get the whole card. Exportable notes already travel in `extensions.rp_harness.notes`. **Delta:** export has to keep the self-referring condition ("its card's turn": no library id is needed) and the self-replacement target, which export drops today ("conditions stay behind"). It also has to skip own-turn notes when picking the note that becomes ST's `depth_prompt`, or ST would send the passage twice.
- Cost to the user: one selection and one click per passage. Notes are already where stashing, per-chat switches, conditions, agent edits and history live.

**(b) A public/private split as a card extension.** For example, `extensions.rp_harness.definition_parts: { public, private, of: <hash of the description it was made from> }`. Assembly sends `public` in the prefix and `private` on the card's turn. Non-standard, and it duplicates what notes do. Round trip: an ST export writes `description = public + "\n\n" + private`, so ST still sees everything, and the parts go in the extension. On import, if the description's hash still matches `of`, the split is used. If the card was edited in ST since, the split is stale: the card imports as fully shared, with an import warning and an offer to redo the split. A second, invisible place for definition text would need its own editor, counts, history and merge rules, which notes already have.

**(c) An LLM-assisted split** (a helper over (a) or (b), not a mechanism). **Suggest a split…** in the card editor sends the card's prompt fields, only when pressed, to a model the user picks in that dialog (provider-send consent: nothing is sent otherwise, nothing runs in the background). It asks which passages are inner life (personality, secrets, voice) and which others need (looks, public role). The result is shown as a diff of the actions (a) would take, each passage with a tick. The user reviews and accepts, which makes the same card save as (a). The request is a rollout with its ledger row, so it shows in Activity with its cost.

**Recommendation: (a), with (c) as a later helper.** (a) uses card notes, which users already know, round-trips with a small export delta, and has no second home for definition text. (b) only adds a non-standard format. (c) makes (a) quick for long cards.

What goes where, as guidance for the user and for (c)'s instruction: looks, public role and relationships everyone knows stay in the Description. Inner life, secrets and voice go to own-turn notes. Example messages carry the voice. In a group, kept in place, they mix voices; moved into an own-turn note, they're only the speaker's. A card's system prompt and post-history instructions already apply only on its turn. Lorebook entries can already be limited to a speaker (ARCHITECTURE §15 "speaker filters").

- **Per chat**: a switch in This chat, "Own-turn notes: only on their turns / on every turn" (branch-owned state key `cards.own_turn`). "On every turn" sends them with everyone's definitions, today's omniscient mix.
- **ST groups** default to sending only the speaker's card ("Swap character cards", `group_generation_mode` in ST's public `group-chats.js`; not re-checked in this job). The importer doesn't map it today. **[P]** When it does, a swap-mode group's chats use the rebuilt `card-swap` (§3).

## 3. Where the own-turn block goes, and what it costs

With (a), the block is the speaker's own-turn notes at their own place. Default: "start of the tail", a note position that already exists relative to the preset's sections (DESIGN §4.1 [D]), so the preset keeps the layout (§5.0 [D]) and no marker is added. A speaker without own-turn notes sends nothing. The costs below are the same for (b).

**Sizes** (owner data shape, synthetic): preset prefix 5,000 tokens; cards 3,000 each (1,000 shared, 2,000 own-turn); summary layer 16,000; recent messages 16,000 (about 40 messages of 400); per reply, the newest message (400) and the preset's tail (1,000); 20 swipes per turn (owner: 20–50). That gives contexts of 44k, 50k and 56k tokens today for 2, 4 and 6 characters. Each cell below is **¢ per new reply / per swipe / per turn (1 reply + 20 swipes)**, for 4 characters. Prices ($ per million tokens input / cache read / cache write): Sonnet 5.5 2 / 0.20 / 2.50; Opus 5.5 4 / 0.20 / 5; Bedrock `us.` Sonnet 5.5 2.20 / 0.22 / 2.75 (`global.` is the direct price); GPT-5.6 Terra 2 / 0.20 / 2.50 (the catalog lists a write price); GPT-5.5 5 / 0.50 / none (writes at the input price). Direct OpenAI caching is automatic, with no markers.

| Placement | Sonnet 5.5 | Opus 5.5 | Bedrock Sonnet 5.5 | GPT-5.6 Terra | GPT-5.5 |
|---|---|---|---|---|---|
| Today: every card whole in the prefix | 1.33 / 1.01 / 21.5 | 1.68 / 1.01 / 21.8 | 1.46 / 1.11 / 23.6 | 1.33 / 1.01 / 21.5 | 3.15 / 2.52 / 53.5 |
| **A. Start of the tail, cached with the reply** | 1.67 / 0.89 / **19.4** | 2.52 / 0.89 / 20.3 | 1.84 / 0.98 / 21.4 | 1.67 / 0.89 / 19.4 | 3.75 / 2.22 / 48.1 |
| B. Start of the tail, never cached | 1.52 / 1.43 / 30.1 | 2.22 / 2.03 / 42.8 | 1.67 / 1.57 / 33.1 | n/a (automatic) | n/a |
| C. Four messages deep | 2.04 / 0.89 / 19.8 | 3.29 / 0.89 / 21.0 | 2.24 / 0.98 / 21.8 | 2.04 / 0.89 / 19.8 | 4.47 / 2.22 / 48.9 |
| Card-swap as built, speaker's prefix still cached | 2.30 / 1.01 / 22.5 | 3.70 / 1.01 / 23.9 | 2.53 / 1.11 / 24.7 | 2.30 / 1.01 / 22.5 | 5.04 / 2.52 / 55.4 |
| Card-swap as built, speaker's prefix expired | 12.6 / 1.01 / 32.8 | 25.2 / 1.01 / 45.4 | 13.9 / 1.11 / 36.0 | 12.6 / 1.01 / 32.8 | 25.2 / 2.52 / 75.6 |

Group size, Sonnet 5.5, per turn: 2 characters, today 19.0¢ and A 18.6¢; 6 characters, today 24.0¢ and A 20.3¢. Per new reply A costs more (2: 1.21¢ → 1.63¢; 6: 1.45¢ → 1.71¢). Every swipe costs less, because the prefix no longer carries the others' own-turn parts.

What the table says:
- **The "constant cache writes" are real but small.** A writes the 2,000-token block with every new reply (+0.34¢ on Sonnet 5.5 with 4 characters). The tail and newest message are already written today by the final checkpoint (pi-ai marks the last message; ARCHITECTURE §15 "(d)"). Swipes of the same reply read the block back at 0.1×. With the owner's swipe counts, A is **cheaper than today** at every group size and on every provider.
- **Leaving the block uncached (B) is a loss**, contrary to the coordinator's idea. Dropping the final checkpoint makes every swipe pay the tail at full price. B wins only with fewer than one swipe per three replies (break-even about 0.3 swipes a reply on Sonnet 5.5). On OpenAI and local models there's nothing to drop: caching is automatic or by prefix.
- **No per-agent caches.** Everything before the block is the same for every speaker: one prefix, one summary layer, one history checkpoint. Only the tail differs by speaker, and it is rewritten each reply anyway. This holds for plain, narrator and per-character modes, as long as the history is the same (§6).
- **C (deeper)** adds the four newest messages (~1,600 tokens) to what each new reply writes. Chats that already have a note at depth 4 or more pay nothing extra: the history checkpoint already sits above the deepest in-chat note.
- **Card-swap as built** rewrites summaries and history whenever the speaker's prefix has expired (5 minutes on Anthropic, more than 10× the cost of a new reply). With rotating speakers and long swipe sessions, that's common. **Recommendation:** rebuild `card-swap` to send *every* card's definitions only on that card's turn, at the tail, and none in the prefix. The prefix then never varies by speaker. It costs the same as A with the whole card as the block, and needs no adaptation of the cards.
- **Bedrock without lookback** (owner: Bedrock has no lookback): A and C don't touch the history checkpoint, and the built exact-position repeat (`historyStart.state.cacheHistory`) covers it as today. Bedrock differs only for diverged views (§6).
- **Anthropic 1-hour TTL** (writes at 2× input per Anthropic's documentation, not in the catalog, not checked here): it matters only for diverged views, where an agent's own cache must outlive other characters' turns.

**Local models** (llama.cpp, LM Studio, MLX reuse the longest common prefix with the previous prompt; no money, only time). Tokens re-read per new reply when the speaker changes, and seconds at an assumed 500 and 2,000 tokens/s of prompt processing:

| | Today | A | C | Card-swap as built |
|---|---|---|---|---|
| Re-read tokens | 1,400 | 3,400 | 5,000 | 42,400 |
| at 500 / 2,000 tok/s | 3 s / 0.7 s | 7 s / 1.7 s | 10 s / 2.5 s | 85 s / 21 s |

Swipes re-read nothing in all four. A server slot holds one prompt, so per-agent prefixes on a local model would need one slot per agent, with memory growing with the number of agents. A needs one.

## 4. Recency: the block's late place can override what the story changed

The risk: the card says Mira distrusts Tobin; 300 messages later she trusts him. The block, read last, pulls her back. Mitigations, combinable:

| Mitigation | Effect | Cost | Default |
|---|---|---|---|
| **Framing**, as text in the note that Move to an own-turn note prefills: "[Background on {{char}}, as the story began. Where the story since then shows {{char}} differently, the story wins.]" | Cheap and visible. Helps more with strong models | None | **On** (prefilled, editable) |
| **Current state over the card's text.** An own-turn note is already at the tail, so a change in the story is a revision of that note in this chat: by the user, or by `edit_note` when the note is agent-editable (§4.1a [D]). Revisions are chat state, so a swipe undoes them | The block says who the character is now | A tail edit, free for the cache | On |
| **Depth N** (option C), the note's existing depth placement | Messages after it can override it causally | ~400 tokens written per reply per message of depth | Off; any note can be set to "depth N" |
| **Start, not end, of the tail** | The preset's rules and the newest message come after it | None | **On** (A) |
| Automatic state refresh: the summary pass also proposes updated current-state notes | Keeps state current without an agent | Output tokens on the summary request, which already has consent | **Later**, opt-in |

## 5. How it fits each reply mode

| Mode | Definitions | History seen | Notes |
|---|---|---|---|
| `plain` | shared + the speaker's own-turn block | the whole history (merged view) | Works now, alone, with no agents ([D] candidate) |
| `narrator` (one agent, all cards) | shared + speaker's block. A switch, "The narrator sees every character's own-turn parts", adds every block to the tail, bringing back the mixing and a larger tail | merged view (coordinator's point) | The narrator stays omniscient about events, which avoids the blind-narrator failure |
| `card-swap` | rebuilt: every card whole on its own turn, at the tail; nothing in the prefix | merged view | Fixes the prefix rewrite on speaker change (§3); works on unadapted cards |
| `per-character` (Phase 7) | the same as `plain` for definitions. **Refines** §7.1 [D] "only its own card": its own card's own-turn parts, plus everyone's shared parts, per the 2026-11-06 [D] | its knowledge scope (§6) | Tools follow the scope: `search_chat`, `read_messages`, `expand_summary` and `list_notes` never return what the agent doesn't know, nor other characters' own-turn notes |

Non-turn-based scenes are the tradeoff the owner named. Per-character mode writes only one character's part per message (§7.2 [D]: one message per turn). For scene-wide prose, pick narrator. **[P]** A card can be marked **Narrator** in the cast: in per-character mode its turns use the merged view and see every block. Characters then act blind and the narrator ties the scene together.

## 6. Knowledge scopes and convergence

**Who knows a message.** Default: everyone in the cast at that message. That is today's behaviour, and it isn't derived from Mute, which in plain RP means only "doesn't talk" (DESIGN §3.5 [D]). Asymmetry comes from explicit state, all of it state events, so it follows the messages and a swipe takes back what a reply set:
- **Scene scope** `scope.set { knowers | everyone }`, positional: "From here, only Mira and Tobin are in this scene." Set by the user from the timeline or the cast, by `set_presence`-like tool calls, or by the `presence` decision point (opt-in).
- **One message** `scope.message { knowers }`, attached to its version: a whisper, a letter.
- **Merged sections**: a merged chat's section is known to the source's cast (CHAT-MERGE §4, already specified for per-character agents).
- **Telling** `scope.tell { who, stretch }` at a position: from there on, `who` knows that stretch (an explicit perma-merge).

**Views.** Merged view (plain, narrator, Narrator cards): everything, with scoped stretches labelled in the history ("[Only Mira and Tobin were here]"). Scoped view (per-character mode, and plain as an option "Write each turn from the speaker's knowledge"): unknown messages are left out, and each gap is replaced by one line, "[Wren wasn't present for 14 messages here]". The model then knows something happened instead of inventing continuity. That is the rejoin mitigation.

**Cost of diverged views.** A scoped view matches the shared prefix up to the first message the agent doesn't know. After that, the agent has its own cached history. Sonnet 5.5, 4 characters, a gap in the recent window: 1.95¢ per new reply when the agent's own cache is still warm (it spoke within the TTL; Anthropic's 20-block lookback finds its previous checkpoint). It's 5.35¢ when that cache has expired and the whole recent window is written again, against 1.67¢ for A. Bedrock: 2.14¢ / 5.88¢. Bedrock also needs the exact-position repeat digest kept per view, not per path. This is the owner's "a problem when timelines diverge": it is bounded by how long a divergence stays in the recent window.

**Convergence options:**

| Option | What later turns see | Cache | Story effect |
|---|---|---|---|
| **1. At the summary layer, labelled** | Once the stretch is summarized, one shared summary for everyone, with "who was there" per section (a registered summary transform, like `merge-sections`) | One shared layer; divergence lives only in the recent window | Soft asymmetry: the facts reach the model, flagged as unknown to some. Can leak |
| 2. Never ("Keep secret") | The stretch's summaries carry `summaries.audience_json` and go only to the knowers, in their tail after the own-turn block ("What only you know", labelled by range). Summary chunks are cut at scope boundaries (DESIGN §7.1 [P]) | Shared prefix intact; the knowers' tail grows by those summaries, written per reply | Hard asymmetry for good. The rejoin line keeps the others from inventing it |
| 3. Telling | From the point chosen, the stretch is in that character's view | Their view converges there | User or agent controls it |
| 4. On rejoin (automatic Tell when an absent character speaks again) | As 3 | As 3 | Unrealistic: rejoining isn't learning. Not proposed |

**Recommendation:** 1 by default, 2 as a per-scope switch ("Keep this secret from the others"), and 3 as an action, which is the perma-merge the owner keeps. A secret's summaries never enter the shared layer. That keeps the "no two timelines forever" rule: only small labelled summaries are carried.

## 7. What the user sees and controls

Every control has its hover explanation, and nothing is reachable only by key (owner rules).
- **Card editor, Definition tab** (side panel and full editor, full parity): **Move to an own-turn note** appears in a prompt field's strip when text is selected, without moving other buttons ("Moves the selected text into a note sent only on Mira's turns; the field keeps its text, replaced by a note without it"). The field then shows its As replaced / Original tabs, as replaced fields already do. **Suggest a split…** ((c), later) sits in the tab's actions and opens the model picker and the reviewed diff. The four-row header stays as decided; the Definition tab shows "~1,000 every turn · ~2,000 only on Mira's turns".
- **Card's Notes tab**: own-turn notes are ordinary notes. Their header line already says "Start of tail · on Mira's turns".
- **Cast tab**: per character, a small eye mark when it has own-turn parts; a **Narrator** switch (per-character mode); **Set scene…** ("Only these characters see what's said from here").
- **This chat**: "Own-turn parts" (only on their turns / every turn); in narrator mode, "The narrator sees every character's own-turn parts"; "Write each turn from the speaker's knowledge" (plain).
- **Chat view**: a scope marker row where a scene scope starts or ends ("Only Mira and Tobin from here", with faces); on scoped messages a small eye-slash icon whose hover names who knows them; a **Keep secret** / **Tell…** pair on the marker's menu; in scoped views the gap line shows in the inspector, not the timeline.
- **Inspector**: the block is its own piece, "Mira's own definitions (sent only on Mira's turns)". On other turns, "Not sent: only on Mira's turns", as condition-skipped prompts already show (DESIGN §7.4 [D]).
- **Cache estimate**: the next-reply warning names the block when it changed the tail size ("~2,000 tokens written with each new reply, reused by its swipes").

## 8. Schema impact

No table changes for the definitions. Scopes need state keys and one existing column.
- (a) needs no new document field. A card note may target its own card's field (§2), and export keeps the "its card's turn" condition and that target in `extensions.rp_harness.notes`. (b), if chosen, would add `extensions.rp_harness.definition_parts`.
- State keys (`@rp/shared/state.ts`): `cards.own_turn` (branch-owned), `narrator.sees_own_turn` (branch-owned), `scope.set`, `scope.message` (version-attached), `scope.tell`, `scope.secret`. The assembler folds them along the path, as it already folds every event on the path (`StateEventsAt`), so knowers need no per-version column.
- `summaries.audience_json` (in the baseline, unused) is written only for "Keep secret" stretches. The schema forecast flags it for a projection once views filter on it. Proposed: keep the JSON, since layer reads are bounded (≤ 300) and filtered in memory; add a projection only if a query ever filters summaries by audience.
- Snapshot only: the exact-position repeat digest keyed by view (`cacheHistory[viewKey]`), for diverged views on exact-only routes.
- **BASELINE unchanged** by this study. Phase A changes no SQL schema.

## 9. Phased plan

| Unit | What | Depends on |
|---|---|---|
| A1 | Card notes replacing their own card's field; Move to an own-turn note (one card save, framing prefilled); the export delta (condition and target kept, own-turn notes never become `depth_prompt`); inspector pieces, counts; requests byte-identical for unadapted cards (test); e2e at 1440/390, light/dark, layout audit | noteoverrides (built) |
| A2 | `card-swap` rebuilt (every card on its own turn, none in the prefix); the `cards.own_turn` chat switch | — |
| B1 | Own-turn notes agent-editable by default when made by the move action [P]; the story-wins framing in agent instructions | A1, AGENTIC U5 (built) |
| C1 | Scope state keys, timeline markers, Set scene / Tell / Keep secret, merged-view labels, merged sections' knowers | — |
| C2 | Labelled convergence (summary transform); "Keep secret" summaries with audience into the knowers' tail; chunks cut at scope boundaries | C1, LCM |
| D1 | Per-character mode (AGENTIC §6): scoped views with gap lines, per-view repeat digests, tools filtered by scope, Narrator cards | A1, C1, C2 |
| Later | (c) Suggest a split (sent only on press, to the model picked); automatic state refresh on the summary pass; ST group swap-mode import mapping | A1 |

Order: A1 and A2 first. They're useful alone in plain chats. B1 and C1 can run in parallel, then C2, then D1.

## 10. Decisions for the owner

1. **Default place of the own-turn block.** Recommended: start of the tail, cached with the reply (A). With 20–50 swipes, uncached (B) costs about 50% more per turn; "N messages deep" stays an option.
2. **How a card gets its own-turn parts** (the user adapts the card in every option). Recommended: (a) own-turn card notes, with "Move to an own-turn note" cutting a passage from the Description through a replacement note, so the card's own text stays whole and exports to ST unchanged. (c), the LLM-assisted split, comes later as a helper proposing (a), sent only on press to the model the user picks. Not (b): a non-standard public/private extension that goes stale when the card is edited in ST.
3. **Rebuild card-swap** to send every card only on its own turn, none in the prefix, so the prefix never changes with the speaker. Recommended: yes.
4. **Narrator mode's definitions.** Recommended: shared plus the speaker's block only, with a per-chat switch to show every block.
5. **Per-character agents see others' shared parts** (a refinement of §7.1's "only its own card"). Recommended: yes, as the 2026-11-06 point implies.
6. **Default knowers.** Recommended: everyone in the cast, unless a scene scope or message scope says otherwise, never derived from Mute.
7. **Convergence.** Recommended: at the summary layer with "who was there" labels by default; "Keep secret" per scope; "Tell…" as the explicit merge; no automatic convergence on rejoin.
8. **Plain mode and scopes.** Recommended: merged view with labels by default; "Write each turn from the speaker's knowledge" as an option.
9. **Gap lines in scoped views** ("[Wren wasn't present for 14 messages here]"). Recommended: yes, always.
10. **UI word.** Recommended: "Only on <name>'s turns" / "own-turn", not "private", which already means "not exported".
