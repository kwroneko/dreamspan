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

## 2. Splitting a card into shared and own-turn parts

**Words.** *Shared*: sent on every turn, in the cached prefix. *Own-turn*: sent only when that character is the speaker. In the UI it is "only on <name>'s turns", because "private" already means "not exported" for notes (ARCHITECTURE §8).

| Card part | Imported ST card | Suggested by "Split this card" | Notes |
|---|---|---|---|
| Name, nickname | shared | shared | Always |
| Description | shared | shared; inner passages moved out (below) | Usually mixes looks and inner life |
| Personality | shared | own-turn | The main source of "mixing" |
| Scenario | shared | shared | The world; own-turn if written from the character's view |
| Example messages | shared | own-turn | One voice bleeding into another. Own-turn examples move into the own-turn block: kept in place, they would change the prefix per speaker |
| System prompt, post-history | own-turn already | unchanged | They replace Main/post-history as in ST |
| Card notes | as each note's settings say | — | A note on "its card's turn" at the start of the tail is already own-turn. Nothing new |
| Embedded lorebook entries | as today | — | The speaker filter exists (ARCHITECTURE §15 "speaker filters"). Above the history it costs the cache, as today |
| Creator notes, tags, metadata | not sent | — | |

- **How a card marks it.** A per-field switch, stored in the card (`own_turn_fields: string[]`, exported in `extensions.rp_harness`, which ST ignores). It is the user's content, so unlike `agent_editable_fields` it travels with imports and exports. For part of a field: **Move to an own-turn note** on a selection. One card save removes the passage from the field and adds a card note with it (condition: on its card's turn; place: start of the tail). This is the existing note mechanism, so the passage can be stashed, switched per chat and given conditions.
- **Defaults.** Imported ST cards and new cards: everything shared. Requests stay byte-identical to today until the user splits a card (compatibility contract, DESIGN §1 [D]). **Split this card…** in the card editor offers the "suggested" column as ticks to confirm.
- **Inferred split** (later, opt-in): "Suggest a split" sends the card to a model only when the user presses it (provider-send consent). It proposes passages, shown as a diff to accept.
- **Per chat**: a switch in This chat, "Own-turn parts: only on their turns / on every turn" (branch-owned state key `cards.own_turn`). "On every turn" puts them back with the shared parts (today's behaviour), for chats where the user wants the omniscient mix.
- **ST groups** default to sending only the speaker's card ("Swap character cards", `group_generation_mode` in ST's public `group-chats.js`; not re-checked in this job). That is the same intent paid for with whole-prompt rewrites. The importer doesn't map it today. When it does, **[P]** a swap-mode group imports with `cards.own_turn` on, and its cards stay unsplit until the user splits them.

## 3. Where the own-turn block goes, and what it costs

The preset owns the layout (DESIGN §5.0 [D]). So the block is a new prompt-order marker, **Speaker's own definitions**, beside "Chat history" and "Newest message". Imported and existing presets get it right after the history, at the start of the tail. Its wrapper is a preset utility prompt (§4). For a speaker without own-turn parts it sends nothing.

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
- **Card-swap as built** rewrites summaries and history whenever the speaker's prefix has expired (5 minutes on Anthropic, more than 10× the cost of a new reply). With rotating speakers and long swipe sessions, that's common. **Recommendation:** rebuild `card-swap` as "every field own-turn" on top of A. The shared prefix then never varies by speaker.
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
| **Framing.** The wrapper (utility prompt `own_definitions_prompt`) says it's background: "[Background on {{char}}, as the story began. Where the story since then shows {{char}} differently, the story wins.]" | Cheap and visible. Helps more with strong models | None | **On** |
| **Current state over the card's text.** A field's text in a chat can be replaced by a note (built, DESIGN §4.2). For an own-turn field the note is already at the tail, so `edit_card` revises that one note in place instead of making the split pair that shared fields need ("Mira's current personality"). The user edits it as any replacement | The block says who the character is now | A revision is a tail edit, free for the cache | On; agents need the field editable (§4.1a [D]) |
| **Depth N** (option C), a setting on the marker | Messages after it can override it causally | ~400 tokens written per reply per message of depth | Off; offered as "N messages deep" |
| **Start, not end, of the tail** | The preset's rules and the newest message come after it | None | **On** (A) |
| Automatic state refresh: the summary pass also proposes updated current-state notes | Keeps state current without an agent | Output tokens on the summary request, which already has consent | **Later**, opt-in |

## 5. How it fits each reply mode

| Mode | Definitions | History seen | Notes |
|---|---|---|---|
| `plain` | shared + the speaker's own-turn block | the whole history (merged view) | Works now, alone, with no agents ([D] candidate) |
| `narrator` (one agent, all cards) | shared + speaker's block. A switch, "The narrator sees every character's own-turn parts", adds every block to the tail, bringing back the mixing and a larger tail | merged view (coordinator's point) | The narrator stays omniscient about events, which avoids the blind-narrator failure |
| `card-swap` | rebuilt: every field own-turn, at the tail | merged view | Fixes the prefix rewrite on speaker change (§3) |
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
- **Card editor, Definition tab** (side panel and full editor, full parity): beside each prompt field's label, a two-state control **Shared | Only on Mira's turns** ("Shared: sent on every turn. Only on Mira's turns: other characters' turns never see it."). The field's token count says which part it counts toward. **Move to an own-turn note** appears in the field's strip when text is selected, without moving other buttons ("Moves the selected text into a note sent only on Mira's turns."). **Split this card…** sits in the tab's actions. The four-row header stays as decided; the Definition tab shows "~1,000 shared · ~2,000 own-turn".
- **Preset editor**: the **Speaker's own definitions** marker row, its wrapper text, and "N messages deep", with the cache line showing it below "reused by every reply".
- **Cast tab**: per character, a small eye mark when it has own-turn parts; a **Narrator** switch (per-character mode); **Set scene…** ("Only these characters see what's said from here").
- **This chat**: "Own-turn parts" (only on their turns / every turn); in narrator mode, "The narrator sees every character's own-turn parts"; "Write each turn from the speaker's knowledge" (plain).
- **Chat view**: a scope marker row where a scene scope starts or ends ("Only Mira and Tobin from here", with faces); on scoped messages a small eye-slash icon whose hover names who knows them; a **Keep secret** / **Tell…** pair on the marker's menu; in scoped views the gap line shows in the inspector, not the timeline.
- **Inspector**: the block is its own piece, "Mira's own definitions (sent only on Mira's turns)". On other turns, "Not sent: only on Mira's turns", as condition-skipped prompts already show (DESIGN §7.4 [D]).
- **Cache estimate**: the next-reply warning names the block when it changed the tail size ("~2,000 tokens written with each new reply, reused by its swipes").

## 8. Schema impact

No table changes for the definitions. Scopes need state keys and one existing column.
- Card document: `own_turn_fields?: string[]` (exported in `extensions.rp_harness`; absent means all shared).
- Preset document: the order marker `ownDefinitions` (with an optional `depth`) and `utility_prompts.own_definitions_prompt`. Imports add the marker after the history.
- State keys (`@rp/shared/state.ts`): `cards.own_turn` (branch-owned), `narrator.sees_own_turn` (branch-owned), `scope.set`, `scope.message` (version-attached), `scope.tell`, `scope.secret`. The assembler folds them along the path, as it already folds every event on the path (`StateEventsAt`), so knowers need no per-version column.
- `summaries.audience_json` (in the baseline, unused) is written only for "Keep secret" stretches. The schema forecast flags it for a projection once views filter on it. Proposed: keep the JSON, since layer reads are bounded (≤ 300) and filtered in memory; add a projection only if a query ever filters summaries by audience.
- Snapshot only: the exact-position repeat digest keyed by view (`cacheHistory[viewKey]`), for diverged views on exact-only routes.
- **BASELINE unchanged** by this study. Phase A changes no SQL schema.

## 9. Phased plan

| Unit | What | Depends on |
|---|---|---|
| A1 | `own_turn_fields`, the order marker and wrapper, assembly (speaker's block at the marker; examples and notes of own-turn fields with it), inspector pieces, cache labels; requests byte-identical for unsplit cards (test) | — |
| A2 | Card editor: the per-field control, Move to an own-turn note, Split this card…, counts; e2e at 1440/390, light/dark, layout audit | A1 |
| A3 | `card-swap` rebuilt on A1 (every field own-turn); the `cards.own_turn` chat switch | A1 |
| B1 | `edit_card` on own-turn fields as one in-place tail revision; framing default; the depth option | A1, AGENTIC U9 (built) |
| C1 | Scope state keys, timeline markers, Set scene / Tell / Keep secret, merged-view labels, merged sections' knowers | — |
| C2 | Labelled convergence (summary transform); "Keep secret" summaries with audience into the knowers' tail; chunks cut at scope boundaries | C1, LCM |
| D1 | Per-character mode (AGENTIC §6): scoped views with gap lines, per-view repeat digests, tools filtered by scope, Narrator cards | A1, C1, C2 |
| Later | Suggest a split (opt-in send); automatic state refresh on the summary pass; ST group swap-mode import mapping | — |

Order: A1–A3 first. They're useful alone in plain chats. B1 and C1 can run in parallel, then C2, then D1.

## 10. Decisions for the owner

1. **Default place of the own-turn block.** Recommended: start of the tail, cached with the reply (A). With 20–50 swipes, uncached (B) costs about 50% more per turn; "N messages deep" stays an option.
2. **How a card marks own-turn parts.** Recommended: a per-field switch plus "Move to an own-turn note" for passages; everything shared by default, including imported ST cards; the "Split this card…" suggestion as listed in §2.
3. **Rebuild card-swap as "every field own-turn"**, so the shared prefix never changes with the speaker. Recommended: yes.
4. **Narrator mode's definitions.** Recommended: shared plus the speaker's block only, with a per-chat switch to show every block.
5. **Per-character agents see others' shared parts** (a refinement of §7.1's "only its own card"). Recommended: yes, as the 2026-11-06 point implies.
6. **Default knowers.** Recommended: everyone in the cast, unless a scene scope or message scope says otherwise, never derived from Mute.
7. **Convergence.** Recommended: at the summary layer with "who was there" labels by default; "Keep secret" per scope; "Tell…" as the explicit merge; no automatic convergence on rejoin.
8. **Plain mode and scopes.** Recommended: merged view with labels by default; "Write each turn from the speaker's knowledge" as an option.
9. **Gap lines in scoped views** ("[Wren wasn't present for 14 messages here]"). Recommended: yes, always.
10. **UI word.** Recommended: "Only on <name>'s turns" / "own-turn", not "private", which already means "not exported".
